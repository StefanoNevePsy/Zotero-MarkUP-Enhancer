/* eslint-disable no-undef */
// Highlighter palettes.
//
// Zotero ships 8 fixed annotation colours. Every palette is just a mapping from
// those 8 *stored* hex values to the *displayed* hex values. The stored colour
// never changes, so sync is unaffected -- only the on-screen tint differs.

ZoteroMarkupEnhancer.Palettes = {
  // Zotero's canonical annotation colours (lowercase, 6-digit).
  STANDARD: {
    yellow: "#ffd400",
    red: "#ff6666",
    green: "#5fb236",
    blue: "#2ea8e5",
    purple: "#a28ae5",
    magenta: "#e56eee",
    orange: "#f19837",
    gray: "#aaaaaa"
  },

  // Each palette maps the standard slot -> displayed colour.
  PALETTES: {
    default: {
      yellow: "#ffd400", red: "#ff6666", green: "#5fb236", blue: "#2ea8e5",
      purple: "#a28ae5", magenta: "#e56eee", orange: "#f19837", gray: "#aaaaaa"
    },
    pastel: {
      yellow: "#fff1a8", red: "#ffb3ba", green: "#bde8b0", blue: "#a8d8f0",
      purple: "#d2c4f3", magenta: "#f3c4ee", orange: "#ffd6a8", gray: "#d9d9d9"
    },
    neon: {
      yellow: "#fff200", red: "#ff2d55", green: "#39ff14", blue: "#00e5ff",
      purple: "#bf00ff", magenta: "#ff00d4", orange: "#ff7a00", gray: "#9ea7ad"
    },
    earthy: {
      yellow: "#d9b35b", red: "#b5554a", green: "#7a8c4f", blue: "#5b7e8c",
      purple: "#8a7196", magenta: "#a86f8f", orange: "#c47a3d", gray: "#9c8f7e"
    }
  },

  // Returns the active map { standardHex(lowercase) : displayedHex }.
  activeMap() {
    const U = ZoteroMarkupEnhancer.Utils;
    const name = U.get("palette");

    let slotMap;
    if (name === "custom") {
      // Custom palette is stored keyed by standard hex; merge over default so
      // any unset slot falls back to the standard colour.
      const custom = U.getJSON("customPalette", {});
      const map = {};
      for (const [slot, std] of Object.entries(this.STANDARD)) {
        map[std] = U.toHex6(custom[std]) || std;
      }
      return map;
    }

    slotMap = this.PALETTES[name] || this.PALETTES.default;
    const map = {};
    for (const [slot, std] of Object.entries(this.STANDARD)) {
      map[std] = U.toHex6(slotMap[slot]) || std;
    }
    return map;
  },

  names() {
    return Object.keys(this.PALETTES).concat(["custom"]);
  }
};
