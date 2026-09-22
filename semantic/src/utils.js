/* eslint-disable no-undef */
// Preferences and small shared helpers.

ZoteroSemantic.Utils = {
  PREF_PREFIX: "semantic.",

  DEFAULTS: {
    "provider": "gemini",              // gemini | apple
    "geminiKey": "",
    "geminiModel": "gemini-2.5-flash",
    "geminiEmbedModel": "text-embedding-004",
    // Embeddings are chosen independently of the tagging engine, so the graph
    // and the topic search keep working with Apple on-device tagging.
    "embedProvider": "gemini",         // gemini | nvidia
    "nvidiaKey": "",
    "nvidiaBase": "https://integrate.api.nvidia.com/v1",
    "nvidiaEmbedModel": "nvidia/nemotron-3-embed-1b",
    // Apple on-device CLI. macOS 27 ships /usr/bin/fm; on macOS 26 point this at
    // a third-party CLI (e.g. fmx). {cli}, {prompt}, {schema} and {out} are
    // substituted with real paths.
    //
    // The default asks fm for guaranteed structured output: build a schema for
    // an array of strings, then constrain the answer to it, so the reply is
    // always {"tags": [...]} instead of free prose. If the CLI does not support
    // --schema, the plain template below is used automatically as a fallback.
    "appleCli": "/usr/bin/fm",
    "appleTemplate":
      "{cli} schema object --name Tags --string tags --array > '{schema}' && " +
      "{cli} respond \"$(cat '{prompt}')\" --schema '{schema}' > '{out}' 2>&1",
    "appleTemplatePlain": "{cli} respond \"$(cat '{prompt}')\" > '{out}' 2>&1",
    "maxTags": 8,
    "reuseVocabulary": true,           // prefer tags already in the library
    "profileMaxChars": 8000,
    "annotationMaxChars": 3000,
    "graphMaxNodes": 300,
    // Mozilla preferences hold only strings, 32-bit integers and booleans.
    // A fractional value here makes Zotero.Prefs.set throw, so the minimum edge
    // weight is stored as a whole percentage and divided when used.
    "graphMinWeightPct": 12,
    "embeddings": true,                // use embeddings for graph distances
    "conceptsMax": 12,                 // concepts extracted per document
    // The concept that drives the "Pertinenza" column and the graph's lens.
    "activeConcept": "",
    // Off by default: Zotero.MenuManager can only label entries with an
    // l10nID, and an unresolved id breaks Zotero's whole context menu.
    "enableContextMenu": false
  },

  key(name) { return this.PREF_PREFIX + name; },

  // One unwritable preference must never take the whole plugin down: a throw
  // here used to kill init() before any UI was registered, leaving the plugin
  // installed but completely inert.
  ensureDefaultPrefs() {
    for (const [name, value] of Object.entries(this.DEFAULTS)) {
      try {
        const k = this.key(name);
        if (Zotero.Prefs.get(k) === undefined) Zotero.Prefs.set(k, value);
      } catch (e) {
        ZoteroSemantic.log("could not set default pref '" + name + "' (" +
          typeof value + " " + value + "): " + e);
      }
    }
  },

  get(name) {
    const v = Zotero.Prefs.get(this.key(name));
    return v === undefined ? this.DEFAULTS[name] : v;
  },

  set(name, value) { Zotero.Prefs.set(this.key(name), value); },

  getJSON(name, fallback) {
    try { return JSON.parse(this.get(name)); } catch (e) { return fallback; }
  },

  setJSON(name, obj) { this.set(name, JSON.stringify(obj)); },

  // Collapse whitespace and hard-cap a string.
  clean(text, max) {
    if (!text) return "";
    let s = String(text).replace(/\s+/g, " ").trim();
    if (max && s.length > max) s = s.slice(0, max) + "…";
    return s;
  },

  // Evenly spaced excerpts across a long string: gives coverage of a whole book
  // without sending (or paying for) the entire text.
  sample(text, chunks, chunkSize) {
    if (!text) return [];
    const s = String(text);
    if (s.length <= chunks * chunkSize) return [s];
    const out = [];
    const step = Math.floor(s.length / chunks);
    for (let i = 0; i < chunks; i++) {
      out.push(s.substr(i * step, chunkSize));
    }
    return out;
  },

  // A budgeted excerpt of a long text: the opening, plus evenly spaced samples
  // taken through to the end, never exceeding `budget` characters. This is what
  // lets a 600-page book be described as cheaply as an article while still
  // being represented from beginning to end.
  sampleWithinBudget(text, budget) {
    if (!text) return "";
    const b = Math.max(300, Number(budget) || 3000);
    const s = String(text).replace(/\s+/g, " ").trim();
    if (s.length <= b) return s;

    const headLen = Math.min(1500, Math.floor(b * 0.35));
    const head = s.slice(0, headLen);
    const rest = s.slice(headLen);

    const chunks = 6;
    const sep = " … ";
    // Size the excerpts so the joined result lands inside the budget without
    // needing to be truncated -- truncation would cut off the final excerpt,
    // and the end of a paper is usually where its conclusions are.
    const per = Math.max(150, Math.floor((b - headLen - chunks * sep.length) / chunks));

    // Start positions run from 0 to (rest.length - per), so the last excerpt
    // ends at the end of the document rather than five sixths of the way in.
    const span = Math.max(0, rest.length - per);
    const parts = [head];
    for (let i = 0; i < chunks; i++) {
      const start = chunks === 1 ? 0 : Math.floor((i * span) / (chunks - 1));
      parts.push(rest.substr(start, per));
    }

    let out = parts.join(sep);
    if (out.length > b) out = out.slice(0, b);
    return out;
  },

  // `n` windows of `size` characters spread evenly from the very start to the
  // very end of a text. Unlike sampleWithinBudget() the windows are kept apart,
  // because each one is scored separately: how many of them mention a concept
  // is what tells "a central theme" from "mentioned in passing".
  windows(text, n, size) {
    if (!text) return [];
    const s = String(text).replace(/\s+/g, " ").trim();
    if (!s) return [];
    if (s.length <= size) return [s];
    const count = Math.max(1, Math.min(n, Math.ceil(s.length / size)));
    if (count === 1) return [s.slice(0, size)];
    const span = s.length - size;
    const out = [];
    for (let i = 0; i < count; i++) {
      const start = Math.floor((i * span) / (count - 1));
      out.push(s.substr(start, size));
    }
    return out;
  },

  // A fixed-width key whose string order equals its numeric order, whatever
  // collation the item list applies to plugin columns.
  sortKey(share) {
    const v = Math.max(0, Math.min(1000, Math.round((Number(share) || 0) * 1000)));
    return String(v).padStart(4, "0");
  },

  // Pick n items spread evenly across an array (preserves order).
  spread(arr, n) {
    if (!Array.isArray(arr) || arr.length <= n) return arr || [];
    const out = [];
    const step = arr.length / n;
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  },

  hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  },

  // Pull a JSON value out of a model reply that may be wrapped in prose or fences.
  parseJSONLoose(text) {
    if (!text) return null;
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (e) { /* keep trying */ }
    const start = s.search(/[[{]/);
    if (start === -1) return null;
    const openCh = s[start];
    const closeCh = openCh === "[" ? "]" : "}";
    const end = s.lastIndexOf(closeCh);
    if (end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  },

  cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },

  jaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const v of setA) if (setB.has(v)) inter++;
    return inter / (setA.size + setB.size - inter);
  }
};
