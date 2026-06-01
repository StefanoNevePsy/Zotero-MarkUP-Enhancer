/* eslint-disable no-undef */
// Merges overlapping highlight annotations into a single annotation.
//
// When two highlights overlap, Zotero stores them as two separate annotations
// (two notes, a duplicated region, doubled tint). This watches for newly added
// highlight annotations and, if a new highlight overlaps an existing one on the
// same page (same colour by default), it merges them: the rectangles are
// unioned, the text/comments/tags are combined, and the redundant annotation is
// removed -- leaving one clean note that still syncs as an ordinary annotation.

ZoteroMarkupEnhancer.OverlapMerger = {
  _notifierID: null,
  _processing: false,

  init() {
    this._notifierID = Zotero.Notifier.registerObserver(
      this,
      ["item"],
      "zmue-overlap-merger",
      90
    );
  },

  shutdown() {
    if (this._notifierID) {
      try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* ignore */ }
      this._notifierID = null;
    }
  },

  notify(event, type, ids) {
    if (event !== "add" || type !== "item") return;
    const on = ZoteroMarkupEnhancer.Utils.get("mergeOverlapping");
    ZoteroMarkupEnhancer.log(
      "merge: notify add ids=" + ids.join(",") +
      " mergeOverlapping=" + on + " processing=" + this._processing
    );
    if (this._processing) return;
    if (!on) return;
    this._handleAdds(ids.slice()).catch((e) =>
      ZoteroMarkupEnhancer.log("overlap merge: " + (e && e.stack ? e.stack : e))
    );
  },

  async _handleAdds(ids) {
    const sameColorOnly = ZoteroMarkupEnhancer.Utils.get("mergeSameColorOnly");
    const L = (m) => ZoteroMarkupEnhancer.log("merge: " + m);
    L("add ids=" + ids.join(","));
    for (const id of ids) {
      let item;
      try {
        item = await Zotero.Items.getAsync(id);
      } catch (e) { continue; }
      if (!item || !item.isAnnotation || !item.isAnnotation()) { L(id + " not annotation"); continue; }
      L(id + " type=" + item.annotationType + " color=" + item.annotationColor + " parent=" + item.parentID);
      if (item.annotationType !== "highlight") continue;
      if (!item.parentID) continue;

      try {
        await this._tryMergeOne(item, sameColorOnly, L);
      } catch (e) {
        L("error: " + (e && e.stack ? e.stack : e));
      }
    }
  },

  async _tryMergeOne(item, sameColorOnly, L) {
    const attachment = await Zotero.Items.getAsync(item.parentID);
    if (!attachment) return;

    let sibs = attachment.getAnnotations();
    if (sibs && typeof sibs.then === "function") sibs = await sibs;
    if (!Array.isArray(sibs)) { L("no sibling array"); return; }

    const myPos = this._pos(item);
    if (!myPos) { L("no position for new annotation"); return; }
    L("checking " + sibs.length + " siblings on page " + myPos.pageIndex);

    for (const sib of sibs) {
      if (!sib || sib.id === item.id) continue;
      if (sib.annotationType !== "highlight") continue;
      if (sameColorOnly && this._baseColor(sib) !== this._baseColor(item)) {
        L("sib " + sib.id + " different base colour (" +
          this._baseColor(sib) + " vs " + this._baseColor(item) + ")");
        continue;
      }

      const sibPos = this._pos(sib);
      if (!sibPos || sibPos.pageIndex !== myPos.pageIndex) continue;
      const overlap = this._rectsOverlap(myPos.rects, sibPos.rects);
      L("sib " + sib.id + " samePage overlap=" + overlap);
      if (!overlap) continue;

      L("merging " + item.id + " with " + sib.id);
      await this._merge(item, sib);
      return; // one merge per add; chained overlaps resolve on their own adds
    }
    L("no overlapping sibling found");
  },

  _pos(annotation) {
    try {
      const p = JSON.parse(annotation.annotationPosition);
      if (!p || !Array.isArray(p.rects)) return null;
      return p;
    } catch (e) {
      return null;
    }
  },

  _color(annotation) {
    const c = ZoteroMarkupEnhancer.Utils.toHex6(annotation.annotationColor);
    return c || annotation.annotationColor;
  },

  // The "base" (standard) colour of an annotation, regardless of any palette
  // display value that may momentarily be stored on it. This makes the
  // same-colour check immune to observer ordering: if the reader briefly saved
  // a palette (displayed) colour before the safety net normalised it, we still
  // compare the underlying standard colours.
  _baseColor(annotation) {
    const U = ZoteroMarkupEnhancer.Utils;
    const hex = U.toHex6(annotation.annotationColor);
    if (!hex) return annotation.annotationColor;

    const P = ZoteroMarkupEnhancer.Palettes;
    if (P.standardSet().has(hex)) return hex; // already standard

    // Map a palette display colour back to its standard slot.
    const map = P.activeMap(); // standard -> displayed
    for (const std of Object.keys(map)) {
      if (map[std] === hex) return std;
    }
    return hex; // unknown colour: leave as-is
  },

  _rectsOverlap(a, b) {
    for (const r of a) {
      for (const s of b) {
        if (r[0] < s[2] && r[2] > s[0] && r[1] < s[3] && r[3] > s[1]) {
          return true;
        }
      }
    }
    return false;
  },

  // Union rectangles: group into lines (overlapping y-range), then merge
  // horizontally-overlapping/touching rects within each line.
  _mergeRects(rects) {
    const sorted = rects.slice().sort((a, b) => b[1] - a[1]);
    const lines = [];
    for (const r of sorted) {
      let placed = false;
      for (const line of lines) {
        if (r[1] < line.y2 && r[3] > line.y1) {
          line.rects.push(r);
          line.y1 = Math.min(line.y1, r[1]);
          line.y2 = Math.max(line.y2, r[3]);
          placed = true;
          break;
        }
      }
      if (!placed) lines.push({ y1: r[1], y2: r[3], rects: [r] });
    }

    const out = [];
    for (const line of lines) {
      const rs = line.rects.slice().sort((a, b) => a[0] - b[0]);
      let cur = rs[0].slice();
      for (let i = 1; i < rs.length; i++) {
        const r = rs[i];
        if (r[0] <= cur[2] + 1) {
          cur[1] = Math.min(cur[1], r[1]);
          cur[2] = Math.max(cur[2], r[2]);
          cur[3] = Math.max(cur[3], r[3]);
        } else {
          out.push(cur);
          cur = r.slice();
        }
      }
      out.push(cur);
    }
    return out;
  },

  _bbox(pos) {
    let top = -Infinity, left = Infinity;
    for (const r of pos.rects) {
      if (r[3] > top) top = r[3];
      if (r[0] < left) left = r[0];
    }
    return { top, left };
  },

  // True if A reads before B (higher on the page, then further left).
  _readsFirst(aPos, bPos) {
    const a = this._bbox(aPos);
    const b = this._bbox(bPos);
    if (Math.abs(a.top - b.top) > 2) return a.top > b.top;
    return a.left <= b.left;
  },

  _combineText(first, second) {
    const f = (first || "").trim();
    const s = (second || "").trim();
    if (!f) return s;
    if (!s) return f;
    if (f === s) return f;
    if (f.includes(s)) return f;
    if (s.includes(f)) return s;
    return f + " " + s;
  },

  _combineComment(a, b) {
    const x = (a || "").trim();
    const y = (b || "").trim();
    if (!x) return y;
    if (!y || x === y) return x;
    return x + "\n" + y;
  },

  async _merge(a, b) {
    this._processing = true;
    try {
      const keep = a.id < b.id ? a : b; // keep the older annotation
      const drop = keep === a ? b : a;

      const keepPos = this._pos(keep);
      const dropPos = this._pos(drop);
      if (!keepPos || !dropPos) return;

      const keepFirst = this._readsFirst(keepPos, dropPos);

      // Union the rectangles.
      const merged = this._mergeRects(keepPos.rects.concat(dropPos.rects));
      keepPos.rects = merged;
      keep.annotationPosition = JSON.stringify(keepPos);

      // Make sure the merged annotation is stored with a standard colour, even
      // if a palette (displayed) colour had momentarily leaked onto it.
      const base = this._baseColor(keep);
      if (base && base !== this._color(keep)) {
        keep.annotationColor = base;
      }

      // Text / comment in reading order.
      const t1 = keepFirst ? keep.annotationText : drop.annotationText;
      const t2 = keepFirst ? drop.annotationText : keep.annotationText;
      keep.annotationText = this._combineText(t1, t2);

      const c1 = keepFirst ? keep.annotationComment : drop.annotationComment;
      const c2 = keepFirst ? drop.annotationComment : keep.annotationComment;
      keep.annotationComment = this._combineComment(c1, c2);

      // Union tags.
      try {
        for (const t of drop.getTags() || []) {
          keep.addTag(t.tag, t.type);
        }
      } catch (e) { /* ignore tag merge issues */ }

      await keep.saveTx();
      await drop.eraseTx();
      ZoteroMarkupEnhancer.log("merged overlapping highlights " + drop.id + " -> " + keep.id);
    } finally {
      this._processing = false;
    }
  }
};
