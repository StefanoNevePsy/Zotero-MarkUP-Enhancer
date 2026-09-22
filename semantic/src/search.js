/* eslint-disable no-undef */
// Rank a library by relevance to a topic you type.
//
// This is the "recall" half of a two-stage ranking design: embed the query,
// score every candidate by cosine distance against its cached vector, and order
// the result. It is cheap (vectors are cached, so repeat searches cost one
// embedding call) and it finds documents whose wording never matches the query.
//
// The precision half -- re-scoring the top candidates with an explicit
// relevance rubric -- is deliberately kept behind the `rerank` seam below, so a
// local decision engine can be plugged in without touching this file.

ZoteroSemantic.Search = {
  // Pure ranking step, kept separate from Zotero so it can be tested directly.
  rankByVector(queryVec, vectors) {
    const U = ZoteroSemantic.Utils;
    const out = [];
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i]) continue;
      out.push({ i, score: U.cosine(queryVec, vectors[i]) });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  },

  async run(window, preselected) {
    const U = ZoteroSemantic.Utils;

    if (!ZoteroSemantic.Providers.supportsEmbeddings() || !U.get("embeddings")) {
      Zotero.alert(window, "Zotero Semantic",
        "La ricerca per argomento richiede gli embedding: imposta una API key " +
        "per il motore di embedding scelto e attiva \"Usa gli embedding\".");
      return;
    }

    const box = { value: "" };
    const ok = Services.prompt.prompt(
      window, "Zotero Semantic",
      "Argomento da cercare (una frase, non parole chiave):", box, null, {}
    );
    if (!ok) return;
    const topic = (box.value || "").trim();
    if (!topic) return;

    const items = await this._candidates(window, preselected);
    if (!items.length) {
      Zotero.alert(window, "Zotero Semantic",
        "Nessun elemento da analizzare: apri una collezione o selezionane alcuni.");
      return;
    }

    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Zotero Semantic: ricerca in corso…");
    progress.show();

    let ranked;
    try {
      const queryVec = await ZoteroSemantic.Providers.embed(topic, "query");
      if (!Array.isArray(queryVec)) throw new Error("Nessun embedding per la query.");

      const vectors = [];
      let done = 0;
      for (const item of items) {
        vectors.push(await ZoteroSemantic.Similarity.vectorFor(item, () => {
          done++;
          if (done % 5 === 0) progress.addDescription("Analizzati " + done + " documenti…");
        }));
      }
      await ZoteroSemantic.Similarity.saveCache();

      ranked = this.rankByVector(queryVec, vectors);
      ranked = await this.rerank(topic, items, ranked);
    } catch (e) {
      progress.close();
      ZoteroSemantic.log("search: " + (e && e.stack ? e.stack : e));
      Zotero.alert(window, "Zotero Semantic", "Errore nella ricerca:\n" + (e.message || e));
      return;
    }
    progress.close();

    this._show(window, topic, items, ranked);
  },

  // Seam for a precision pass over the top candidates. Returns the ranking
  // unchanged until a reranker is configured.
  async rerank(topic, items, ranked) {
    return ranked;
  },

  async _candidates(window, preselected) {
    const pane = window.ZoteroPane;
    let items = (preselected && preselected.length ? preselected
      : (pane.getSelectedItems() || []))
      .filter((i) => i.isRegularItem && i.isRegularItem());

    if (items.length < 2) {
      try {
        const row = pane.getCollectionTreeRow();
        if (row && row.isCollection()) {
          items = row.ref.getChildItems().filter((i) => i.isRegularItem && i.isRegularItem());
        } else if (row && typeof row.getItems === "function") {
          const all = await row.getItems();
          items = all.filter((i) => i.isRegularItem && i.isRegularItem());
        }
      } catch (e) {
        ZoteroSemantic.log("search candidates: " + e);
      }
    }
    const max = Number(ZoteroSemantic.Utils.get("graphMaxNodes")) || 300;
    return items.slice(0, max);
  },

  // Flatten the ranking into plain rows, so the results window never has to
  // touch Zotero items.
  toRows(items, ranked) {
    return ranked.map((r) => {
      const item = items[r.i];
      const a = ((item.getCreators() || [])[0] || {}).lastName || "";
      const y = ((item.getField("date") || "").match(/\d{4}/) || [""])[0];
      const tags = (item.getTags() || []).map((x) => x.tag).slice(0, 5).join(" · ");
      return {
        id: item.id,
        score: r.score,
        title: item.getField("title") || "(senza titolo)",
        meta: [[a, y].filter(Boolean).join(" · "), tags].filter(Boolean).join("  —  ")
      };
    });
  },

  _show(window, topic, items, ranked) {
    this.openResults(window, {
      topic,
      subtitle: ranked.length + " documenti ordinati per pertinenza semantica",
      rows: this.toRows(items, ranked)
    });
  },

  // Shared by the topic search and the ranking by concept. Each row may carry
  // `bar` (0..1) when the bar should be relative to something other than the
  // percentage shown, e.g. to the library's top document for a concept.
  openResults(window, { topic, subtitle, rows }) {
    // A chrome:// URL, not rootURI: openDialog() silently ignores the jar: URL
    // of a packed plugin, and Zotero's basicViewer is a XUL <window> with no
    // <body>, so HTML injected into it cannot be laid out or scrolled.
    if (!ZoteroSemantic.chromeRegistered) {
      Zotero.alert(window, "Zotero Semantic",
        "Impossibile aprire la finestra dei risultati: la registrazione chrome " +
        "del plugin non è riuscita all'avvio. Riavvia Zotero.");
      return;
    }

    window.openDialog(
      "chrome://zotero-semantic/content/search.xhtml",
      "zsem-search",
      "chrome,dialog=no,resizable,centerscreen,width=680,height=700",
      {
        topic,
        subtitle,
        rows,
        selectItem: (id) => {
          try { window.ZoteroPane.selectItem(id); window.focus(); }
          catch (e) { ZoteroSemantic.log("selectItem: " + e); }
        },
        // The filter half of "search, filter and sort": the result set lands
        // as a selection in the main list, ready to tag, collect or export.
        selectItems: (ids) => {
          const pane = window.ZoteroPane;
          Promise.resolve()
            // inLibraryRoot: the results may span collections, so select them
            // from the library root rather than failing on the current view.
            .then(() => (typeof pane.selectItems === "function"
              ? pane.selectItems(ids, { inLibraryRoot: true })
              : pane.selectItem(ids[0], { inLibraryRoot: true })))
            .then(() => window.focus())
            .catch((e) => ZoteroSemantic.log("selectItems: " + e));
        }
      }
    );
  }
};
