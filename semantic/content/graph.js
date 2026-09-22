/* eslint-disable no-undef */
// Self-contained force-directed graph on a canvas. No external libraries: the
// reader/chrome CSP blocks CDNs, and a few hundred nodes do not need one.
//
// Edge weight drives BOTH the pull strength and the resting distance, so
// strongly related documents sit close together and weak links stay far apart.

// A bitmap bigger than the graphics backend will allocate is refused with
// "Canvas exceeds max size", and the 2D context is then wedged permanently.
// The backing store is a resource like any other, so it gets an explicit
// budget instead of being whatever the window size multiplied by the device
// pixel ratio happens to produce.
const MAX_SIDE = 8192;      // px per side
const MAX_PIXELS = 16e6;    // total, i.e. a 4000x4000 bitmap

// Pure: the scale at which a `cw` x `ch` CSS-pixel area can be rendered
// without exceeding the budget. Normally this is just the device pixel ratio;
// it only drops for a very large window, where a slightly softer image is
// better than a canvas that refuses to draw at all.
function backingScale(cw, ch, dpr) {
  const w = Math.max(1, Number(cw) || 0);
  const h = Math.max(1, Number(ch) || 0);
  let s = Number(dpr) > 0 ? Number(dpr) : 1;
  s = Math.min(s, MAX_SIDE / w, MAX_SIDE / h);
  const px = w * h * s * s;
  if (px > MAX_PIXELS) s *= Math.sqrt(MAX_PIXELS / px);
  return Math.max(0.05, s);
}

// A canvas that draws nothing looks exactly like a canvas whose script threw:
// both are an empty rectangle with a working toolbar above it. This window
// therefore shows its own failures instead of failing silently.
function showError(where, e, detail) {
  if (typeof document === "undefined") return;
  const box = document.getElementById("err");
  if (!box) return;
  box.style.display = "block";
  // Gecko's e.stack does NOT start with the message the way V8's does, so
  // printing the stack alone loses the only line that says what went wrong.
  const head = e && e.name ? e.name + ": " + (e.message || "") : String(e);
  box.textContent = "Errore nella finestra della rete (" + where + "):\n" +
    head + (detail ? "\n\n" + detail : "") + (e && e.stack ? "\n\n" + e.stack : "");
}

(function () {
  try { main(); } catch (e) { showError("avvio", e); }
})();

function main() {
  const args = (window.arguments && window.arguments[0]) || {};
  const data = args.data || { nodes: [], edges: [], mode: "lexical" };
  const selectItem = args.selectItem || function () {};

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const tip = document.getElementById("tip");
  const threshEl = document.getElementById("thresh");
  const searchEl = document.getElementById("search");

  // The link count is here because "many documents, no links" and "nothing is
  // being drawn at all" look identical on an empty canvas.
  document.getElementById("mode").textContent =
    (data.mode === "semantic" ? "distanze semantiche (embedding)" : "distanze lessicali (tag/autori)") +
    " · " + data.nodes.length + " documenti · " +
    data.edges.length + " collegamenti" +
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

  // Kept in sync from inside the animation loop rather than only at load.
  //
  // A canvas drawn into a backing store of 0x0 shows nothing at all, and that
  // is what happens when this runs before the freshly opened window has been
  // laid out: clientWidth is still 0, no resize event ever follows, and the
  // graph stays invisible while everything around it looks fine. Checking each
  // frame costs nothing and recovers whenever the layout does settle.
  // What we last applied, rather than what the canvas reports back. Gecko may
  // clamp or refuse a size, and comparing against the read-back value then
  // never matches -- which would reallocate the bitmap on every single frame
  // until an allocation fails and the context is wedged for good.
  let applied = { w: 0, h: 0, dpr: 0, scale: 1 };

  // What the window currently measures, quoted in the error box: a size
  // problem is unreadable without the numbers that produced it.
  function measurements() {
    return "area " + canvas.clientWidth + "x" + canvas.clientHeight +
      " css · dpr " + (window.devicePixelRatio || 1) +
      " · bitmap " + canvas.width + "x" + canvas.height +
      " · scala " + Math.round(applied.scale * 100) / 100;
  }

  function ensureSize() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    // While the window reports no drawable area, leave the canvas untouched.
    // Forcing a degenerate buffer on it is what makes the 2D context start
    // throwing on the next call, which killed the loop just after the graph
    // had appeared.
    if (!cw || !ch) return false;
    const dpr = window.devicePixelRatio || 1;
    if (cw === applied.w && ch === applied.h && dpr === applied.dpr) return false;
    const scale = backingScale(cw, ch, dpr);
    applied = { w: cw, h: ch, dpr, scale };
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return true;
  }

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
    // Gecko puts a canvas into a permanent error state as soon as an operation
    // is attempted on a zero-sized bitmap, and from then on every single call
    // throws "Canvas is already in error state". Skipping the frame is free;
    // one call on a degenerate canvas costs the whole window.
    if (!w || !h || !canvas.width || !canvas.height) return;

    // Start from a known transform rather than from whatever the previous
    // frame left behind: now that a failed frame no longer ends the loop, an
    // abort between save() and restore() would otherwise grow the state stack
    // and skew every frame after it.
    const s = applied.scale || 1;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, w, h);
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
  }

  let ticks = 0;
  let timerDriven = false;

  // A frame can fail transiently while the window is still being set up, and
  // dropping one frame costs nothing. Ending the loop on it, however, leaves a
  // window that drew the graph once and then froze -- so only a failure that
  // persists is treated as fatal.
  const FATAL_AFTER = 45; // frames, i.e. roughly three quarters of a second
  let failures = 0;
  let firstError = null;

  // Gecko's canvas error state is sticky: once entered, every call throws and
  // nothing clears it by itself. Assigning width or height resets the canvas
  // bitmap (HTML spec) even when the value is unchanged, so going through a
  // different size and back is the way out.
  function recoverCanvas() {
    try {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!cw || !ch) return;
      const dpr = window.devicePixelRatio || 1;
      const scale = backingScale(cw, ch, dpr);
      canvas.width = 1;
      canvas.height = 1;
      canvas.width = Math.max(1, Math.round(cw * scale));
      canvas.height = Math.max(1, Math.round(ch * scale));
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      applied = { w: cw, h: ch, dpr, scale };
    } catch (e) { /* nothing more to try; the next frame will retry */ }
  }

  function tick() {
    try {
      // A layout that only settles after the first frames must not leave the
      // simulation frozen at the position it happened to reach while invisible.
      if (ensureSize()) alpha = Math.max(alpha, 0.6);
      step();
      draw();
      ticks++;
      failures = 0;
    } catch (e) {
      // Report the FIRST failure, not the latest: once the canvas is in its
      // error state every later call reports only that state, hiding whatever
      // actually caused it.
      if (!firstError) firstError = e;
      recoverCanvas();
      if (++failures >= FATAL_AFTER) {
        showError("disegno", firstError, measurements());
        return false;
      }
    }
    return true;
  }

  function rafLoop() {
    if (timerDriven) return;
    if (tick()) window.requestAnimationFrame(rafLoop);
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

  ensureSize();
  rafLoop();

  // The other way a canvas ends up blank while everything around it works:
  // requestAnimationFrame never delivers a frame in this window. Detect that
  // instead of assuming it, and drive the same loop from a timer.
  window.setTimeout(() => {
    if (ticks <= 1) {
      timerDriven = true;
      window.setInterval(tick, 33);
    }
    // Last resort: say what is wrong rather than show an empty rectangle.
    if (!canvas.clientWidth || !canvas.clientHeight) {
      showError("dimensioni", new Error(
        "L'area di disegno ha dimensione " + canvas.clientWidth + "x" +
        canvas.clientHeight + ". Prova a ridimensionare la finestra."));
    } else if (!nodes.length) {
      showError("dati", new Error("Nessun documento da mostrare."));
    }
  }, 1200);
}
