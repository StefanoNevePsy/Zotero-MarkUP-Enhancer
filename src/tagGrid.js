/* eslint-disable no-undef */
// A colored, scrollable tag grid.
//
// Two entry points share the same renderer (buildUI):
//   * An item-pane "Tag Grid" section for regular items.
//   * A 🏷 button injected into each annotation's header in the reader sidebar,
//     which opens the same grid as a popup so you can tag annotations quickly.
//
// The grid shows every existing tag as a coloured chip; recently-used tags come
// first, then the rest alphabetically. Clicking a chip toggles the tag on the
// item/annotation. A text field filters, and Enter creates a new tag.

ZoteroMarkupEnhancer.TagGrid = {
  HTML_NS: "http://www.w3.org/1999/xhtml",
  sectionID: null,
  _readerHandler: null,

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

    this._initReader();
  },

  shutdown() {
    if (this.sectionID) {
      try { Zotero.ItemPaneManager.unregisterSection(this.sectionID); } catch (e) { /* ignore */ }
      this.sectionID = null;
    }
    if (this._readerHandler) {
      try {
        Zotero.Reader.unregisterEventListener("renderSidebarAnnotationHeader", this._readerHandler);
      } catch (e) { /* ignore */ }
      this._readerHandler = null;
    }
  },

  _el(doc, tag, props) {
    const el = doc.createElementNS(this.HTML_NS, tag);
    if (props) Object.assign(el, props);
    return el;
  },

  _injectStyle(doc) {
    if (doc.getElementById("zmue-tg-style")) return;
    const style = doc.createElementNS(this.HTML_NS, "style");
    style.id = "zmue-tg-style";
    style.textContent = `
      .zmue-tg-wrap { display:flex; flex-direction:column; gap:6px; padding:4px 2px; }
      .zmue-tg-input {
        width:100%; box-sizing:border-box; padding:5px 8px;
        border:1px solid var(--fill-quarternary, #ccc); border-radius:6px;
        background: var(--material-background, #fff); color: inherit;
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
      .zmue-tg-annot-btn {
        background:transparent; border:none; cursor:pointer; font-size:12px;
        padding:0 4px; line-height:1; opacity:.75;
      }
      .zmue-tg-annot-btn:hover { opacity:1; }
      .zmue-tg-popup {
        position:fixed; z-index:99999; width:280px; max-width:90vw;
        background:var(--material-background,#fff); color:var(--fill-primary,#111);
        border:1px solid rgba(0,0,0,.2); border-radius:8px;
        box-shadow:0 6px 24px rgba(0,0,0,.25); padding:6px;
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  },

  async _allTagNames(libraryID) {
    let raw = Zotero.Tags.getAll(libraryID);
    if (raw && typeof raw.then === "function") raw = await raw;
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => (typeof t === "string" ? t : t.tag)).filter(Boolean);
  },

  _orderedNames(allNames) {
    const U = ZoteroMarkupEnhancer.Utils;
    const TC = ZoteroMarkupEnhancer.TagColors;
    const recentCount = Number(U.get("recentTagCount")) || 12;
    const existing = new Set(allNames);

    const recent = TC.recent().filter((n) => existing.has(n)).slice(0, recentCount);
    const recentSet = new Set(recent);

    const rest = allNames
      .filter((n) => !recentSet.has(n))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    return { recent, rest };
  },

  // ---- item-pane section ------------------------------------------------

  async render(body, item, editable) {
    const doc = body.ownerDocument;
    body.textContent = "";

    if (!item || typeof item.getTags !== "function") {
      const note = this._el(doc, "div", { className: "zmue-tg-empty" });
      note.textContent = "Select an item to manage its tags.";
      this._injectStyle(doc);
      body.appendChild(note);
      return;
    }
    await this.buildUI(doc, body, item, editable);
  },

  // ---- shared renderer (item pane + annotation popup) -------------------

  async buildUI(doc, container, item, editable) {
    this._injectStyle(doc);
    container.textContent = "";

    const wrap = this._el(doc, "div", { className: "zmue-tg-wrap" });
    const input = this._el(doc, "input", { className: "zmue-tg-input" });
    input.type = "text";
    input.placeholder = editable
      ? "Filter tags… (Enter to add)"
      : "Filter tags…";
    const grid = this._el(doc, "div", { className: "zmue-tg-grid" });
    wrap.appendChild(input);
    wrap.appendChild(grid);
    container.appendChild(wrap);

    const libraryID = item.libraryID;
    const allNames = await this._allTagNames(libraryID);

    // Keep just-added (and recently-used) tags visible even if a tag was purged
    // from the library after being removed from its only item.
    const known = new Set(allNames);
    for (const n of ZoteroMarkupEnhancer.TagColors.recent()) {
      if (!known.has(n)) { allNames.push(n); known.add(n); }
    }
    for (const t of item.getTags() || []) {
      if (!known.has(t.tag)) { allNames.push(t.tag); known.add(t.tag); }
    }

    const currentNames = () => new Set((item.getTags() || []).map((t) => t.tag));

    const buildGrid = (filterRaw) => {
      const filter = (filterRaw || "").trim().toLowerCase();
      const scrollTop = grid.scrollTop;
      grid.textContent = "";

      const currentSet = currentNames();
      const { recent, rest } = this._orderedNames(allNames);
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
          grid.appendChild(
            this._chip(doc, name, libraryID, currentSet, editable, buildGrid, input, item)
          );
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
      if (!currentNames().has(name)) {
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
  },

  // ---- reader sidebar integration (tag grid for annotations) ------------

  _initReader() {
    const self = this;
    this._readerHandler = (event) => {
      try { self._onAnnotationHeader(event); }
      catch (e) { ZoteroMarkupEnhancer.log("annot header: " + e); }
    };
    try {
      Zotero.Reader.registerEventListener(
        "renderSidebarAnnotationHeader", this._readerHandler, ZoteroMarkupEnhancer.id
      );
    } catch (e) {
      ZoteroMarkupEnhancer.log("reader tag handler reg failed: " + e);
    }
  },

  _onAnnotationHeader(event) {
    const { reader, doc, params, append } = event;
    if (!doc) return;
    this._injectStyle(doc);

    const btn = this._el(doc, "button", { className: "zmue-tg-annot-btn" });
    btn.textContent = "🏷";
    btn.title = "Tag grid";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const item = this._resolveAnnotation(reader, params);
      this._toggleAnnotationGrid(doc, btn, item);
    });

    if (typeof append === "function") {
      append(btn);
    } else if (event.append && event.append.appendChild) {
      event.append.appendChild(btn);
    }
  },

  _resolveAnnotation(reader, params) {
    try {
      let key = null;
      if (params) {
        if (params.annotation) key = params.annotation.id || params.annotation.key;
        key = key || params.id || params.key || params.annotationKey;
        if (!key && Array.isArray(params.ids) && params.ids.length) key = params.ids[0];
      }
      ZoteroMarkupEnhancer.log(
        "annot header params=[" + (params ? Object.keys(params).join(",") : "") + "] key=" + key
      );
      if (!key) return null;

      for (const id of reader.annotationItemIDs || []) {
        const it = Zotero.Items.get(id);
        if (it && (it.key === key || it.id === key)) return it;
      }
      const attachment = Zotero.Items.get(reader.itemID);
      if (attachment) {
        const ann = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
        if (ann) return ann;
      }
    } catch (e) {
      ZoteroMarkupEnhancer.log("resolve annotation: " + e);
    }
    return null;
  },

  _toggleAnnotationGrid(doc, btn, item) {
    const existing = doc.getElementById("zmue-annot-popup");
    if (existing) {
      const sameBtn = existing.__zmueBtn === btn;
      existing.remove();
      if (sameBtn) return; // toggle closed
    }
    if (!item) {
      ZoteroMarkupEnhancer.log("annotation could not be resolved for tag grid");
      return;
    }

    const popup = this._el(doc, "div", { className: "zmue-tg-popup" });
    popup.id = "zmue-annot-popup";
    popup.__zmueBtn = btn;
    doc.body.appendChild(popup);

    this.buildUI(doc, popup, item, true).catch((e) =>
      ZoteroMarkupEnhancer.log("annot grid build: " + e)
    );

    const view = doc.defaultView;
    const r = btn.getBoundingClientRect();
    const top = Math.min(r.bottom + 4, (view.innerHeight || 600) - 320);
    const left = Math.min(r.left, (view.innerWidth || 400) - 290);
    popup.style.top = Math.max(8, top) + "px";
    popup.style.left = Math.max(8, left) + "px";

    const onDocDown = (e) => {
      if (!popup.contains(e.target) && e.target !== btn) {
        popup.remove();
        doc.removeEventListener("mousedown", onDocDown, true);
      }
    };
    view.setTimeout(() => doc.addEventListener("mousedown", onDocDown, true), 0);
  }
};
