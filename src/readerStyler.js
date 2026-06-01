/* eslint-disable no-undef */
// Visually re-tints reader highlights to the active palette and rounds their
// corners -- WITHOUT touching the stored annotation colour (sync-safe).
//
// How it works:
//   The PDF/EPUB reader renders each highlight rectangle with the annotation's
//   stored colour applied inline (background-color, or an SVG `fill`). We watch
//   the reader document, and whenever an element carries one of Zotero's 8
//   standard colours we swap the *displayed* value for the palette equivalent
//   and remember the original on the node (data-zmue-orig) so we can re-map it
//   instantly when the user switches palette. Nothing is written back to the
//   annotation, so the database and sync server keep the standard colour.

ZoteroMarkupEnhancer.ReaderStyler = {
  _docs: new Set(),
  _handler: null,
  _prefSymbols: [],
  _eventTypes: [
    "renderToolbar",
    "renderSidebarAnnotationHeader",
    "renderTextSelectionPopup"
  ],

  init() {
    const self = this;
    this._handler = (event) => {
      try {
        if (event && event.doc) self.attach(event.doc);
      } catch (e) {
        ZoteroMarkupEnhancer.log("reader handler: " + e);
      }
    };

    for (const type of this._eventTypes) {
      Zotero.Reader.registerEventListener(type, this._handler, ZoteroMarkupEnhancer.id);
    }

    // Re-apply when any visual preference changes.
    const U = ZoteroMarkupEnhancer.Utils;
    const watch = ["palette", "customPalette", "roundedCorners", "cornerRadius"];
    for (const name of watch) {
      try {
        const sym = Zotero.Prefs.registerObserver(
          "extensions.zotero." + U.key(name),
          () => this.reapplyAll(),
          false
        );
        this._prefSymbols.push(sym);
      } catch (e) {
        ZoteroMarkupEnhancer.log("pref observer: " + e);
      }
    }

    // Attach to any already-open readers.
    try {
      for (const reader of Zotero.Reader._readers || []) {
        const doc = reader && reader._iframeWindow && reader._iframeWindow.document;
        if (doc) this.attach(doc);
      }
    } catch (e) { /* internal API may differ between versions */ }
  },

  shutdown() {
    for (const type of this._eventTypes) {
      try {
        Zotero.Reader.unregisterEventListener(type, this._handler);
      } catch (e) { /* ignore */ }
    }
    for (const sym of this._prefSymbols) {
      try { Zotero.Prefs.unregisterObserver(sym); } catch (e) { /* ignore */ }
    }
    this._prefSymbols = [];

    for (const doc of this._docs) {
      this._detach(doc);
    }
    this._docs.clear();
  },

  attach(doc) {
    if (!doc || !doc.body || doc.__zmueAttached) return;
    doc.__zmueAttached = true;
    this._docs.add(doc);

    this._injectStyle(doc);

    // Re-tint everything already on screen, then watch for new highlights.
    this._scan(doc.body);

    const observer = new doc.defaultView.MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) this._scan(node);
        }
        if (m.type === "attributes" && m.target.nodeType === 1) {
          this._recolor(m.target);
        }
      }
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "fill"]
    });
    doc.__zmueObserver = observer;
  },

  _detach(doc) {
    try {
      if (doc.__zmueObserver) doc.__zmueObserver.disconnect();
      const style = doc.getElementById("zmue-reader-style");
      if (style) style.remove();
    } catch (e) { /* ignore */ }
    delete doc.__zmueAttached;
    delete doc.__zmueObserver;
  },

  _injectStyle(doc) {
    if (doc.getElementById("zmue-reader-style")) return;
    const U = ZoteroMarkupEnhancer.Utils;
    const radius = (Number(U.get("cornerRadius")) || 4) + "px";
    const rounded = U.get("roundedCorners");

    // Broad, defensive selectors covering known reader highlight structures.
    // Inline re-tinting (below) is what actually recolours; this mainly handles
    // the rounded-corner styling that CSS does more cleanly than JS.
    const css = `
      .highlight,
      .highlight .rect,
      [data-annotation-type="highlight"],
      .annotation-highlight,
      div[data-zmue-orig] {
        border-radius: ${rounded ? radius : "0"} !important;
      }
    `;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "zmue-reader-style";
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
  },

  // Re-tint a subtree. We only look at elements that carry an inline colour.
  _scan(root) {
    const map = ZoteroMarkupEnhancer.Palettes.activeMap();
    try {
      if (root.nodeType === 1) this._recolor(root, map);
      const els = root.querySelectorAll
        ? root.querySelectorAll("[style], [fill]")
        : [];
      for (const el of els) this._recolor(el, map);
    } catch (e) { /* defensive */ }
  },

  _recolor(el, map) {
    if (!map) map = ZoteroMarkupEnhancer.Palettes.activeMap();
    const U = ZoteroMarkupEnhancer.Utils;

    // Detect-and-remember the original standard colour the first time.
    if (!el.dataset || el.dataset.zmueOrig === undefined) {
      const candidates = [];
      if (el.style && el.style.backgroundColor) candidates.push(["bg", el.style.backgroundColor]);
      if (el.style && el.style.fill) candidates.push(["fill", el.style.fill]);
      const fillAttr = el.getAttribute && el.getAttribute("fill");
      if (fillAttr) candidates.push(["fillAttr", fillAttr]);

      let matched = false;
      for (const [kind, val] of candidates) {
        const hex = U.toHex6(val);
        if (hex && map[hex]) {
          el.dataset.zmueOrig = hex;
          el.dataset.zmueKind = kind;
          const a = U.alphaOf(val);
          if (a != null) el.dataset.zmueAlpha = String(a);
          matched = true;
          break;
        }
      }
      if (!matched) {
        if (el.dataset) el.dataset.zmueOrig = ""; // remember "not a target"
        return;
      }
    }

    const orig = el.dataset.zmueOrig;
    if (!orig) return; // marked as non-target

    const target = map[orig] || orig;
    const alpha = el.dataset.zmueAlpha ? Number(el.dataset.zmueAlpha) : null;
    const value = alpha != null ? U.hexToRgba(target, alpha) : target;

    const kind = el.dataset.zmueKind;
    if (kind === "fill") {
      el.style.fill = value;
    } else if (kind === "fillAttr") {
      el.setAttribute("fill", value);
    } else {
      el.style.backgroundColor = value;
      if (U.get("roundedCorners")) {
        el.style.borderRadius = (Number(U.get("cornerRadius")) || 4) + "px";
      }
    }
  },

  // Re-apply palette + rounding to every attached reader (called on pref change).
  reapplyAll() {
    const map = ZoteroMarkupEnhancer.Palettes.activeMap();
    for (const doc of this._docs) {
      if (!doc.defaultView) {
        this._docs.delete(doc);
        continue;
      }
      // Refresh the rounded-corner stylesheet.
      const style = doc.getElementById("zmue-reader-style");
      if (style) style.remove();
      delete doc.__zmueAttached; // allow re-inject
      doc.__zmueAttached = true;
      this._injectStyle(doc);

      // Re-map every element we previously tagged.
      try {
        const els = doc.querySelectorAll('[data-zmue-orig]:not([data-zmue-orig=""])');
        for (const el of els) this._recolor(el, map);
      } catch (e) { /* ignore */ }
    }
  }
};
