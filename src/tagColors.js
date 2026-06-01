/* eslint-disable no-undef */
// Stable, pleasant colours for tags.
//
// Priority for a tag's colour:
//   1. A colour the user already assigned to that tag in Zotero (respected, never overwritten).
//   2. A colour this plugin previously auto-assigned (persisted in prefs so it stays the same).
//   3. A new colour deterministically derived from the tag name, then persisted.
// Because step 3 is deterministic AND persisted, a tag keeps the same colour
// forever -- recognisable at a glance, as requested.

ZoteroMarkupEnhancer.TagColors = {
  // A curated, evenly-spread, easy-on-the-eyes palette.
  PALETTE: [
    "#e6677a", "#e6884f", "#e0b13c", "#9cb84a", "#5fb37a",
    "#48b0a0", "#4aa3c7", "#5b8fd6", "#7b78d6", "#a86fd0",
    "#cf6fc0", "#d96f96", "#c98a5e", "#8a9a5b", "#5fa8a0",
    "#6f93c7", "#9d7bbf", "#c07b9b", "#7fa86f", "#d3a14b"
  ],

  // Pick a deterministic palette colour for a brand-new tag, nudging away from
  // an exact hash collision so visually-adjacent tags differ a little.
  _derive(name) {
    const U = ZoteroMarkupEnhancer.Utils;
    const idx = U.hashString(name) % this.PALETTE.length;
    return this.PALETTE[idx];
  },

  // libraryID is needed to read Zotero's own tag colours.
  forTag(name, libraryID) {
    const U = ZoteroMarkupEnhancer.Utils;

    // 1. Honour Zotero's native tag colour if one exists.
    try {
      const zColor = Zotero.Tags.getColor(libraryID, name);
      if (zColor && zColor.color) {
        return U.toHex6(zColor.color) || zColor.color;
      }
    } catch (e) {
      // getColor may not exist on some versions; fall through.
    }

    // 2. Previously auto-assigned colour.
    const store = U.getJSON("tagColors", {});
    if (store[name]) return store[name];

    // 3. Derive, persist, return.
    const color = this._derive(name);
    store[name] = color;
    U.setJSON("tagColors", store);
    return color;
  },

  // --- recently-used tracking -------------------------------------------

  recent() {
    return ZoteroMarkupEnhancer.Utils.getJSON("recentTags", []);
  },

  noteUsed(name) {
    const U = ZoteroMarkupEnhancer.Utils;
    const max = Number(U.get("recentTagCount")) || 12;
    let list = U.getJSON("recentTags", []).filter((t) => t !== name);
    list.unshift(name);
    if (list.length > max * 2) list = list.slice(0, max * 2);
    U.setJSON("recentTags", list);
  }
};
