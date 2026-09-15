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
// Rounded corners: DOM-based views (EPUB/snapshots) get injected CSS; PDFs get a
// targeted canvas patch (see the "rounded highlights" section below).

ZoteroMarkupEnhancer.ReaderStyler = {
  _origToJSON: null,
  _notifierID: null,
  _busy: false,
  _prefSymbols: [],
  _cssHandler: null,
  _cssEventTypes: ["renderToolbar", "renderSidebarAnnotationHeader"],
  _patchedProtos: [],

  init() {
    this._wrapToJSON();

    // Safety net: keep the database colour standard.
    this._notifierID = Zotero.Notifier.registerObserver(
      this, ["item"], "zmue-color-net", 80
    );

    // Re-render open readers when the palette changes.
    const U = ZoteroMarkupEnhancer.Utils;
    const watch = ["palette", "roundedCorners", "cornerRadius"].concat(
      Object.keys(ZoteroMarkupEnhancer.Palettes.STANDARD).map((s) => "customColor." + s)
    );
    for (const name of watch) {
      try {
        const sym = Zotero.Prefs.registerObserver(
          "extensions.zotero." + U.key(name),
          () => this.refreshReaders(),
          false
        );
        this._prefSymbols.push(sym);
      } catch (e) { /* ignore */ }
    }

    // Rounded highlights: CSS for DOM views (EPUB/snapshots) + a targeted canvas
    // patch for PDFs (see _patchCanvasIn).
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
    this._unpatchCanvas();
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
    if (type !== "item" || (event !== "modify" && event !== "add")) return;
    if (!this._active()) return;

    // Recolour annotations the reader created/edited itself. Zotero's own
    // notify() skips re-pushing changes that originated in a reader instance
    // (extraData instanceID match), so a freshly-drawn highlight keeps the
    // reader's local standard colour. We push it back through the wrapped
    // toJSON so the canvas is redrawn in the palette colour.
    this._pushColors(ids.slice()).catch((e) =>
      ZoteroMarkupEnhancer.log("push colors: " + e)
    );

    // Safety net: keep the stored colour standard.
    if (!this._busy) {
      this._coerce(ids.slice()).catch((e) =>
        ZoteroMarkupEnhancer.log("color net: " + e)
      );
    }
  },

  // Push current-palette colours to any open reader showing these annotations.
  async _pushColors(ids) {
    let readers;
    try { readers = Zotero.Reader._readers || []; } catch (e) { return; }
    if (!readers.length) return;

    for (const id of ids) {
      let item;
      try { item = Zotero.Items.get(id); } catch (e) { continue; }
      if (!item || !item.isAnnotation || !item.isAnnotation()) continue;
      const parent = item.parentID;
      for (const reader of readers) {
        try {
          if (reader.itemID === parent && typeof reader.setAnnotations === "function") {
            reader.setAnnotations([item]); // async; fire-and-forget
          }
        } catch (e) { /* ignore */ }
      }
    }
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

  // Re-push every annotation to open readers after a palette change, so colours
  // update live without a disruptive full reload (keeps scroll position).
  async refreshReaders() {
    let readers;
    try { readers = Zotero.Reader._readers || []; } catch (e) { return; }
    for (const reader of readers) {
      try {
        const attachment = Zotero.Items.get(reader.itemID);
        if (!attachment || typeof attachment.getAnnotations !== "function") continue;
        let anns = attachment.getAnnotations();
        if (anns && typeof anns.then === "function") anns = await anns;
        if (anns && anns.length && typeof reader.setAnnotations === "function") {
          reader.setAnnotations(anns);
        }
      } catch (e) { /* ignore */ }
    }
  },

  // ---- rounded highlights -------------------------------------------------
  //
  // EPUB/snapshot views render highlights as DOM, so CSS border-radius works.
  // PDFs draw them on a <canvas>: the reader sets globalCompositeOperation to
  // 'multiply' and fills each line's rectangle with the annotation colour at 50%
  // alpha (colour + '80') via ctx.fillRect. We patch fillRect in the reader's
  // window and, ONLY for fills matching that exact signature (multiply blend +
  // a known annotation colour), draw a rounded rectangle instead. Every other
  // fill on the page -- text, images, page background -- is untouched, and any
  // failure falls straight back to the original fillRect.

  _installRoundingCss() {
    const self = this;
    this._cssHandler = (event) => {
      try {
        if (event && event.doc) self._applyRounding(event.doc);
      } catch (e) { /* ignore */ }
    };
    for (const t of this._cssEventTypes) {
      try {
        Zotero.Reader.registerEventListener(t, this._cssHandler, ZoteroMarkupEnhancer.id);
      } catch (e) { /* ignore */ }
    }
    // Cover readers that were already open when the plugin started.
    try {
      for (const reader of Zotero.Reader._readers || []) {
        const doc = reader && reader._iframeWindow && reader._iframeWindow.document;
        if (doc) this._applyRounding(doc);
      }
    } catch (e) { /* ignore */ }
  },

  _applyRounding(doc) {
    const apply = (d) => {
      if (!d || !d.documentElement) return;
      this._injectRoundingCss(d);
      this._patchCanvasIn(d.defaultView);
    };

    apply(doc);

    const hookFrame = (frame) => {
      try {
        if (frame.contentDocument) apply(frame.contentDocument);
      } catch (e) { /* ignore */ }
      frame.addEventListener("load", () => {
        try { apply(frame.contentDocument); } catch (e) { /* ignore */ }
      });
    };

    try {
      for (const frame of doc.querySelectorAll("iframe")) hookFrame(frame);
    } catch (e) { /* ignore */ }

    // The PDF/EPUB view iframe is often created after the toolbar renders.
    try {
      if (!doc.__zmueRoundObs && doc.defaultView) {
        const obs = new doc.defaultView.MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              if (n.tagName === "IFRAME") hookFrame(n);
              else if (n.querySelectorAll) {
                for (const f of n.querySelectorAll("iframe")) hookFrame(f);
              }
            }
          }
        });
        obs.observe(doc.documentElement, { childList: true, subtree: true });
        doc.__zmueRoundObs = obs;
      }
    } catch (e) { /* ignore */ }
  },

  _injectRoundingCss(d) {
    const U = ZoteroMarkupEnhancer.Utils;
    if (!U.get("roundedCorners")) return;
    if (d.getElementById("zmue-round-style")) return;
    const radius = (Number(U.get("cornerRadius")) || 4) + "px";
    const css =
      ".highlight,.annotation-highlight,[data-annotation-type=\"highlight\"]" +
      "{border-radius:" + radius + " !important;}";
    const style = d.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "zmue-round-style";
    style.textContent = css;
    (d.head || d.documentElement).appendChild(style);
  },

  // Colours we are willing to round: Zotero's 8 standard colours plus whatever
  // the active palette displays them as.
  _roundableColors() {
    const P = ZoteroMarkupEnhancer.Palettes;
    const set = P.standardSet();
    try {
      const map = P.activeMap();
      for (const std of Object.keys(map)) set.add(map[std]);
    } catch (e) { /* ignore */ }
    return set;
  },

  // Called for every fillRect the reader performs (thousands per page render),
  // so the cheapest, most selective test goes first: only annotation fills use
  // the 'multiply' blend mode, which rejects essentially all page drawing before
  // any preference read or colour parsing happens.
  _shouldRound(ctx, w, h) {
    if (ctx.globalCompositeOperation !== "multiply") return false;
    if (!(w > 1) || !(h > 1)) return false;
    const U = ZoteroMarkupEnhancer.Utils;
    if (!U.get("roundedCorners")) return false;
    const hex = U.toHex6(ctx.fillStyle);
    if (!hex) return false;
    return this._roundableColors().has(hex);
  },

  // The pref is expressed in px at a ~16px line height, and scaled by the actual
  // rectangle height so the rounding looks the same at any zoom level.
  _radiusFor(w, h) {
    const pref = Number(ZoteroMarkupEnhancer.Utils.get("cornerRadius"));
    const px = Number.isFinite(pref) ? pref : 4;
    return Math.max(0, Math.min(h * (px / 16), h / 2, w / 2));
  },

  _patchCanvasIn(win) {
    try {
      const proto = win && win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
      if (!proto || proto.__zmueRoundPatched) return;
      const orig = proto.fillRect;
      if (typeof orig !== "function") return;

      const self = this;
      proto.__zmueRoundPatched = true;
      proto.__zmueOrigFillRect = orig;
      proto.fillRect = function (x, y, w, h) {
        try {
          if (self._shouldRound(this, w, h)) {
            const r = self._radiusFor(w, h);
            if (r > 0.5) {
              this.beginPath();
              if (typeof this.roundRect === "function") {
                this.roundRect(x, y, w, h, r);
              } else {
                self._roundRectPath(this, x, y, w, h, r);
              }
              this.fill();
              return;
            }
          }
        } catch (e) {
          // Never let our styling break page rendering.
        }
        return orig.call(this, x, y, w, h);
      };
      this._patchedProtos.push(proto);
      ZoteroMarkupEnhancer.log("rounded-highlight canvas patch installed");
    } catch (e) {
      ZoteroMarkupEnhancer.log("canvas patch: " + e);
    }
  },

  _roundRectPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  },

  _unpatchCanvas() {
    for (const proto of this._patchedProtos) {
      try {
        if (proto.__zmueOrigFillRect) proto.fillRect = proto.__zmueOrigFillRect;
        delete proto.__zmueOrigFillRect;
        delete proto.__zmueRoundPatched;
      } catch (e) { /* ignore */ }
    }
    this._patchedProtos = [];
  }
};
