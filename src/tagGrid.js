/* eslint-disable no-undef */
// A colored, scrollable tag grid in the item pane.
//
// Adds a "Tag Grid" section to the item pane: a text field to filter / add,
// plus a scrollable grid of every existing tag rendered as a coloured chip.
// Recently-used tags come first (quick access to what you're researching now),
// then the rest alphabetically. Clicking a chip toggles the tag on the item.

ZoteroMarkupEnhancer.TagGrid = {
  HTML_NS: "http://www.w3.org/1999/xhtml",
  sectionID: null,

  init() {
    const rootURI = ZoteroMarkupEnhancer.rootURI;
    const self = this;
    this.sectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "zmue-tag-grid",
      pluginID: ZoteroMarkupEnhancer.id,
      header: {
        l10nID: "markup-enhancer-tag-grid",
        icon: rootURI + "icons/tag-grid.svg"
      },
      sidenav: {
        l10nID: "markup-enhancer-tag-grid",
        icon: rootURI + "icons/tag-grid.svg"
      },
      onRender: ({ body, item, editable }) => {
        self.render(body, item, editable).catch((e) =>
          ZoteroMarkupEnhancer.log("tag grid render: " + e)
        );
      }
    });
  },

  shutdown() {
    if (this.sectionID) {
      try {
        Zotero.ItemPaneManager.unregisterSection(this.sectionID);
      } catch (e) { /* ignore */ }
      this.sectionID = null;
    }
  },

  _el(doc, tag, props) {
    const el = doc.createElementNS(this.HTML_NS, tag);
    if (props) Object.assign(el, props);
    return el;
  },

  _injectStyle(doc, container) {
    if (container.querySelector("style[data-zmue]")) return;
    const style = doc.createElementNS(this.HTML_NS, "style");
    style.setAttribute("data-zmue", "1");
    style.textContent = `
      .zmue-tg-wrap { display:flex; flex-direction:column; gap:6px; padding:4px 2px; }
      .zmue-tg-input {
        width:100%; box-sizing:border-box; padding:5px 8px;
        border:1px solid var(--fill-quarternary, #ccc); border-radius:6px;
        background: var(--material-background, #fff);
      }
      .zmue-tg-grid {
        display:flex; flex-wrap:wrap; gap:5px;
        max-height:220px; overflow-y:auto; padding:2px;
        align-content:flex-start;
      }
      .zmue-tg-chip {
        display:inline-flex; align-items:center; gap:4px;
        padding:3px 9px; border-radius:999px; font-size:12px; line-height:1.3;
        cursor:pointer; user-select:none; border:2px solid transparent;
        max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .zmue-tg-chip:hover { filter:brightness(0.95); }
      .zmue-tg-chip.zmue-sel { border-color: var(--fill-primary, #111); font-weight:600; }
      .zmue-tg-chip .zmue-check { font-weight:700; }
      .zmue-tg-sep { width:100%; font-size:10px; text-transform:uppercase;
        letter-spacing:.04em; opacity:.55; margin:4px 0 0; }
      .zmue-tg-empty { opacity:.6; font-size:12px; padding:8px 2px; }
    `;
    container.appendChild(style);
  },

  async _allTagNames(libraryID) {
    let raw = Zotero.Tags.getAll(libraryID);
    if (raw && typeof raw.then === "function") raw = await raw;
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => (typeof t === "string" ? t : t.tag)).filter(Boolean);
  },

  _orderedNames(allNames, currentSet) {
    const U = ZoteroMarkupEnhancer.Utils;
    const TC = ZoteroMarkupEnhancer.TagColors;
    const recentCount = Number(U.get("recentTagCount")) || 12;
    const existing = new Set(allNames);

    const recent = TC.recent()
      .filter((n) => existing.has(n))
      .slice(0, recentCount);
    const recentSet = new Set(recent);

    const rest = allNames
      .filter((n) => !recentSet.has(n))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return { recent, rest, currentSet };
  },

  async render(body, item, editable) {
    const doc = body.ownerDocument;
    body.textContent = "";

    if (!item || !item.isRegularItem || !item.isRegularItem()) {
      const note = this._el(doc, "div", { className: "zmue-tg-empty" });
      note.textContent = "Select an item to manage its tags.";
      body.appendChild(note);
      return;
    }

    this._injectStyle(doc, body);

    const wrap = this._el(doc, "div", { className: "zmue-tg-wrap" });
    const input = this._el(doc, "input", { className: "zmue-tg-input" });
    input.type = "text";
    input.placeholder = editable
      ? "Filter tags… (press Enter to add a new one)"
      : "Filter tags…";
    const grid = this._el(doc, "div", { className: "zmue-tg-grid" });
    wrap.appendChild(input);
    wrap.appendChild(grid);
    body.appendChild(wrap);

    const libraryID = item.libraryID;
    const allNames = await this._allTagNames(libraryID);

    const currentNames = () => new Set((item.getTags() || []).map((t) => t.tag));

    const buildGrid = (filterRaw) => {
      const filter = (filterRaw || "").trim().toLowerCase();
      const scrollTop = grid.scrollTop;
      grid.textContent = "";

      const currentSet = currentNames();
      const { recent, rest } = this._orderedNames(allNames, currentSet);

      const match = (n) => !filter || n.toLowerCase().includes(filter);
      const recentF = recent.filter(match);
      const restF = rest.filter(match);

      if (!recentF.length && !restF.length) {
        const empty = this._el(doc, "div", { className: "zmue-tg-empty" });
        empty.textContent = editable
          ? "No matching tags. Press Enter to create one."
          : "No matching tags.";
        grid.appendChild(empty);
        return;
      }

      const addChips = (names, label) => {
        if (!names.length) return;
        if (label) {
          const sep = this._el(doc, "div", { className: "zmue-tg-sep" });
          sep.textContent = label;
          grid.appendChild(sep);
        }
        for (const name of names) {
          grid.appendChild(this._chip(doc, name, libraryID, currentSet, editable, buildGrid, input, item));
        }
      };

      addChips(recentF, recentF.length ? "Recent" : "");
      addChips(restF, recentF.length ? "All tags" : "");
      grid.scrollTop = scrollTop;
    };

    input.addEventListener("input", () => buildGrid(input.value));
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !editable) return;
      const name = input.value.trim();
      if (!name) return;
      e.preventDefault();
      if (!(currentNames().has(name))) {
        item.addTag(name);
        await item.saveTx();
        ZoteroMarkupEnhancer.TagColors.noteUsed(name);
        if (!allNames.includes(name)) allNames.push(name);
      }
      input.value = "";
      buildGrid("");
    });

    buildGrid("");
  },

  _chip(doc, name, libraryID, currentSet, editable, rebuild, input, item) {
    const U = ZoteroMarkupEnhancer.Utils;
    const color = ZoteroMarkupEnhancer.TagColors.forTag(name, libraryID);
    const selected = currentSet.has(name);

    const chip = this._el(doc, "div", { className: "zmue-tg-chip" });
    chip.style.backgroundColor = color;
    chip.style.color = U.isLight(color) ? "#1a1a1a" : "#ffffff";
    chip.title = name;
    if (selected) chip.classList.add("zmue-sel");

    if (selected) {
      const check = this._el(doc, "span", { className: "zmue-check" });
      check.textContent = "✓";
      chip.appendChild(check);
    }
    const label = this._el(doc, "span");
    label.textContent = name;
    chip.appendChild(label);

    if (!editable) {
      chip.style.cursor = "default";
      return chip;
    }

    chip.addEventListener("click", async () => {
      try {
        if (currentSet.has(name)) {
          item.removeTag(name);
        } else {
          item.addTag(name);
          ZoteroMarkupEnhancer.TagColors.noteUsed(name);
        }
        await item.saveTx();
        rebuild(input.value);
      } catch (e) {
        ZoteroMarkupEnhancer.log("toggle tag: " + e);
      }
    });

    return chip;
  }
};
