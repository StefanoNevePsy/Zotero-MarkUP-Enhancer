/* eslint-disable no-undef */
// Applies highlighter palettes to the reader -- sync-safe.
//
// IMPORTANT REALITY: Zotero's PDF reader draws highlights onto a <canvas> from
// each annotation's `color` value (see zotero/reader pdf-view.js ->
// drawAnnotationsOnCanvas). There is therefore NO DOM/CSS element to restyle for
// PDF highlights. The only way to change the displayed colour is to change the
// `color` in the annotation DATA that is handed to the reader.
//
// Strategy:
//   * FORWARD (display): wrap Zotero.Annotations.toJSON so the colour the reader
//     receives is the palette colour (standard -> displayed). This is what the
//     canvas draws, so highlights appear in the chosen palette.
//   * REVERSE (storage): the reader echoes the colour it holds back when an
//     annotation is edited (drag/resize/comment), which could persist a palette
//     colour. A guarded Notifier "safety net" maps any palette colour that
//     reaches the database back to its standard colour. It can ONLY ever turn a
//     known palette colour into its corresponding standard colour, and never
//     touches a colour that is already standard -- so the stored data, and
//     therefore sync, always stays "standard".
//
// Rounded corners: only achievable for DOM-based views (EPUB/snapshots), applied
// via injected CSS. PDF highlights are sharp canvas rectangles and cannot be
// rounded without patching the reader's internal drawing.

ZoteroMarkupEnhancer.ReaderStyler = {
  _origToJSON: null,
  _notifierID: null,
  _busy: false,
  _prefSymbols: [],
  _cssHandler: null,
  _cssEventTypes: ["renderToolbar", "renderSidebarAnnotationHeader"],

  init() {
    this._wrapToJSON();

    // Safety net: keep the database colour standard.
    this._notifierID = Zotero.Notifier.registerObserver(
      this, ["item"], "zmue-color-net", 80
    );

    // Re-render open readers when the palette changes.
    const U = ZoteroMarkupEnhancer.Utils;
    for (const name of ["palette", "customPalette"]) {
      try {
        const sym = Zotero.Prefs.registerObserver(
          "extensions.zotero." + U.key(name),
          () => this.refreshReaders(),
          false
        );
        this._prefSymbols.push(sym);
      } catch (e) { /* ignore */ }
    }

    // Rounded corners for DOM-based reader views (EPUB / snapshots).
    this._installRoundingCss();
  },

  shutdown() {
    this._unwrapToJSON();
    if (this._notifierID) {
      try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* ignore */ }
      this._notifierID = null;
    }
    for (const sym of this._prefSymbols) {
      try { Zotero.Prefs.unregisterObserver(sym); } catch (e) { /* ignore */ }
    }
    this._prefSymbols = [];
    if (this._cssHandler) {
      for (const t of this._cssEventTypes) {
        try { Zotero.Reader.unregisterEventListener(t, this._cssHandler); } catch (e) { /* ignore */ }
      }
      this._cssHandler = null;
    }
  },

  _active() {
    return ZoteroMarkupEnhancer.Utils.get("palette") !== "default";
  },

  // ---- forward map: standard -> displayed (what the reader/canvas draws) ----

  _mapColor(json) {
    try {
      if (!this._active() || !json || !json.color) return json;
      const map = ZoteroMarkupEnhancer.Palettes.activeMap();
      const hex = ZoteroMarkupEnhancer.Utils.toHex6(json.color);
      if (hex && map[hex] && map[hex] !== hex) {
        json.color = map[hex];
      }
    } catch (e) { /* never break serialisation */ }
    return json;
  },

  _wrapToJSON() {
    if (!Zotero.Annotations || typeof Zotero.Annotations.toJSON !== "function") {
      ZoteroMarkupEnhancer.log("Annotations.toJSON not found; palette display unavailable");
      return;
    }
    if (Zotero.Annotations.__zmueWrapped) return;
    const self = this;
    const orig = Zotero.Annotations.toJSON;
    this._origToJSON = orig;

    const wrapped = function (...args) {
      const out = orig.apply(this, args);
      if (out && typeof out.then === "function") {
        return out.then((json) => self._mapColor(json));
      }
      return self._mapColor(out);
    };
    wrapped.__zmueOrig = orig;
    Zotero.Annotations.toJSON = wrapped;
    Zotero.Annotations.__zmueWrapped = true;
  },

  _unwrapToJSON() {
    if (this._origToJSON) {
      Zotero.Annotations.toJSON = this._origToJSON;
      delete Zotero.Annotations.__zmueWrapped;
      this._origToJSON = null;
    }
  },

  // ---- reverse safety net: ensure the DB only ever stores standard colours ----

  notify(event, type, ids) {
    if (this._busy) return;
    if (type !== "item" || (event !== "modify" && event !== "add")) return;
    if (!this._active()) return;
    this._coerce(ids.slice()).catch((e) =>
      ZoteroMarkupEnhancer.log("color net: " + e)
    );
  },

  // Build displayed -> standard, dropping any ambiguous (colliding) entries.
  _inverseMap() {
    const map = ZoteroMarkupEnhancer.Palettes.activeMap();
    const inv = {};
    for (const std of Object.keys(map)) {
      const disp = map[std];
      if (disp in inv && inv[disp] !== std) inv[disp] = null; // ambiguous
      else inv[disp] = std;
    }
    return inv;
  },

  async _coerce(ids) {
    const U = ZoteroMarkupEnhancer.Utils;
    const inv = this._inverseMap();
    const standard = ZoteroMarkupEnhancer.Palettes.standardSet();

    this._busy = true;
    try {
      for (const id of ids) {
        let item;
        try { item = Zotero.Items.get(id); } catch (e) { continue; }
        if (!item || !item.isAnnotation || !item.isAnnotation()) continue;

        const hex = U.toHex6(item.annotationColor);
        if (!hex || standard.has(hex)) continue;   // already standard: never touch

        const std = inv[hex];
        if (std && std !== hex) {
          item.annotationColor = std;
          await item.saveTx();
        }
      }
    } finally {
      this._busy = false;
    }
  },

  // Force open readers to re-pull annotation data (colours) after a palette change.
  refreshReaders() {
    try {
      for (const reader of Zotero.Reader._readers || []) {
        if (reader && typeof reader.reload === "function") reader.reload();
      }
    } catch (e) {
      // If reload is unavailable, the new palette applies next time the reader opens.
    }
  },

  // ---- rounded corners for DOM-based reader views (EPUB / snapshots) ----

  _installRoundingCss() {
    const self = this;
    this._cssHandler = (event) => {
      try {
        if (event && event.doc) self._injectRoundingCss(event.doc);
      } catch (e) { /* ignore */ }
    };
    for (const t of this._cssEventTypes) {
      try {
        Zotero.Reader.registerEventListener(t, this._cssHandler, ZoteroMarkupEnhancer.id);
      } catch (e) { /* ignore */ }
    }
  },

  _injectRoundingCss(doc) {
    const U = ZoteroMarkupEnhancer.Utils;
    if (!U.get("roundedCorners")) return;
    const radius = (Number(U.get("cornerRadius")) || 4) + "px";

    const apply = (d) => {
      if (!d || !d.documentElement || d.getElementById("zmue-round-style")) return;
      const css =
        ".highlight,.annotation-highlight,[data-annotation-type=\"highlight\"]" +
        "{border-radius:" + radius + " !important;}";
      const style = d.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "zmue-round-style";
      style.textContent = css;
      (d.head || d.documentElement).appendChild(style);
    };

    apply(doc);
    // EPUB/snapshot content lives in nested iframes.
    try {
      for (const frame of doc.querySelectorAll("iframe")) {
        const cd = frame.contentDocument;
        if (cd) apply(cd);
        frame.addEventListener("load", () => { try { apply(frame.contentDocument); } catch (e) {} });
      }
    } catch (e) { /* ignore */ }
  }
};
