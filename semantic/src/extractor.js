/* eslint-disable no-undef */
// Builds a compact "profile" of a document for the model.
//
// The goal is to describe a 600-page book as cheaply as a 10-page article while
// still capturing what it is ABOUT. Three layers, in order of value per byte:
//
//   1. Metadata      - title, creators, year, publication, abstract, collections,
//                      existing tags. Always included, always cheap.
//   2. Your own annotations - highlight text and comments from the attachment.
//      This is the strongest signal available: it is already in the database (no
//      PDF parsing), it is spread across the whole work (so it covers a book),
//      and it reflects what YOU found worth marking -- which is exactly what
//      makes a document findable again months later.
//   3. Sampled text  - only when layers 1-2 are thin: the opening pages plus
//      evenly spaced excerpts across the document, never the full text.
//
// Everything is hard-capped, so cost and latency stay bounded regardless of size.

ZoteroSemantic.Extractor = {
  async buildProfile(item) {
    const U = ZoteroSemantic.Utils;
    const parts = [];

    // --- 1. metadata ---
    parts.push("Titolo: " + (item.getField("title") || "(senza titolo)"));

    const creators = (item.getCreators() || [])
      .map((c) => (c.lastName ? c.lastName + (c.firstName ? ", " + c.firstName : "") : c.name))
      .filter(Boolean)
      .slice(0, 8);
    if (creators.length) parts.push("Autori: " + creators.join("; "));

    const year = (item.getField("date") || "").match(/\d{4}/);
    if (year) parts.push("Anno: " + year[0]);

    const pub = item.getField("publicationTitle") || item.getField("publisher") ||
      item.getField("bookTitle") || "";
    if (pub) parts.push("Pubblicazione: " + pub);
    parts.push("Tipo: " + Zotero.ItemTypes.getName(item.itemTypeID));

    const abstract = U.clean(item.getField("abstractNote"), 2000);
    if (abstract) parts.push("Abstract: " + abstract);

    const ownTags = (item.getTags() || []).map((t) => t.tag);
    if (ownTags.length) parts.push("Tag attuali: " + ownTags.join(", "));

    try {
      const colNames = (item.getCollections() || [])
        .map((id) => { const c = Zotero.Collections.get(id); return c && c.name; })
        .filter(Boolean);
      if (colNames.length) parts.push("Collezioni: " + colNames.join(", "));
    } catch (e) { /* ignore */ }

    // --- 2. the user's own highlights and notes ---
    const annText = await this._annotationDigest(item);
    if (annText) parts.push("Passaggi evidenziati dal lettore:\n" + annText);

    // --- 3. sampled body text, only if the above is thin ---
    const thin = abstract.length < 200 && annText.length < 400;
    if (thin) {
      const sampled = await this._sampledText(item);
      if (sampled) parts.push("Estratti dal documento:\n" + sampled);
    }

    return U.clean(parts.join("\n"), Number(U.get("profileMaxChars")) || 8000);
  },

  async _bestAttachment(item) {
    try {
      if (item.isAttachment && item.isAttachment()) return item;
      if (typeof item.getBestAttachment === "function") {
        const att = await item.getBestAttachment();
        if (att) return att;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  // Highlight text + comments, spread evenly across the document so a book is
  // represented from start to finish rather than just its first chapter.
  async _annotationDigest(item) {
    const U = ZoteroSemantic.Utils;
    const cap = Number(U.get("annotationMaxChars")) || 3000;
    try {
      const att = await this._bestAttachment(item);
      if (!att || typeof att.getAnnotations !== "function") return "";

      let anns = att.getAnnotations();
      if (anns && typeof anns.then === "function") anns = await anns;
      if (!Array.isArray(anns) || !anns.length) return "";

      const pieces = [];
      for (const a of anns) {
        const t = U.clean(a.annotationText, 300);
        const c = U.clean(a.annotationComment, 200);
        const merged = [t, c && "(nota: " + c + ")"].filter(Boolean).join(" ");
        if (merged) pieces.push(merged);
      }
      if (!pieces.length) return "";

      // Roughly how many excerpts fit in the budget, spread over the whole work.
      const approx = Math.max(6, Math.floor(cap / 160));
      return U.clean(U.spread(pieces, approx).join("\n- "), cap);
    } catch (e) {
      ZoteroSemantic.log("annotation digest: " + e);
      return "";
    }
  },

  // Uses Zotero's existing full-text index (attachmentText) -- no PDF parsing --
  // and samples it instead of sending the whole thing.
  async _sampledText(item) {
    const U = ZoteroSemantic.Utils;
    try {
      const att = await this._bestAttachment(item);
      if (!att) return "";
      let text = att.attachmentText;
      if (text && typeof text.then === "function") text = await text;
      if (!text) return "";

      const head = U.clean(text.slice(0, 1500), 1500);
      const rest = text.slice(1500);
      const chunks = U.sample(rest, 6, 500).map((c) => U.clean(c, 500)).filter(Boolean);
      return U.clean([head].concat(chunks).join("\n…\n"), 4000);
    } catch (e) {
      ZoteroSemantic.log("sampled text: " + e);
      return "";
    }
  },

  // Shorter profile used for embeddings / similarity.
  async buildShortProfile(item) {
    const U = ZoteroSemantic.Utils;
    const bits = [
      item.getField("title") || "",
      (item.getTags() || []).map((t) => t.tag).join(", "),
      U.clean(item.getField("abstractNote"), 1200)
    ].filter(Boolean);
    let out = bits.join("\n");
    if (out.length < 200) {
      const ann = await this._annotationDigest(item);
      if (ann) out += "\n" + U.clean(ann, 1200);
    }
    return U.clean(out, 3000);
  }
};
