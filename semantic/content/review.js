/* eslint-disable no-undef */
// Review window for AI-proposed tags. Nothing is written to the library until
// the user presses "Applica selezionati", and every tag can be unticked
// individually -- an AI quietly rewriting a hand-built vocabulary would be
// worse than no AI at all.

(function () {
  const args = (window.arguments && window.arguments[0]) || {};
  const results = args.results || [];
  const apply = args.apply || (async () => 0);
  const done = args.done || function () {};

  const list = document.getElementById("list");
  const count = document.getElementById("count");
  const toggle = document.getElementById("toggle");
  const boxes = [];

  function refreshCount() {
    const n = boxes.filter((b) => b.cb.checked).length;
    count.textContent = n + " di " + boxes.length + " tag selezionati";
    toggle.textContent = n === boxes.length ? "Deseleziona tutti" : "Seleziona tutti";
  }

  for (const r of results) {
    const h = document.createElement("h3");
    h.textContent = r.title || "(senza titolo)";
    list.appendChild(h);

    if (r.meta) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = r.meta;
      list.appendChild(meta);
    }

    const tags = document.createElement("div");
    tags.className = "tags";
    list.appendChild(tags);

    for (const tag of r.tags) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", refreshCount);
      const span = document.createElement("span");
      span.textContent = tag;
      label.appendChild(cb);
      label.appendChild(span);
      tags.appendChild(label);
      boxes.push({ index: r.index, tag, cb });
    }
  }

  // Generic suggestions are worth cherry-picking, so make it cheap to clear
  // everything and tick back only what is actually wanted.
  toggle.addEventListener("click", () => {
    const target = !boxes.every((b) => b.cb.checked);
    for (const b of boxes) b.cb.checked = target;
    refreshCount();
  });

  document.getElementById("cancel").addEventListener("click", () => window.close());

  const applyBtn = document.getElementById("apply");
  applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    const chosen = boxes.filter((b) => b.cb.checked).map((b) => ({ index: b.index, tag: b.tag }));
    let n = 0;
    try { n = await apply(chosen); } catch (e) { /* reported by the opener */ }
    window.close();
    done(n);
  });

  refreshCount();
})();
