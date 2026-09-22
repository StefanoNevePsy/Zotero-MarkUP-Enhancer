/* eslint-disable no-undef */
// Concept data, stored IN the library so that Zotero sync carries it.
//
// Zotero has no custom per-item fields, and a file in the data directory never
// leaves the machine. So the data lives in standalone notes, grouped in their
// own collection. Notes ride on the regular data sync: no file-storage quota,
// no WebDAV.
//
// A single note cannot hold a whole library: Zotero refuses to sync notes that
// are too long, and in practice trouble starts well below the nominal 250,000
// characters. The data is therefore split across shards -- item key hash
// modulo the shard count -- and the count doubles whenever a shard would grow
// past LIMIT. Reading merges every data note found, newest entry per item
// winning, so a library caught mid-way through a re-split (or mid-sync) still
// reads correctly.
//
// Entry per item: { t: timestamp, c: [[concept, share in permille], ...] }

ZoteroSemantic.Store = {
  MARKER: "ZSEM-STORE-v1",
  COLLECTION: "Zotero Semantic (dati)",
  LIMIT: 60000,          // characters of note HTML per shard
  MIN_SHARDS: 2,

  _libs: new Map(),      // libraryID -> { entries, notes: Map(index -> item), shards, dirty:Set }
  _loading: new Map(),   // libraryID -> Promise
  _observerID: null,

  // ---- pure helpers (tested) ---------------------------------------------

  hashKey(key) {
    let h = 2166136261;
    const s = String(key);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },

  shardOf(key, shards) { return this.hashKey(key) % shards; },

  escapeHTML(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  unescapeHTML(s) {
    return String(s)
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, "&");
  },

  // Note HTML for one shard. The JSON sits in <pre> on a single line, which
  // survives the note editor if someone opens the note.
  encode(shard) {
    const json = JSON.stringify({ v: 1, s: shard.shards, i: shard.index, e: shard.entries });
    return "<h2>Zotero Semantic · dati dei concetti · blocco " + (shard.index + 1) +
      " di " + shard.shards + "</h2>" +
      "<p>Nota generata automaticamente da Zotero Semantic per sincronizzare " +
      "l'analisi dei concetti fra i tuoi computer. Non modificarla. " +
      "Se la elimini, i concetti dei documenti che contiene andranno rianalizzati. " +
      this.MARKER + "</p>" +
      "<pre>" + this.escapeHTML(json) + "</pre>";
  },

  // Tolerant: the editor may wrap the content, add <code> inside <pre>, or
  // turn spaces into &nbsp;. Returns null for anything that is not our data.
  decode(html) {
    const m = String(html || "").match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!m) return null;
    const text = this.unescapeHTML(m[1].replace(/<[^>]+>/g, ""));
    try {
      const d = JSON.parse(text);
      if (!d || d.v !== 1 || typeof d.e !== "object") return null;
      return { shards: Number(d.s) || 1, index: Number(d.i) || 0, entries: d.e || {} };
    } catch (e) {
      return null;
    }
  },

  // Newest entry per item wins, across however many shards were read.
  merge(shards) {
    const out = {};
    for (const sh of shards) {
      for (const [k, v] of Object.entries((sh && sh.entries) || {})) {
        if (!v) continue;
        if (!out[k] || (Number(v.t) || 0) > (Number(out[k].t) || 0)) out[k] = v;
      }
    }
    return out;
  },

  // Splits entries into `shards` groups.
  partition(entries, shards) {
    const groups = Array.from({ length: shards }, () => ({}));
    for (const [k, v] of Object.entries(entries)) groups[this.shardOf(k, shards)][k] = v;
    return groups;
  },

  // Smallest shard count >= `current` at which every shard encodes under the
  // limit. Doubling keeps the split predictable.
  planShards(entries, current, limit) {
    let s = Math.max(this.MIN_SHARDS, current || 0);
    for (let guard = 0; guard < 16; guard++) {
      const groups = this.partition(entries, s);
      const worst = Math.max(...groups.map((g, i) =>
        this.encode({ shards: s, index: i, entries: g }).length));
      if (worst <= limit) return s;
      s *= 2;
    }
    return s;
  },

  // ---- Zotero side ------------------------------------------------------

  init() {
    try {
      // Sync (or the user) may change or delete our notes: drop the cache so the
      // next read sees the new data.
      this._observerID = Zotero.Notifier.registerObserver({
        notify: (event, type, ids) => {
          if (type !== "item") return;
          for (const [libID, lib] of this._libs) {
            const ours = [...lib.notes.values()].map((n) => n.id);
            // Never drop a cache holding unsaved analysis: those entries exist
            // nowhere else yet, and the pending write will carry them.
            if (ids.some((id) => ours.includes(id)) && !lib.writing && !lib.dirty.size) {
              this._libs.delete(libID);
            }
          }
        }
      }, ["item"], "zotero-semantic-store");
    } catch (e) {
      ZoteroSemantic.log("store observer: " + e);
    }
  },

  shutdown() {
    if (this._observerID) {
      try { Zotero.Notifier.unregisterObserver(this._observerID); } catch (e) { /* ignore */ }
      this._observerID = null;
    }
    this._libs.clear();
    this._loading.clear();
  },

  // Synchronous read for the item list, which cannot wait: returns what is
  // cached, and starts loading the library (then refreshes the columns) if it
  // is not cached yet.
  peek(item) {
    const lib = this._libs.get(item.libraryID);
    if (lib) return lib.entries[item.key] || null;
    // The list asks once per visible row: start ONE load per library, with ONE
    // column refresh at the end, not one per row.
    if (!this._loading.has(item.libraryID)) {
      this.load(item.libraryID).then(() => {
        try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
      }).catch((e) => ZoteroSemantic.log("store load: " + e));
    }
    return undefined;   // "not known yet", distinct from null ("not analysed")
  },

  async get(item) {
    const lib = await this.load(item.libraryID);
    return lib.entries[item.key] || null;
  },

  async load(libraryID) {
    if (this._libs.has(libraryID)) return this._libs.get(libraryID);
    if (this._loading.has(libraryID)) return this._loading.get(libraryID);
    const p = (async () => {
      const notes = await this._findNotes(libraryID);
      const decoded = [];
      let maxShards = this.MIN_SHARDS;
      for (const n of notes) {
        const d = this.decode(n.getNote());
        if (!d) continue;
        decoded.push({ n, d });
        maxShards = Math.max(maxShards, d.shards);
      }
      // All notes are READ (merge keeps the newest entry per item), but only
      // notes of the current split are WRITTEN to, one per block. Notes left
      // over from an older split -- possible after a sync race between two
      // computers -- stay readable and simply lose to newer entries.
      const byIndex = new Map();
      for (const { n, d } of decoded) {
        if (d.shards === maxShards && !byIndex.has(d.index)) byIndex.set(d.index, n);
      }
      const shards = decoded.map((x) => x.d);
      const lib = {
        entries: this.merge(shards),
        notes: byIndex,
        shards: maxShards,
        dirty: new Set(),
        writing: false
      };
      this._libs.set(libraryID, lib);
      ZoteroSemantic.log("store: library " + libraryID + ", " + Object.keys(lib.entries).length +
        " documenti in " + notes.length + " note");
      return lib;
    })();
    this._loading.set(libraryID, p);
    try { return await p; } finally { this._loading.delete(libraryID); }
  },

  async put(item, concepts) {
    const lib = await this.load(item.libraryID);
    lib.entries[item.key] = {
      t: Date.now(),
      c: concepts.map(([name, share]) => [name, Math.round(share * 1000)])
    };
    lib.dirty.add(this.shardOf(item.key, lib.shards));
  },

  // Writes the shards that changed. Re-splits (and rewrites everything) when a
  // shard would exceed the size Zotero can sync.
  async flush(libraryID) {
    const lib = this._libs.get(libraryID);
    if (!lib || !lib.dirty.size) return;
    const library = Zotero.Libraries.get(libraryID);
    if (library && library.editable === false) {
      ZoteroSemantic.log("store: library " + libraryID + " is read-only, data kept in memory only");
      lib.dirty.clear();
      return;
    }

    const planned = this.planShards(lib.entries, lib.shards, this.LIMIT);
    if (planned !== lib.shards) {
      ZoteroSemantic.log("store: re-split " + lib.shards + " -> " + planned + " blocks");
      lib.shards = planned;
      for (let i = 0; i < planned; i++) lib.dirty.add(i);
    }

    const groups = this.partition(lib.entries, lib.shards);
    lib.writing = true;
    try {
      const collectionID = await this._collectionID(libraryID);
      for (const index of [...lib.dirty].sort((a, b) => a - b)) {
        const html = this.encode({ shards: lib.shards, index, entries: groups[index] });
        let note = lib.notes.get(index);
        if (!note || note.deleted) {
          if (!Object.keys(groups[index]).length) continue;
          note = new Zotero.Item("note");
          note.libraryID = libraryID;
          if (collectionID) note.setCollections([collectionID]);
          lib.notes.set(index, note);
        }
        note.setNote(html);
        await note.saveTx();
      }
      lib.dirty.clear();
    } finally {
      lib.writing = false;
    }
  },

  // Every concept used in a library, most frequent first, with its count.
  async vocabulary(libraryID) {
    const lib = await this.load(libraryID);
    const freq = new Map();
    for (const e of Object.values(lib.entries)) {
      for (const [name] of e.c || []) freq.set(name, (freq.get(name) || 0) + 1);
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  },

  async _findNotes(libraryID) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "is", "note");
    s.addCondition("note", "contains", this.MARKER);
    const ids = await s.search();
    const items = await Zotero.Items.getAsync(ids);
    return items.filter((n) => n && !n.deleted && n.isNote());
  },

  async _collectionID(libraryID) {
    try {
      const existing = Zotero.Collections.getByLibrary(libraryID)
        .find((c) => c.name === this.COLLECTION && !c.deleted);
      if (existing) return existing.id;
      const c = new Zotero.Collection();
      c.libraryID = libraryID;
      c.name = this.COLLECTION;
      await c.saveTx();
      return c.id;
    } catch (e) {
      ZoteroSemantic.log("store collection: " + e);
      return null;   // notes still work without the collection
    }
  }
};
