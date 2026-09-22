/* eslint-disable no-undef */
// Namespace, lifecycle, preferences and the item context-menu entries.

var ZoteroSemantic = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  _logs: [],
  _menuIDs: ["zsem-menu-tag", "zsem-menu-graph", "zsem-menu-test", "zsem-menu-key"],
  _menuRegID: null,      // set when the native MenuManager is used
  _usingMenuManager: false,

  Utils: null,
  Providers: null,
  Extractor: null,
  Similarity: null,
  Tagger: null,
  Graph: null,
  Search: null,
  Store: null,
  Concepts: null,

  FTL: "zotero-semantic.ftl",

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    this.Utils.ensureDefaultPrefs();
    try {
      for (const c of this.Utils.migratePrefs()) this.log("modello ritirato sostituito: " + c);
    } catch (e) {
      this.log("migratePrefs: " + e);
    }

    // Not silent: if this fails the plugin still works but every diagnostic
    // that looks for Zotero.Semantic would wrongly report it as not loaded.
    try {
      Zotero.Semantic = this;
    } catch (e) {
      const msg = "could not expose Zotero.Semantic: " + e;
      this.log(msg);
      try { Zotero.SemanticBootError = msg; } catch (ignored) { /* ignore */ }
    }

    this._safe("Prefs", () => this._registerPrefs());
    // The localisation file has to be in the window BEFORE anything labelled
    // through it is created: the concept section's header is such a label.
    this._safe("FTL", () => this._insertFTLAll());
    this._safe("Menus", () => this._registerMenus());
    this._safe("Concepts", () => this.Concepts.init());
    this.initialized = true;
  },

  // Zotero registers the plugin's .ftl files automatically, but a window only
  // resolves them once they are inserted into it. This was never done, which
  // is the likely reason plugin labels used to render blank in the main window.
  _insertFTL(window) {
    try {
      if (window.MozXULElement && typeof window.MozXULElement.insertFTLIfNeeded === "function") {
        window.MozXULElement.insertFTLIfNeeded(this.FTL);
      }
    } catch (e) {
      this.log("insertFTL: " + e);
    }
  },

  _removeFTL(window) {
    try {
      const link = window.document.querySelector('[href="' + this.FTL + '"]');
      if (link) link.remove();
    } catch (e) { /* ignore */ }
  },

  _insertFTLAll() {
    for (const win of Zotero.getMainWindows()) this._insertFTL(win);
  },

  // Selected documents, or -- when nothing is selected -- the open collection,
  // after asking, since analysing a whole collection costs API calls.
  async _conceptTargets(window) {
    const pane = window.ZoteroPane;
    let items = (pane.getSelectedItems() || []).filter((i) => i.isRegularItem());
    if (items.length) return items;
    try {
      const row = pane.getCollectionTreeRow();
      if (row && row.isCollection()) {
        items = row.ref.getChildItems().filter((i) => i.isRegularItem());
      }
    } catch (e) { /* ignore */ }
    if (!items.length) {
      Zotero.alert(window, "Zotero Semantic",
        "Seleziona uno o più documenti, oppure apri una collezione.");
      return [];
    }
    const ok = Services.prompt.confirm(window, "Zotero Semantic",
      "Nessun documento selezionato. Analizzare tutti i " + items.length +
      " documenti della collezione aperta?\n\nOgni documento richiede una chiamata " +
      "al modello linguistico e due al servizio di embedding.");
    return ok ? items : [];
  },

  uiAnalyzeConcepts() {
    const win = Zotero.getMainWindow();
    this._conceptTargets(win)
      .then((items) => (items.length ? this.Concepts.runOnItems(win, items) : null))
      .catch((e) => this.log("concepts: " + (e && e.stack ? e.stack : e)));
  },

  uiRankByConcept() {
    const win = Zotero.getMainWindow();
    this.Concepts.rankByConcept(win, null)
      .catch((e) => this.log("rank: " + (e && e.stack ? e.stack : e)));
  },

  // ---- commands, callable without any window argument -------------------
  // The preferences pane buttons call these, and they also work from
  // Tools > Developer > Run JavaScript as Zotero.Semantic.uiVerify() etc.

  uiSetKey() { this.promptForKey(Zotero.getMainWindow()); },

  uiVerify() { this.verifyProvider(Zotero.getMainWindow()); },

  uiTagSelected() {
    const win = Zotero.getMainWindow();
    this.Tagger.runOnSelection(win, null)
      .catch((e) => this.log("tagger: " + (e && e.stack ? e.stack : e)));
  },

  uiGraph() {
    const win = Zotero.getMainWindow();
    this.Graph.open(win, null)
      .catch((e) => this.log("graph: " + (e && e.stack ? e.stack : e)));
  },

  uiSearch() {
    const win = Zotero.getMainWindow();
    this.Search.run(win, null)
      .catch((e) => this.log("search: " + (e && e.stack ? e.stack : e)));
  },

  shutdown() {
    try { this.Concepts.shutdown(); } catch (e) { /* ignore */ }
    if (this._menuRegID) {
      try { Zotero.MenuManager.unregisterMenu(this._menuRegID); } catch (e) { /* ignore */ }
      this._menuRegID = null;
    }
    this.initialized = false;
    try { delete Zotero.Semantic; } catch (e) { /* ignore */ }
  },

  // The context menu is OFF by default and opt-in via the enableContextMenu
  // preference.
  //
  // Zotero.MenuManager supports no plain label: a menu entry can only be titled
  // with an l10nID (verified in menuManager.js, which just sets
  // menuElem.dataset.l10nId and has no fallback). When that id does not resolve
  // the entry renders blank, and a menu carrying an unresolved id can take down
  // Zotero's whole context menu -- which is exactly what happened here, harming
  // normal use of the app. Until the localisation side is proven to work, the
  // commands live in the preferences pane instead, where plain text labels are
  // possible and nothing can break the rest of Zotero.
  _registerMenus() {
    if (!ZoteroSemantic.Utils.get("enableContextMenu")) {
      this.log("context menu disabled by preference (enableContextMenu)");
      return;
    }
    const MM = Zotero.MenuManager;
    if (!MM || typeof MM.registerMenu !== "function") {
      this.log("MenuManager unavailable; falling back to DOM menu injection");
      return;
    }

    const run = (fn) => (event, context) => {
      const win = Zotero.getMainWindow();
      const items = (context && context.items) || null;
      try { fn(win, items); }
      catch (e) { this.log("menu command: " + (e && e.stack ? e.stack : e)); }
    };

    const id = MM.registerMenu({
      menuID: "zotero-semantic",
      pluginID: this.id,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          l10nID: "zsem-menu-root",
          menus: [
            {
              menuType: "menuitem",
              l10nID: "zsem-menu-tag",
              onCommand: run((win, items) => {
                this.Tagger.runOnSelection(win, items).catch((e) =>
                  this.log("tagger: " + (e && e.stack ? e.stack : e)));
              })
            },
            {
              menuType: "menuitem",
              l10nID: "zsem-menu-graph",
              onCommand: run((win, items) => {
                this.Graph.open(win, items).catch((e) =>
                  this.log("graph: " + (e && e.stack ? e.stack : e)));
              })
            },
            {
              menuType: "menuitem",
              l10nID: "zsem-menu-test",
              onCommand: run((win) => this.verifyProvider(win))
            },
            {
              menuType: "menuitem",
              l10nID: "zsem-menu-key",
              onCommand: run((win) => this.promptForKey(win))
            }
          ]
        }
      ]
    });

    this._menuRegID = id;
    this._usingMenuManager = true;
    this.log("menus registered via MenuManager (id=" + id + ")");
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
    this._insertFTL(window);
    if (this._usingMenuManager) return; // native menus already registered
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
    this._removeFTL(window);
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
      this.Providers.lastNotice = null;
      const tags = await this.Providers.selfTest();

      // The graph, the topic search and the concepts all depend on embeddings,
      // which may use a different engine and key: check them in the same click.
      let embedLine;
      const eName = this.Providers.embedProviderName();
      if (!this.Providers.supportsEmbeddings()) {
        embedLine = "Embedding (" + eName + "): nessuna API key impostata. Rete, ricerca " +
          "per argomento e concetti non funzioneranno.";
      } else {
        try {
          const v = await this.Providers.embed("terapia sistemica familiare", "query");
          embedLine = Array.isArray(v)
            ? "Embedding (" + eName + "): funzionanti, vettori da " + v.length + " dimensioni."
            : "Embedding (" + eName + "): nessun vettore restituito.";
        } catch (e) {
          embedLine = "Embedding (" + eName + "): NON funzionanti.\n" + (e.message || e);
        }
      }
      const notice = this.Providers.lastNotice ? "\n\nAttenzione: " + this.Providers.lastNotice : "";

      progress.close();
      if (tags && tags.length) {
        Zotero.alert(window, "Zotero Semantic",
          "Tag (" + name + "): funzionanti.\nTag di prova: " + tags.join(", ") +
          "\n\n" + embedLine + notice);
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
