/* eslint-disable no-undef */
// Preferences and small shared helpers.

ZoteroSemantic.Utils = {
  PREF_PREFIX: "semantic.",

  DEFAULTS: {
    "provider": "gemini",              // gemini | apple
    "geminiKey": "",
    "geminiModel": "gemini-2.5-flash",
    "geminiEmbedModel": "text-embedding-004",
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
