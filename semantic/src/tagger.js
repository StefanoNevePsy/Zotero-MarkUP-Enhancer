/* eslint-disable no-undef */
// AI tagging flow: build a profile per item, ask the provider for tags, then let
// the user review before anything is written. Nothing is applied silently -- an
// AI that quietly rewrites a carefully-built tag vocabulary would be worse than
// no AI at all.

ZoteroSemantic.Tagger = {
  async runOnSelection(window) {
    const U = ZoteroSemantic.Utils;
    const pane = window.ZoteroPane;
    const items = (pane.getSelectedItems() || []).filter(
      (i) => i.isRegularItem && i.isRegularItem()
    );

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
  _review(window, results) {
    const HTML = "http://www.w3.org/1999/xhtml";
    const dlg = window.openDialog(
      "chrome://zotero/content/standalone/basicViewer.xhtml",
      "zsem-review",
      "chrome,dialog=no,resizable,centerscreen,width=620,height=640"
    );

    // basicViewer may not be available on every build; fall back to a plain
    // confirm listing the proposals.
    if (!dlg) {
      this._fallbackConfirm(window, results);
      return;
    }

    dlg.addEventListener("load", () => {
      try {
        const doc = dlg.document;
        doc.title = "Zotero Semantic - tag proposti";
        const body = doc.body || doc.documentElement;
        while (body.firstChild) body.removeChild(body.firstChild);

        const style = doc.createElementNS(HTML, "style");
        style.textContent = `
          body { font: 13px -apple-system, system-ui, sans-serif; margin:0; padding:12px;
                 background: Canvas; color: CanvasText; }
          h3 { margin:14px 0 4px; font-size:13px; }
          .meta { opacity:.6; font-size:11px; margin-bottom:6px; }
          label { display:inline-flex; align-items:center; gap:5px; margin:0 8px 6px 0;
                  padding:3px 8px; border:1px solid rgba(128,128,128,.4);
                  border-radius:999px; cursor:pointer; }
          .bar { position:sticky; bottom:0; background:Canvas; padding:10px 0 0;
                 border-top:1px solid rgba(128,128,128,.3); display:flex; gap:8px;
                 justify-content:flex-end; margin-top:16px; }
          button { padding:6px 14px; }
        `;
        body.appendChild(style);

        const boxes = [];
        for (const r of results) {
          const h = doc.createElementNS(HTML, "h3");
          h.textContent = r.item.getField("title") || "(senza titolo)";
          body.appendChild(h);

          const meta = doc.createElementNS(HTML, "div");
          meta.className = "meta";
          const a = ((r.item.getCreators() || [])[0] || {}).lastName || "";
          const y = ((r.item.getField("date") || "").match(/\d{4}/) || [""])[0];
          meta.textContent = [a, y].filter(Boolean).join(" · ");
          body.appendChild(meta);

          for (const tag of r.tags) {
            const label = doc.createElementNS(HTML, "label");
            const cb = doc.createElementNS(HTML, "input");
            cb.type = "checkbox";
            cb.checked = true;
            const span = doc.createElementNS(HTML, "span");
            span.textContent = tag;
            label.appendChild(cb);
            label.appendChild(span);
            body.appendChild(label);
            boxes.push({ item: r.item, tag, cb });
          }
        }

        const bar = doc.createElementNS(HTML, "div");
        bar.className = "bar";
        const cancel = doc.createElementNS(HTML, "button");
        cancel.textContent = "Annulla";
        cancel.addEventListener("click", () => dlg.close());
        const apply = doc.createElementNS(HTML, "button");
        apply.textContent = "Applica selezionati";
        apply.addEventListener("click", async () => {
          apply.disabled = true;
          const n = await this._apply(boxes);
          dlg.close();
          Zotero.alert(window, "Zotero Semantic", "Applicati " + n + " tag.");
        });
        bar.appendChild(cancel);
        bar.appendChild(apply);
        body.appendChild(bar);
      } catch (e) {
        ZoteroSemantic.log("review window: " + (e && e.stack ? e.stack : e));
      }
    }, { once: true });
  },

  async _apply(boxes) {
    const byItem = new Map();
    for (const b of boxes) {
      if (!b.cb.checked) continue;
      if (!byItem.has(b.item)) byItem.set(b.item, []);
      byItem.get(b.item).push(b.tag);
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
  },

  _fallbackConfirm(window, results) {
    const lines = results.map(
      (r) => "• " + (r.item.getField("title") || "") + ": " + r.tags.join(", ")
    );
    const ok = Zotero.Prompt ? false : window.confirm(
      "Applicare questi tag?\n\n" + lines.join("\n")
    );
    if (ok) {
      const boxes = [];
      for (const r of results) {
        for (const t of r.tags) boxes.push({ item: r.item, tag: t, cb: { checked: true } });
      }
      this._apply(boxes);
    }
  }
};
