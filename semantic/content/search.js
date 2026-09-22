/* eslint-disable no-undef */
// Results of a topic search: the library ordered by semantic relevance.
// The opener hands over plain rows, so this window never touches Zotero items.

(function () {
  const args = (window.arguments && window.arguments[0]) || {};
  const topic = args.topic || "";
  const rows = args.rows || [];
  const selectItem = args.selectItem || function () {};

  document.title = "Zotero Semantic - pertinenza: " + topic;
  document.getElementById("topic").textContent = topic;
  document.getElementById("sub").textContent =
    rows.length + " documenti ordinati per pertinenza semantica";

  const list = document.getElementById("list");

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "row";
    row.addEventListener("dblclick", () => selectItem(r.id));

    const pct = document.createElement("div");
    pct.className = "pct";
    pct.textContent = Math.round(r.score * 100) + "%";
    row.appendChild(pct);

    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("i");
    fill.style.width = Math.max(2, Math.min(100, Math.round(r.score * 100))) + "%";
    meter.appendChild(fill);
    row.appendChild(meter);

    const txt = document.createElement("div");
    txt.className = "txt";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = r.title;
    txt.appendChild(t);
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = r.meta;
    txt.appendChild(m);
    row.appendChild(txt);

    list.appendChild(row);
  }
})();
