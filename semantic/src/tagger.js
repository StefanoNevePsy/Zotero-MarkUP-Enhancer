/* eslint-disable no-undef */
// AI tagging flow: build a profile per item, ask the provider for tags, then let
// the user review before anything is written. Nothing is applied silently -- an
// AI that quietly rewrites a carefully-built tag vocabulary would be worse than
// no AI at all.

ZoteroSemantic.Tagger = {
  // `preselected` is what the native menu hands us; fall back to the pane's
  // selection when invoked from the legacy DOM menu.
  async runOnSelection(window, preselected) {
    const U = ZoteroSemantic.Utils;
    const source = preselected && preselected.length
      ? preselected
      : (window.ZoteroPane.getSelectedItems() || []);
    const items = source.filter((i) => i.isRegularItem && i.isRegularItem());

    if (!items.length) {
      Zotero.alert(window, "Zotero Semantic", "Seleziona almeno un elemento.");
      return;
    }

    const vocabulary = await this._vocabulary(items[0].libraryID);
    const results = [];
    const errors = [];

    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Zotero Semantic: analisi in corso…");
    progress.show();

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        progress.addDescription(
          (i + 1) + "/" + items.length + " " + U.clean(item.getField("title"), 60)
        );
        try {
          const profile = await ZoteroSemantic.Extractor.buildProfile(item);
          const tags = await ZoteroSemantic.Providers.suggestTags(profile, vocabulary);
          const existing = new Set((item.getTags() || []).map((t) => t.tag));
          const fresh = tags
            .map((t) => String(t).trim())
            .filter((t) => t && !existing.has(t))
            .slice(0, Number(U.get("maxTags")) || 8);
          if (fresh.length) results.push({ item, tags: fresh });
        } catch (e) {
          ZoteroSemantic.log("tagging " + item.key + ": " + (e && e.stack ? e.stack : e));
          errors.push(U.clean(item.getField("title"), 50) + ": " + (e.message || e));
        }
      }
    } finally {
      progress.close();
    }

    if (errors.length) {
      Zotero.alert(window, "Zotero Semantic",
        "Alcuni elementi non sono stati elaborati:\n\n" + errors.slice(0, 5).join("\n"));
    }
    if (!results.length) {
      if (!errors.length) {
        Zotero.alert(window, "Zotero Semantic", "Nessun nuovo tag da proporre.");
      }
      return;
    }

    this._review(window, results);
  },

  // Existing library vocabulary, so the model reuses the user's own terms
  // instead of inventing near-duplicates.
  async _vocabulary(libraryID) {
    try {
      let raw = Zotero.Tags.getAll(libraryID);
      if (raw && typeof raw.then === "function") raw = await raw;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((t) => (typeof t === "string" ? t : t.tag))
        .filter(Boolean)
        .slice(0, 400);
    } catch (e) {
      return [];
    }
  },

  // Review window: every proposed tag is a checkbox, ticked by default.
  //
  // Opened as a chrome:// document of our own. It used to be built by emptying
  // Zotero's basicViewer and appending HTML into it, but that window's root is
  // a XUL <window> with no <body>, so the flex column meant to make the list
  // scroll applied to nothing -- which is why the proposals could not be
  // scrolled when there were more than a screenful.
  _review(window, results) {
    if (!ZoteroSemantic.chromeRegistered) {
      Zotero.alert(window, "Zotero Semantic",
        "Impossibile aprire la finestra dei tag proposti: la registrazione " +
        "chrome del plugin non è riuscita all'avvio. Riavvia Zotero.");
      return;
    }

    // The window gets plain data and gives back indexes; the items themselves
    // never leave this module.
    const rows = results.map((r, index) => {
      const a = ((r.item.getCreators() || [])[0] || {}).lastName || "";
      const y = ((r.item.getField("date") || "").match(/\d{4}/) || [""])[0];
      return {
        index,
        title: r.item.getField("title") || "(senza titolo)",
        meta: [a, y].filter(Boolean).join(" · "),
        tags: r.tags
      };
    });

    window.openDialog(
      "chrome://zotero-semantic/content/review.xhtml",
      "zsem-review",
      "chrome,dialog=no,resizable,centerscreen,width=620,height=640",
      {
        results: rows,
        apply: (chosen) => this._apply(results, chosen),
        done: (n) => Zotero.alert(window, "Zotero Semantic", "Applicati " + n + " tag.")
      }
    );
  },

  async _apply(results, chosen) {
    const byItem = new Map();
    for (const c of chosen) {
      const entry = results[c.index];
      if (!entry) continue;
      if (!byItem.has(entry.item)) byItem.set(entry.item, []);
      byItem.get(entry.item).push(c.tag);
    }
    let count = 0;
    for (const [item, tags] of byItem) {
      try {
        for (const t of tags) { item.addTag(t); count++; }
        await item.saveTx();
      } catch (e) {
        ZoteroSemantic.log("apply tags " + item.key + ": " + e);
      }
    }
    return count;
  }
};
