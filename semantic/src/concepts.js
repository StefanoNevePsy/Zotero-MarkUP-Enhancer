/* eslint-disable no-undef */
// Concept inventory per document, with how much of the document each concept
// takes up.
//
// Two steps, deliberately split between two kinds of model:
//   1. The language model NAMES the concepts (same prompt discipline as tags).
//   2. Embeddings MEASURE them: the document is cut into passages spread from
//      the first page to the last (plus the reader's highlights), and each
//      passage "votes" for the concepts it is closest to. A concept's share is
//      its average vote. A theme present throughout the work collects votes
//      from many passages; one mentioned once collects few.
// A model asked to score concepts itself gives numbers that are not comparable
// from one document to the next -- and sorting the library needs exactly that.

ZoteroSemantic.Concepts = {
  _sectionID: null,
  _columnKeys: [],
  _bodies: new Map(),     // rendered section bodies -> item, re-rendered on change
  _maxCache: new Map(),   // "libraryID|concept" -> highest share in the library

  // ---- pure (tested) -----------------------------------------------------

  // `sims` is concepts x passages. For each passage, similarities are
  // standardised across the concepts, then turned into a distribution with a
  // softmax: the passage's vote. Standardising first makes the result
  // independent of the cosine scale of the embedding model, which differs
  // from model to model. Returns one share per concept; shares sum to 1.
  prominence(sims, beta) {
    const b = beta || 2;
    const nC = sims.length;
    if (!nC) return [];
    const nP = sims[0].length;
    const shares = new Array(nC).fill(0);
    if (!nP) return shares.map(() => 1 / nC);
    for (let j = 0; j < nP; j++) {
      const col = sims.map((row) => (Number.isFinite(row[j]) ? row[j] : -1));
      const mean = col.reduce((a, v) => a + v, 0) / nC;
      const sd = Math.sqrt(col.reduce((a, v) => a + (v - mean) * (v - mean), 0) / nC);
      const z = col.map((v) => (sd > 1e-9 ? (v - mean) / sd : 0));
      const top = Math.max(...z);
      const ex = z.map((v) => Math.exp(b * (v - top)));
      const sum = ex.reduce((a, v) => a + v, 0);
      for (let i = 0; i < nC; i++) shares[i] += ex[i] / sum;
    }
    return shares.map((s) => s / nP);
  },

  // Share of `concept` in a stored entry (0..1), or 0 when absent.
  shareOf(entry, concept) {
    if (!entry || !concept) return 0;
    const want = String(concept).toLowerCase();
    const hit = (entry.c || []).find(([n]) => String(n).toLowerCase() === want);
    return hit ? hit[1] / 1000 : 0;
  },

  // ---- analysis ----------------------------------------------------------

  async analyze(item, vocabulary) {
    const U = ZoteroSemantic.Utils;
    const P = ZoteroSemantic.Providers;
    const max = Number(U.get("conceptsMax")) || 12;

    const profile = await ZoteroSemantic.Extractor.buildProfile(item);
    const names = P.normalizeConcepts(await P.suggestConcepts(profile, vocabulary), vocabulary, max);
    if (!names.length) throw new Error("il modello non ha restituito concetti");

    let passages = await ZoteroSemantic.Extractor.passages(item);
    if (!passages.length) passages = [U.clean(profile, 1600)];

    const pv = (await P.embedMany(passages, "passage")).filter(Boolean);
    if (!pv.length) throw new Error("nessun embedding per il testo del documento");
    // The concept is the query, the passages are what it retrieves: the same
    // asymmetry retrieval embedders are trained for.
    const cv = await P.embedMany(names, "query");

    const sims = names.map((_, i) => pv.map((v) => (cv[i] ? U.cosine(cv[i], v) : NaN)));
    const shares = this.prominence(sims);
    ZoteroSemantic.log("concepts " + item.key + ": " + names.length + " concetti su " +
      pv.length + " brani");
    return names.map((n, i) => [n, shares[i]]).sort((a, b) => b[1] - a[1]);
  },

  async runOnItems(window, items) {
    const P = ZoteroSemantic.Providers;
    if (!P.supportsEmbeddings()) {
      Zotero.alert(window, "Zotero Semantic",
        "L'analisi dei concetti misura il testo con gli embedding: imposta una " +
        "API key per il motore di embedding (Gemini o NVIDIA) nelle impostazioni.");
      return;
    }

    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Zotero Semantic: analisi dei concetti…");
    progress.show();

    const vocab = new Map();   // libraryID -> [names]
    const errors = [];
    let done = 0;
    try {
      for (const item of items) {
        const libID = item.libraryID;
        if (!vocab.has(libID)) {
          vocab.set(libID, (await ZoteroSemantic.Store.vocabulary(libID)).slice(0, 300).map(([n]) => n));
        }
        progress.addDescription((done + 1) + "/" + items.length + " " +
          ZoteroSemantic.Utils.clean(item.getField("title"), 60));
        try {
          const concepts = await this.analyze(item, vocab.get(libID));
          await ZoteroSemantic.Store.put(item, concepts);
          // Later documents in the same run reuse the names just introduced.
          const v = vocab.get(libID);
          for (const [n] of concepts) if (!v.includes(n)) v.push(n);
        } catch (e) {
          ZoteroSemantic.log("concepts " + item.key + ": " + (e && e.stack ? e.stack : e));
          errors.push(ZoteroSemantic.Utils.clean(item.getField("title"), 50) + ": " + (e.message || e));
        }
        done++;
        if (done % 5 === 0) await this._flushAll(vocab.keys());
      }
    } finally {
      await this._flushAll(vocab.keys());
      progress.close();
      this.refreshViews();
    }

    if (errors.length) {
      Zotero.alert(window, "Zotero Semantic",
        "Analizzati " + (done - errors.length) + " documenti su " + done + ".\n\n" +
        "Non riusciti:\n" + errors.slice(0, 6).join("\n"));
    }
  },

  async _flushAll(libraryIDs) {
    for (const id of libraryIDs) {
      try { await ZoteroSemantic.Store.flush(id); }
      catch (e) { ZoteroSemantic.log("store flush: " + (e && e.stack ? e.stack : e)); }
    }
  },

  // ---- active concept: drives the column and the graph lens --------------

  setActive(name) {
    ZoteroSemantic.Utils.set("activeConcept", name || "");
    this.refreshViews();
  },

  refreshViews() {
    this._maxCache.clear();
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    for (const [body, item] of this._bodies) {
      if (!body.isConnected) { this._bodies.delete(body); continue; }
      this.render(body, item).catch((e) => ZoteroSemantic.log("concepts render: " + e));
    }
  },

  // Highest share of a concept anywhere in the library: the column's bar is
  // relative to it, so a full bar means "the document that discusses this
  // most, among yours".
  _maxFor(libraryID, concept) {
    const k = libraryID + "|" + concept.toLowerCase();
    if (this._maxCache.has(k)) return this._maxCache.get(k);
    const lib = ZoteroSemantic.Store._libs.get(libraryID);
    if (!lib) return 0;
    let m = 0;
    for (const e of Object.values(lib.entries)) m = Math.max(m, this.shareOf(e, concept));
    this._maxCache.set(k, m);
    return m;
  },

  // ---- item list columns -------------------------------------------------

  registerColumns() {
    const M = Zotero.ItemTreeManager;
    if (!M || typeof M.registerColumn !== "function") return;
    const U = ZoteroSemantic.Utils;
    const pluginID = ZoteroSemantic.id;
    const keep = (k) => { if (k) this._columnKeys.push(k); };

    Promise.resolve(M.registerColumn({
      dataKey: "zsemRelevance",
      label: "Pertinenza",
      pluginID,
      // Highest first on the first click.
      sortReverse: true,
      // The value is a fixed-width key, so sorting is right whatever collation
      // the list applies; renderCell turns it into a bar and a percentage.
      dataProvider: (item) => {
        const active = U.get("activeConcept");
        if (!active || !item.isRegularItem || !item.isRegularItem()) return "";
        const entry = ZoteroSemantic.Store.peek(item);
        if (!entry) return "";                       // not analysed (or not loaded yet)
        return U.sortKey(this.shareOf(entry, active));
      },
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const d = doc || Zotero.getMainWindow().document;
        const cell = d.createElement("span");
        cell.className = "cell " + column.className;
        if (!data) return cell;
        const share = parseInt(data, 10) / 1000;
        const row = this._rowItem(index);
        const max = row ? this._maxFor(row.libraryID, U.get("activeConcept")) : share;
        const track = d.createElement("span");
        track.style.cssText = "display:inline-block;width:42px;height:5px;border-radius:3px;" +
          "background:rgba(128,128,128,.25);margin-right:6px;vertical-align:middle;overflow:hidden";
        const fill = d.createElement("span");
        fill.style.cssText = "display:block;height:100%;background:#5b8fd6;width:" +
          (max > 0 ? Math.round((share / max) * 100) : 0) + "%";
        track.appendChild(fill);
        cell.appendChild(track);
        cell.appendChild(d.createTextNode(Math.round(share * 100) + "%"));
        return cell;
      }
    })).then(keep, (e) => ZoteroSemantic.log("column relevance: " + e));

    Promise.resolve(M.registerColumn({
      dataKey: "zsemConcepts",
      label: "Concetti",
      pluginID,
      dataProvider: (item) => {
        if (!item.isRegularItem || !item.isRegularItem()) return "";
        const entry = ZoteroSemantic.Store.peek(item);
        return entry ? (entry.c || []).slice(0, 3).map(([n]) => n).join(" · ") : "";
      }
    })).then(keep, (e) => ZoteroSemantic.log("column concepts: " + e));
  },

  _rowItem(index) {
    try {
      const view = Zotero.getActiveZoteroPane().itemsView;
      const row = view.getRow(index);
      return row && row.ref;
    } catch (e) {
      return null;
    }
  },

  // ---- item pane section -------------------------------------------------

  registerSection() {
    const M = Zotero.ItemPaneManager;
    if (!M || typeof M.registerSection !== "function") return;
    const icon = ZoteroSemantic.rootURI + "icons/concepts.svg";
    this._sectionID = M.registerSection({
      paneID: "zsem-concepts",
      pluginID: ZoteroSemantic.id,
      header: { l10nID: "zsem-section-concepts", icon },
      sidenav: { l10nID: "zsem-section-concepts-sidenav", icon },
      onRender: ({ body, item }) => {
        this._bodies.set(body, item);
        this.render(body, item).catch((e) => ZoteroSemantic.log("concepts render: " + e));
      }
    });
  },

  async render(body, item) {
    const doc = body.ownerDocument;
    const H = "http://www.w3.org/1999/xhtml";
    const el = (tag, css, text) => {
      const e = doc.createElementNS(H, tag);
      if (css) e.style.cssText = css;
      if (text != null) e.textContent = text;
      return e;
    };
    const token = {};
    body.__zsemToken = token;
    body.textContent = "";

    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      body.appendChild(el("div", "opacity:.6;padding:4px 0", "Seleziona un documento."));
      return;
    }

    const entry = await ZoteroSemantic.Store.get(item);
    if (body.__zsemToken !== token) return;      // another item was selected meanwhile
    body.textContent = "";

    const win = doc.defaultView;
    const button = (label, fn) => {
      const b = el("button", "margin:6px 6px 0 0;padding:3px 10px", label);
      b.addEventListener("click", () => fn(b));
      return b;
    };
    const analyse = (b) => {
      b.disabled = true;
      this.runOnItems(win, [item]).catch((e) => ZoteroSemantic.log("concepts: " + e));
    };

    if (!entry) {
      body.appendChild(el("div", "opacity:.7;padding:2px 0 4px",
        "Documento non ancora analizzato."));
      body.appendChild(button("Analizza concetti", analyse));
      return;
    }

    const active = String(ZoteroSemantic.Utils.get("activeConcept") || "").toLowerCase();
    const top = Math.max(...entry.c.map(([, s]) => s), 1);
    const list = el("div", "display:flex;flex-direction:column;gap:3px;padding:2px 0");
    for (const [name, permille] of entry.c) {
      const isActive = name.toLowerCase() === active;
      const row = el("div", "display:flex;align-items:center;gap:8px;cursor:pointer;" +
        "padding:2px 4px;border-radius:4px;" + (isActive ? "background:rgba(91,143,214,.18);" : ""));
      row.title = Math.round(permille / 10) + "% del documento. Clic: usalo per la colonna " +
        "«Pertinenza» e la lente della rete.";
      row.appendChild(el("span", "flex:0 0 45%;overflow:hidden;text-overflow:ellipsis;" +
        "white-space:nowrap;" + (isActive ? "font-weight:600" : ""), name));
      const track = el("span", "flex:1 1 auto;height:6px;border-radius:3px;" +
        "background:rgba(128,128,128,.22);overflow:hidden");
      track.appendChild(el("span", "display:block;height:100%;background:" +
        (isActive ? "#e0873a" : "#5b8fd6") + ";width:" + Math.round((permille / top) * 100) + "%"));
      row.appendChild(track);
      row.appendChild(el("span", "flex:0 0 2.6em;text-align:right;" +
        "font-variant-numeric:tabular-nums;opacity:.75", Math.round(permille / 10) + "%"));
      row.addEventListener("click", () => this.setActive(isActive ? "" : name));
      list.appendChild(row);
    }
    body.appendChild(list);

    body.appendChild(el("div", "opacity:.6;font-size:11px;margin-top:6px;line-height:1.35",
      "Quota del documento dedicata a ciascun concetto, misurata sul testo. " +
      "Clic su un concetto per ordinare la biblioteca in base a quello."));
    body.appendChild(button("Rianalizza", analyse));
    if (active) {
      body.appendChild(button("Classifica per «" + ZoteroSemantic.Utils.get("activeConcept") + "»…",
        () => this.rankByConcept(win, ZoteroSemantic.Utils.get("activeConcept"))
          .catch((e) => ZoteroSemantic.log("rank: " + e))));
    }
  },

  // ---- library ranking by concept ----------------------------------------

  async rankByConcept(window, name) {
    const pane = window.ZoteroPane;
    const libID = pane.getSelectedLibraryID();
    const vocab = await ZoteroSemantic.Store.vocabulary(libID);
    if (!vocab.length) {
      Zotero.alert(window, "Zotero Semantic",
        "Nessun documento di questa biblioteca è stato ancora analizzato.\n\n" +
        "Seleziona dei documenti e usa «Analizza concetti».");
      return;
    }

    let concept = name;
    if (!concept) {
      const labels = vocab.map(([n, count]) => n + "  (" + count + ")");
      const sel = { value: 0 };
      const ok = Services.prompt.select(window, "Zotero Semantic",
        "Ordina la biblioteca per concetto:", labels, sel);
      if (!ok) return;
      concept = vocab[sel.value][0];
    }
    this.setActive(concept);

    const lib = await ZoteroSemantic.Store.load(libID);
    const items = [];
    const ranked = [];
    for (const [key, entry] of Object.entries(lib.entries)) {
      const share = this.shareOf(entry, concept);
      if (!(share > 0)) continue;
      const item = Zotero.Items.getByLibraryAndKey(libID, key);
      if (!item || item.deleted || !item.isRegularItem()) continue;
      ranked.push({ i: items.length, score: share });
      items.push(item);
    }
    ranked.sort((a, b) => b.score - a.score);
    const max = ranked.length ? ranked[0].score : 1;

    ZoteroSemantic.Search.openResults(window, {
      topic: concept,
      subtitle: ranked.length + " documenti trattano questo concetto · " +
        "percentuale = quota del documento a esso dedicata",
      rows: ZoteroSemantic.Search.toRows(items, ranked).map((r) => ({ ...r, bar: r.score / max }))
    });
  },

  // ---- lifecycle ---------------------------------------------------------

  init() {
    ZoteroSemantic.Store.init();
    try { this.registerSection(); } catch (e) { ZoteroSemantic.log("concept section: " + e); }
    try { this.registerColumns(); } catch (e) { ZoteroSemantic.log("concept columns: " + e); }
  },

  shutdown() {
    if (this._sectionID) {
      try { Zotero.ItemPaneManager.unregisterSection(this._sectionID); } catch (e) { /* ignore */ }
      this._sectionID = null;
    }
    for (const k of this._columnKeys) {
      try { Zotero.ItemTreeManager.unregisterColumn(k); } catch (e) { /* ignore */ }
    }
    this._columnKeys = [];
    this._bodies.clear();
    ZoteroSemantic.Store.shutdown();
  }
};
