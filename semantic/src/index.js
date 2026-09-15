/* eslint-disable no-undef */
// Namespace, lifecycle, preferences and the item context-menu entries.

var ZoteroSemantic = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  _logs: [],
  _menuIDs: ["zsem-menu-tag", "zsem-menu-graph"],

  Utils: null,
  Providers: null,
  Extractor: null,
  Similarity: null,
  Tagger: null,
  Graph: null,

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    this.Utils.ensureDefaultPrefs();
    try { Zotero.Semantic = this; } catch (e) { /* ignore */ }

    this._safe("Prefs", () => this._registerPrefs());
    this.initialized = true;
  },

  shutdown() {
    this.initialized = false;
    try { delete Zotero.Semantic; } catch (e) { /* ignore */ }
  },

  _registerPrefs() {
    Promise.resolve(
      Zotero.PreferencePanes.register({
        pluginID: this.id,
        src: "prefs/prefs.xhtml",
        label: "Zotero Semantic",
        image: this.rootURI + "icons/icon48.svg"
      })
    ).then(
      (paneID) => this.log("preference pane registered (id=" + paneID + ")"),
      (e) => this.log("preference pane FAILED: " + (e && e.stack ? e.stack : e))
    );
  },

  // ---- per-window UI: entries in the item list context menu ----

  addToWindow(window) {
    try {
      const doc = window.document;
      const menu = doc.getElementById("zotero-itemmenu");
      if (!menu || doc.getElementById("zsem-menu-tag")) return;

      const mkItem = (id, label, handler) => {
        const el = doc.createXULElement
          ? doc.createXULElement("menuitem")
          : doc.createElement("menuitem");
        el.id = id;
        el.setAttribute("label", label);
        el.addEventListener("command", handler);
        menu.appendChild(el);
        return el;
      };

      mkItem("zsem-menu-tag", "Suggerisci tag con AI…", () => {
        this.Tagger.runOnSelection(window).catch((e) =>
          this.log("tagger: " + (e && e.stack ? e.stack : e))
        );
      });
      mkItem("zsem-menu-graph", "Mostra rete di relazioni…", () => {
        this.Graph.open(window).catch((e) =>
          this.log("graph: " + (e && e.stack ? e.stack : e))
        );
      });
    } catch (e) {
      this.log("addToWindow: " + e);
    }
  },

  removeFromWindow(window) {
    try {
      const doc = window.document;
      for (const id of this._menuIDs) {
        const el = doc.getElementById(id);
        if (el) el.remove();
      }
    } catch (e) { /* ignore */ }
  },

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

  log(msg) {
    const line = new Date().toISOString().slice(11, 23) + " " + msg;
    try {
      this._logs.push(line);
      if (this._logs.length > 1000) this._logs.splice(0, this._logs.length - 1000);
    } catch (e) { /* ignore */ }
    Zotero.debug("[Zotero Semantic] " + msg);
  },

  _safe(label, fn) {
    try { fn(); }
    catch (e) { this.log("error in " + label + ": " + (e && e.stack ? e.stack : e)); }
  }
};
