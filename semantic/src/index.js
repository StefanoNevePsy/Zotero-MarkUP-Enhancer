/* eslint-disable no-undef */
// Namespace, lifecycle, preferences and the item context-menu entries.

var ZoteroSemantic = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  _logs: [],
  _menuIDs: ["zsem-menu-tag", "zsem-menu-graph", "zsem-menu-test", "zsem-menu-key"],

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

  // PreferencePanes.register() is async, so a failure arrives as a rejected
  // promise rather than a thrown error. Log both outcomes, and retry once the
  // UI is ready in case registering during startup was simply too early.
  _registerPrefs() {
    const attempt = () => Promise.resolve(
      Zotero.PreferencePanes.register({
        pluginID: this.id,
        src: "prefs/prefs.xhtml",
        label: "Zotero Semantic",
        image: this.rootURI + "icons/icon48.svg"
      })
    );

    attempt().then(
      (paneID) => this.log("preference pane registered (id=" + paneID + ")"),
      (e) => {
        this.log("preference pane failed on first attempt: " + e);
        Promise.resolve(Zotero.uiReadyPromise)
          .then(attempt)
          .then(
            (paneID) => this.log("preference pane registered on retry (id=" + paneID + ")"),
            (e2) => this.log("preference pane FAILED: " + (e2 && e2.stack ? e2.stack : e2))
          );
      }
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

      mkItem("zsem-menu-tag", "Suggerisci tag con AI\u2026", () => {
        this.Tagger.runOnSelection(window).catch((e) =>
          this.log("tagger: " + (e && e.stack ? e.stack : e))
        );
      });
      mkItem("zsem-menu-graph", "Mostra rete di relazioni\u2026", () => {
        this.Graph.open(window).catch((e) =>
          this.log("graph: " + (e && e.stack ? e.stack : e))
        );
      });
      mkItem("zsem-menu-test", "Verifica provider AI\u2026", () => {
        this.verifyProvider(window);
      });
      mkItem("zsem-menu-key", "Imposta API key Gemini\u2026", () => {
        this.promptForKey(window);
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

  // Lets the key be set without the preferences pane, which has proven
  // unreliable to register on some Zotero builds. The plugin stays fully usable
  // from the context menu alone.
  promptForKey(window) {
    try {
      const U = this.Utils;
      const current = U.get("geminiKey") || "";
      const box = { value: current };
      const ok = Services.prompt.prompt(
        window,
        "Zotero Semantic",
        "API key Gemini (lascia vuoto per cancellarla):",
        box,
        null,
        {}
      );
      if (!ok) return;
      const key = (box.value || "").trim();
      U.set("geminiKey", key);
      U.set("provider", "gemini");
      Zotero.alert(window, "Zotero Semantic",
        key
          ? "API key salvata. Provider impostato su Gemini.\n\n" +
            "Prova ora \"Verifica provider AI\u2026\"."
          : "API key rimossa.");
    } catch (e) {
      this.log("promptForKey: " + (e && e.stack ? e.stack : e));
      Zotero.alert(window, "Zotero Semantic", "Errore: " + (e.message || e));
    }
  },

  // Runs one tiny request against the configured provider and reports exactly
  // what happened, so setup problems surface here instead of halfway through a
  // batch of documents.
  async verifyProvider(window) {
    const name = this.Providers.name();
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Zotero Semantic: verifica " + name + "\u2026");
    progress.show();
    try {
      const tags = await this.Providers.selfTest();
      progress.close();
      if (tags && tags.length) {
        Zotero.alert(window, "Zotero Semantic",
          "Provider \"" + name + "\" funzionante.\n\n" +
          "Tag di prova restituiti:\n" + tags.join(", "));
      } else {
        Zotero.alert(window, "Zotero Semantic",
          "Il provider \"" + name + "\" ha risposto, ma non ha restituito tag " +
          "utilizzabili.\n\nControlla il log:\nZotero.Semantic._logs.join(\"\\n\")");
      }
    } catch (e) {
      progress.close();
      this.log("verifyProvider: " + (e && e.stack ? e.stack : e));
      Zotero.alert(window, "Zotero Semantic",
        "Provider \"" + name + "\" non funzionante.\n\n" + (e.message || e));
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
