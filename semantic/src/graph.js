/* eslint-disable no-undef */
// Collects the items to visualise, scores them, and opens the graph window.

ZoteroSemantic.Graph = {
  async open(window, preselected) {
    const U = ZoteroSemantic.Utils;
    const pane = window.ZoteroPane;

    const source = preselected && preselected.length
      ? preselected
      : (pane.getSelectedItems() || []);
    let items = source.filter((i) => i.isRegularItem && i.isRegularItem());

    // With 0 or 1 items selected, fall back to the whole current collection:
    // a graph of one node is not useful.
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
        ZoteroSemantic.log("collect items: " + e);
      }
    }

    if (!items || items.length < 2) {
      Zotero.alert(window, "Zotero Semantic",
        "Servono almeno 2 elementi: selezionali o apri una collezione.");
      return;
    }

    const max = Number(U.get("graphMaxNodes")) || 300;
    let truncated = false;
    if (items.length > max) {
      items = items.slice(0, max);
      truncated = true;
    }

    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Zotero Semantic: costruzione della rete…");
    progress.show();

    let data;
    try {
      let done = 0;
      data = await ZoteroSemantic.Similarity.buildGraph(items, () => {
        done++;
        if (done % 5 === 0) progress.addDescription("Analizzati " + done + " documenti…");
      });
    } catch (e) {
      progress.close();
      ZoteroSemantic.log("buildGraph: " + (e && e.stack ? e.stack : e));
      Zotero.alert(window, "Zotero Semantic", "Errore nella costruzione della rete:\n" + e);
      return;
    }
    progress.close();

    data.truncated = truncated;

    const args = {
      data,
      selectItem: (id) => {
        try { window.ZoteroPane.selectItem(id); window.focus(); }
        catch (e) { ZoteroSemantic.log("selectItem: " + e); }
      }
    };

    // chrome:// and not rootURI: openDialog() silently ignores the jar: URL of
    // a packed plugin, which is what produced an empty window.
    if (!ZoteroSemantic.chromeRegistered) {
      Zotero.alert(window, "Zotero Semantic",
        "Impossibile aprire la finestra della rete: la registrazione chrome " +
        "del plugin non è riuscita all'avvio.\n\nRiavvia Zotero; se il problema " +
        "resta, guarda Zotero.SemanticBootStage.");
      return;
    }

    window.openDialog(
      "chrome://zotero-semantic/content/graph.xhtml",
      "zsem-graph",
      "chrome,dialog=no,resizable,centerscreen,width=1100,height=760",
      args
    );
  }
};
