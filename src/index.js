/* eslint-disable no-undef */
// Main namespace + lifecycle orchestration for Markup Enhancer.
//
// Design note (sync safety):
//   Zotero stores each annotation's colour as one of 8 fixed hex values and
//   syncs that value. To keep notes/annotations syncing exactly as Zotero
//   expects, this plugin NEVER rewrites the stored colour. Palettes are applied
//   purely as a visual re-tint inside the reader (see readerStyler.js), so the
//   data on disk and on the sync server stays "standard".

var ZoteroMarkupEnhancer = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,

  // In-memory log ring buffer, readable from Tools -> Developer -> Run JavaScript:
  //   Zotero.MarkupEnhancer._logs.join("\n")
  _logs: [],

  // Filled in by the sub-module scripts loaded from bootstrap.js.
  Utils: null,
  Palettes: null,
  TagColors: null,
  ReaderStyler: null,
  TagGrid: null,
  OverlapMerger: null,

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    this.Utils.ensureDefaultPrefs();
    this._safe("Prefs", () => this._registerPrefs());

    // Expose the namespace so it is reachable from Run JavaScript / other code.
    try { Zotero.MarkupEnhancer = this; } catch (e) { /* ignore */ }

    // Feature modules. Each guards its own failures so one broken feature
    // can never take the whole plugin (or Zotero) down.
    this._safe("ReaderStyler", () => this.ReaderStyler.init());
    this._safe("TagGrid", () => this.TagGrid.init());
    this._safe("OverlapMerger", () => this.OverlapMerger.init());

    this.initialized = true;
  },

  shutdown() {
    this._safe("ReaderStyler", () => this.ReaderStyler.shutdown());
    this._safe("TagGrid", () => this.TagGrid.shutdown());
    this._safe("OverlapMerger", () => this.OverlapMerger.shutdown());
    try { delete Zotero.MarkupEnhancer; } catch (e) { /* ignore */ }
    this.initialized = false;
  },

  // Per-window hooks. The reader and item-pane features register globally
  // through Zotero managers, so there is nothing window-specific to add yet,
  // but we keep the hooks so future UI (menus, toolbar buttons) has a home.
  addToWindow(_window) {},
  removeFromWindow(_window) {},

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) this.addToWindow(win);
    }
  },

  removeFromAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) this.removeFromWindow(win);
    }
  },

  _registerPrefs() {
    Zotero.PreferencePanes.register({
      pluginID: this.id,
      src: "prefs/prefs.xhtml",
      label: "Markup Enhancer",
      image: this.rootURI + "icons/icon48.svg"
    });
  },

  log(msg) {
    const line = new Date().toISOString().slice(11, 23) + " " + msg;
    try {
      this._logs.push(line);
      if (this._logs.length > 1000) this._logs.splice(0, this._logs.length - 1000);
    } catch (e) { /* ignore */ }
    Zotero.debug("[Markup Enhancer] " + msg);
  },

  _safe(label, fn) {
    try {
      fn();
    } catch (e) {
      this.log("error in " + label + ": " + (e && e.stack ? e.stack : e));
    }
  }
};
