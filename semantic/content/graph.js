/* eslint-disable no-undef */
// Self-contained force-directed graph on a canvas. No external libraries: the
// reader/chrome CSP blocks CDNs, and a few hundred nodes do not need one.
//
// Edge weight drives BOTH the pull strength and the resting distance, so
// strongly related documents sit close together and weak links stay far apart.

(function () {
  const args = (window.arguments && window.arguments[0]) || {};
  const data = args.data || { nodes: [], edges: [], mode: "lexical" };
  const selectItem = args.selectItem || function () {};

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const tip = document.getElementById("tip");
  const threshEl = document.getElementById("thresh");
  const searchEl = document.getElementById("search");

  document.getElementById("mode").textContent =
    (data.mode === "semantic" ? "distanze semantiche (embedding)" : "distanze lessicali (tag/autori)") +
    " · " + data.nodes.length + " documenti" +
    (data.truncated ? " (troncati)" : "");

  // ---- state ----
  const N = data.nodes.length;
  const nodes = data.nodes.map((n, i) => ({
    ...n,
    x: Math.cos((i / N) * Math.PI * 2) * 220 + (Math.random() - 0.5) * 40,
    y: Math.sin((i / N) * Math.PI * 2) * 220 + (Math.random() - 0.5) * 40,
    vx: 0, vy: 0, deg: 0
  }));
  const edges = data.edges.slice();
  for (const e of edges) { nodes[e.s].deg++; nodes[e.t].deg++; }

  let view = { x: 0, y: 0, k: 1 };
  let alpha = 1;
  let minW = 0;
  let query = "";
  let hover = null;
  let dragNode = null;
  let panning = false;
  let last = { x: 0, y: 0 };

  const maxDeg = Math.max(1, ...nodes.map((n) => n.deg));
  const radius = (n) => 4 + 7 * Math.sqrt(n.deg / maxDeg);

  function hue(n) {
    let h = 0;
    const s = (n.tags && n.tags[0]) || n.author || n.title || "";
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", () => { resize(); });

  function activeEdges() {
    return edges.filter((e) => e.w >= minW);
  }

  function matches(n) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (n.title || "").toLowerCase().includes(q) ||
      (n.author || "").toLowerCase().includes(q) ||
      (n.tags || []).some((t) => t.toLowerCase().includes(q));
  }

  // ---- simulation ----
  function step() {
    if (alpha < 0.002) return;
    const es = activeEdges();

    // Repulsion (O(n^2); fine up to a few hundred nodes).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
        const d = Math.sqrt(d2);
        const f = 900 / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Springs: stronger weight -> shorter rest length and stiffer pull.
    for (const e of es) {
      const a = nodes[e.s], b = nodes[e.t];
      const rest = 260 - 200 * e.w;
      const k = 0.02 + 0.09 * e.w;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d - rest) * k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Gravity to keep the layout together, then integrate.
    for (const n of nodes) {
      n.vx -= n.x * 0.002;
      n.vy -= n.y * 0.002;
      if (n === dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= 0.82;
      n.vy *= 0.82;
    }
    alpha *= 0.994;
  }

  // ---- rendering ----
  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    const dim = !!query;
    for (const e of activeEdges()) {
      const a = nodes[e.s], b = nodes[e.t];
      const lit = !dim || (matches(a) && matches(b));
      ctx.strokeStyle = "rgba(130,130,150," + (lit ? 0.12 + 0.55 * e.w : 0.04) + ")";
      ctx.lineWidth = (0.4 + 2.2 * e.w) / view.k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      const lit = matches(n);
      const r = radius(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue(n) + ",62%,58%," + (lit ? 0.95 : 0.15) + ")";
      ctx.fill();
      if (n === hover) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.stroke();
      }
      if (view.k > 0.85 && lit) {
        ctx.fillStyle = "rgba(128,128,140," + (view.k > 1.2 ? 0.95 : 0.6) + ")";
        ctx.font = (11 / view.k) + "px -apple-system, system-ui, sans-serif";
        ctx.textAlign = "center";
        const label = n.title.length > 34 ? n.title.slice(0, 33) + "…" : n.title;
        ctx.fillText(label, n.x, n.y + r + 11 / view.k);
      }
    }
    ctx.restore();
  }

  function frame() {
    step();
    draw();
    window.requestAnimationFrame(frame);
  }

  // ---- interaction ----
  function toWorld(ev) {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left - rect.width / 2 - view.x;
    const py = ev.clientY - rect.top - rect.height / 2 - view.y;
    return { x: px / view.k, y: py / view.k };
  }

  function nodeAt(p) {
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < radius(n) + 6 && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  canvas.addEventListener("mousedown", (ev) => {
    const p = toWorld(ev);
    dragNode = nodeAt(p);
    if (!dragNode) { panning = true; last = { x: ev.clientX, y: ev.clientY }; }
  });

  canvas.addEventListener("mousemove", (ev) => {
    const p = toWorld(ev);
    if (dragNode) {
      dragNode.x = p.x; dragNode.y = p.y;
      alpha = Math.max(alpha, 0.35);
      return;
    }
    if (panning) {
      view.x += ev.clientX - last.x;
      view.y += ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      return;
    }
    const n = nodeAt(p);
    hover = n;
    if (n) {
      tip.style.display = "block";
      tip.style.left = (ev.clientX + 14) + "px";
      tip.style.top = (ev.clientY + 12) + "px";
      const meta = [n.author, n.year].filter(Boolean).join(" · ");
      tip.innerHTML = "";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = n.title;
      tip.appendChild(t);
      if (meta) {
        const m = document.createElement("div");
        m.className = "m";
        m.textContent = meta;
        tip.appendChild(m);
      }
      if (n.tags && n.tags.length) {
        const g = document.createElement("div");
        g.className = "m";
        g.textContent = n.tags.join(" · ");
        tip.appendChild(g);
      }
    } else {
      tip.style.display = "none";
    }
  });

  window.addEventListener("mouseup", () => { dragNode = null; panning = false; });

  canvas.addEventListener("dblclick", (ev) => {
    const n = nodeAt(toWorld(ev));
    if (n) selectItem(n.id);
  });

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    view.k = Math.min(4, Math.max(0.2, view.k * f));
  }, { passive: false });

  threshEl.addEventListener("input", () => {
    minW = Number(threshEl.value) / 100;
    alpha = Math.max(alpha, 0.5);
  });
  searchEl.addEventListener("input", () => { query = searchEl.value.trim(); });
  document.getElementById("reheat").addEventListener("click", () => { alpha = 1; });

  resize();
  frame();
})();
