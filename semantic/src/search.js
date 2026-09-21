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
        "La ricerca per argomento richiede gli embedding, disponibili con il " +
        "provider Gemini e con l'opzione \"Usa gli embedding\" attiva.");
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
      const queryVec = await ZoteroSemantic.Providers.embed(topic);
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

  _show(window, topic, items, ranked) {
    const HTML = "http://www.w3.org/1999/xhtml";
    const dlg = window.openDialog(
      "chrome://zotero/content/standalone/basicViewer.xhtml",
      "zsem-search",
      "chrome,dialog=no,resizable,centerscreen,width=680,height=700"
    );
    if (!dlg) return;

    dlg.addEventListener("load", () => {
      try {
        const doc = dlg.document;
        doc.title = "Zotero Semantic - pertinenza: " + topic;
        const body = doc.body || doc.documentElement;
        while (body.firstChild) body.removeChild(body.firstChild);

        const style = doc.createElementNS(HTML, "style");
        style.textContent = `
          html, body { height:100%; }
          body { font: 13px -apple-system, system-ui, sans-serif; margin:0;
                 background: Canvas; color: CanvasText;
                 display:flex; flex-direction:column; overflow:hidden; }
          .head { flex:0 0 auto; padding:12px 14px 8px;
                  border-bottom:1px solid rgba(128,128,128,.3); }
          .head b { font-size:14px; }
          .head .sub { opacity:.6; font-size:11px; margin-top:3px; }
          .list { flex:1 1 auto; overflow-y:auto; padding:6px 0; }
          .row { display:flex; gap:10px; align-items:flex-start;
                 padding:8px 14px; cursor:pointer; }
          .row:hover { background:rgba(128,128,128,.12); }
          .pct { flex:0 0 3.2em; text-align:right; font-variant-numeric:tabular-nums;
                 opacity:.85; padding-top:1px; }
          .bar { flex:0 0 70px; height:6px; margin-top:6px; border-radius:3px;
                 background:rgba(128,128,128,.25); overflow:hidden; }
          .bar i { display:block; height:100%; background:#5b8fd6; }
          .txt { flex:1 1 auto; min-width:0; }
          .t { line-height:1.35; }
          .m { opacity:.6; font-size:11px; margin-top:2px; }
          .foot { flex:0 0 auto; padding:8px 14px; opacity:.6; font-size:11px;
                  border-top:1px solid rgba(128,128,128,.3); }
        `;
        body.appendChild(style);

        const head = doc.createElementNS(HTML, "div");
        head.className = "head";
        const b = doc.createElementNS(HTML, "b");
        b.textContent = topic;
        head.appendChild(b);
        const sub = doc.createElementNS(HTML, "div");
        sub.className = "sub";
        sub.textContent = ranked.length + " documenti ordinati per pertinenza semantica";
        head.appendChild(sub);
        body.appendChild(head);

        const list = doc.createElementNS(HTML, "div");
        list.className = "list";
        body.appendChild(list);

        for (const r of ranked) {
          const item = items[r.i];
          const row = doc.createElementNS(HTML, "div");
          row.className = "row";
          row.addEventListener("dblclick", () => {
            try { window.ZoteroPane.selectItem(item.id); window.focus(); }
            catch (e) { /* ignore */ }
          });

          const pct = doc.createElementNS(HTML, "div");
          pct.className = "pct";
          pct.textContent = Math.round(r.score * 100) + "%";
          row.appendChild(pct);

          const bar = doc.createElementNS(HTML, "div");
          bar.className = "bar";
          const fill = doc.createElementNS(HTML, "i");
          fill.style.width = Math.max(2, Math.round(r.score * 100)) + "%";
          bar.appendChild(fill);
          row.appendChild(bar);

          const txt = doc.createElementNS(HTML, "div");
          txt.className = "txt";
          const t = doc.createElementNS(HTML, "div");
          t.className = "t";
          t.textContent = item.getField("title") || "(senza titolo)";
          txt.appendChild(t);
          const m = doc.createElementNS(HTML, "div");
          m.className = "m";
          const a = ((item.getCreators() || [])[0] || {}).lastName || "";
          const y = ((item.getField("date") || "").match(/\d{4}/) || [""])[0];
          const tags = (item.getTags() || []).map((x) => x.tag).slice(0, 5).join(" · ");
          m.textContent = [[a, y].filter(Boolean).join(" · "), tags].filter(Boolean).join("  —  ");
          txt.appendChild(m);
          row.appendChild(txt);

          list.appendChild(row);
        }

        const foot = doc.createElementNS(HTML, "div");
        foot.className = "foot";
        foot.textContent = "Doppio clic su una riga per selezionarla in Zotero.";
        body.appendChild(foot);
      } catch (e) {
        ZoteroSemantic.log("search window: " + (e && e.stack ? e.stack : e));
      }
    }, { once: true });
  }
};
