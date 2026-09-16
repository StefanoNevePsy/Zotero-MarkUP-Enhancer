/* eslint-disable no-undef */
// Similarity between documents, used for the relationship graph.
//
// Two scoring modes:
//   * Semantic  - cosine distance between embedding vectors (Gemini). Captures
//                 "these are about the same thing" even with no shared tags.
//   * Lexical   - overlap of tags / creators / collections (Jaccard). Always
//                 available, and the only mode when the provider has no
//                 embeddings API (Apple on-device).
// When embeddings exist the two are blended, so shared tags still reinforce a
// link and the graph degrades gracefully instead of going empty.
//
// Vectors are cached on disk keyed by item key + a hash of the profile text, so
// re-opening the graph costs nothing and only changed items are re-embedded.

ZoteroSemantic.Similarity = {
  _cache: null,
  _cachePath: null,

  async _path() {
    if (!this._cachePath) {
      const dir = Zotero.DataDirectory.dir;
      this._cachePath = PathUtils.join(dir, "zotero-semantic-embeddings.json");
    }
    return this._cachePath;
  },

  async loadCache() {
    if (this._cache) return this._cache;
    try {
      const text = await IOUtils.readUTF8(await this._path());
      this._cache = JSON.parse(text) || {};
    } catch (e) {
      this._cache = {};
    }
    return this._cache;
  },

  async saveCache() {
    if (!this._cache) return;
    try {
      await IOUtils.writeUTF8(await this._path(), JSON.stringify(this._cache));
    } catch (e) {
      ZoteroSemantic.log("embedding cache save: " + e);
    }
  },

  // Returns a vector for the item, using the cache when the profile is unchanged.
  async vectorFor(item, onProgress) {
    const U = ZoteroSemantic.Utils;
    const cache = await this.loadCache();
    const profile = await ZoteroSemantic.Extractor.buildShortProfile(item);
    const sig = U.hashString(profile);
    const entry = cache[item.key];
    if (entry && entry.sig === sig && Array.isArray(entry.v)) return entry.v;

    if (onProgress) onProgress(item);
    const v = await ZoteroSemantic.Providers.embed(profile);
    if (Array.isArray(v)) {
      cache[item.key] = { sig, v };
      return v;
    }
    return null;
  },

  // Tags / creators / collections overlap.
  lexicalFeatures(item) {
    const tags = new Set((item.getTags() || []).map((t) => t.tag.toLowerCase()));
    const creators = new Set(
      (item.getCreators() || []).map((c) => (c.lastName || c.name || "").toLowerCase()).filter(Boolean)
    );
    let cols = new Set();
    try { cols = new Set(item.getCollections() || []); } catch (e) { /* ignore */ }
    return { tags, creators, cols };
  },

  lexicalScore(a, b) {
    const U = ZoteroSemantic.Utils;
    const t = U.jaccard(a.tags, b.tags);
    const c = U.jaccard(a.creators, b.creators);
    const l = U.jaccard(a.cols, b.cols);
    return Math.min(1, 0.65 * t + 0.2 * c + 0.15 * l);
  },

  // Embedding cosines cluster high (0.6-0.95 for almost anything), which would
  // make every pair look related. Rescale so only genuinely close pairs score high.
  rescale(cos) {
    const lo = 0.55, hi = 0.92;
    if (cos <= lo) return 0;
    if (cos >= hi) return 1;
    return (cos - lo) / (hi - lo);
  },

  // Builds { nodes, edges } for a set of items.
  async buildGraph(items, onProgress) {
    const U = ZoteroSemantic.Utils;
    const minWeight = (Number(U.get("graphMinWeightPct")) || 12) / 100;
    const useEmb = U.get("embeddings") && ZoteroSemantic.Providers.supportsEmbeddings();

    const nodes = [];
    const feats = [];
    const vectors = [];

    for (const item of items) {
      nodes.push({
        key: item.key,
        id: item.id,
        title: U.clean(item.getField("title") || "(senza titolo)", 120),
        year: ((item.getField("date") || "").match(/\d{4}/) || [""])[0],
        author: ((item.getCreators() || [])[0] || {}).lastName || "",
        tags: (item.getTags() || []).map((t) => t.tag).slice(0, 12)
      });
      feats.push(this.lexicalFeatures(item));
      vectors.push(null);
    }

    if (useEmb) {
      for (let i = 0; i < items.length; i++) {
        try {
          vectors[i] = await this.vectorFor(items[i], onProgress);
        } catch (e) {
          ZoteroSemantic.log("embedding failed for " + items[i].key + ": " + e);
          vectors[i] = null;
        }
      }
      await this.saveCache();
    }

    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const lex = this.lexicalScore(feats[i], feats[j]);
        let weight = lex;
        if (vectors[i] && vectors[j]) {
          const sem = this.rescale(U.cosine(vectors[i], vectors[j]));
          weight = 0.75 * sem + 0.25 * lex;
        }
        if (weight >= minWeight) {
          edges.push({ s: i, t: j, w: Math.round(weight * 1000) / 1000 });
        }
      }
    }

    // Keep isolated nodes visible but note the scoring mode for the UI.
    return { nodes, edges, mode: useEmb ? "semantic" : "lexical" };
  }
};
