/* eslint-disable no-undef */
// Shared helpers: preference access (with defaults) and colour parsing.

ZoteroMarkupEnhancer.Utils = {
  PREF_PREFIX: "markup-enhancer.",

  // Default values. Zotero.Prefs auto-prefixes keys with "extensions.zotero.".
  DEFAULTS: {
    "palette": "pastel",                 // pastel | neon | earthy | default | custom
    // Custom palette: one bindable pref per standard colour slot.
    "customColor.yellow": "#ffd400",
    "customColor.red": "#ff6666",
    "customColor.green": "#5fb236",
    "customColor.blue": "#2ea8e5",
    "customColor.purple": "#a28ae5",
    "customColor.magenta": "#e56eee",
    "customColor.orange": "#f19837",
    "customColor.gray": "#aaaaaa",
    "roundedCorners": true,
    "cornerRadius": 4,                    // px
    "mergeOverlapping": true,
    "mergeSameColorOnly": true,
    "tagColors": "{}",                    // JSON: { tagName: hex } (persisted auto-assignments)
    "recentTags": "[]",                   // JSON: [tagName, ...] most-recent-first
    "recentTagCount": 12
  },

  key(name) {
    return this.PREF_PREFIX + name;
  },

  ensureDefaultPrefs() {
    for (const [name, value] of Object.entries(this.DEFAULTS)) {
      const k = this.key(name);
      if (Zotero.Prefs.get(k) === undefined) {
        Zotero.Prefs.set(k, value);
      }
    }
  },

  get(name) {
    const v = Zotero.Prefs.get(this.key(name));
    return v === undefined ? this.DEFAULTS[name] : v;
  },

  set(name, value) {
    Zotero.Prefs.set(this.key(name), value);
  },

  getJSON(name, fallback) {
    try {
      return JSON.parse(this.get(name));
    } catch (e) {
      return fallback;
    }
  },

  setJSON(name, obj) {
    this.set(name, JSON.stringify(obj));
  },

  // ---- colour helpers ---------------------------------------------------

  // Normalise "#abc", "#aabbcc", "rgb(...)", "rgba(...)" to "#rrggbb" (lowercase).
  // Returns null if it cannot be parsed.
  toHex6(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();

    if (s[0] === "#") {
      if (s.length === 4) {
        return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      }
      if (s.length === 7) return s;
      if (s.length === 9) return s.slice(0, 7); // drop alpha
      return null;
    }

    const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) {
      const h = (n) => Number(n).toString(16).padStart(2, "0").slice(0, 2);
      return "#" + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return null;
  },

  // Extract the alpha channel (0..1) from an rgba()/8-digit-hex string, else null.
  alphaOf(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase();
    const m = s.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
    if (m) return Number(m[1]);
    if (s[0] === "#" && s.length === 9) {
      return parseInt(s.slice(7, 9), 16) / 255;
    }
    return null;
  },

  hexToRgb(hex) {
    const h = this.toHex6(hex);
    if (!h) return null;
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16)
    };
  },

  // Build "rgba(r,g,b,a)" from a hex colour + alpha.
  hexToRgba(hex, alpha) {
    const c = this.hexToRgb(hex);
    if (!c) return hex;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
  },

  // Relative luminance, used to pick black/white text over a coloured chip.
  isLight(hex) {
    const c = this.hexToRgb(hex);
    if (!c) return true;
    const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return lum > 0.6;
  },

  // Deterministic 32-bit hash of a string (used for stable colour assignment).
  hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
};
