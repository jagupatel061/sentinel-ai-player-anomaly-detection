/* =========================================================
   SENTINEL AI — front-end
   Reads public/data/results.json (written by backend/pipeline.py)
   Every number on the page is computed from that file.
   ========================================================= */
(() => {
  "use strict";

  const C = {
    cyan: "#6ef3ff", pink: "#ff3d81", violet: "#a07cff", amber: "#ffc24b",
    green: "#53f5a6", text: "#ecebf5", muted: "#8b8aa6", dim: "#5d5c78",
    grid: "rgba(255,255,255,0.06)",
  };
  const TYPE_COLOR = { human: C.cyan, aimbot: C.pink, speedhack: C.amber, triggerbot: C.violet };
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const FEAT_INFO = {
    mean_speed:        ["Mean speed", "Average movement speed across the match."],
    max_speed:         ["Max speed", "Peak speed. A speedhack breaks the game's movement cap."],
    speed_std:         ["Speed variance", "How much speed changes from tick to tick."],
    snap_angle:        ["Snap angle", "Aim rotation the moment an enemy appears — aimbots flick hard and exact."],
    aim_jitter:        ["Aim jitter", "Crosshair micro-shake while idle. Human hands shake; code doesn't."],
    reaction_mean:     ["Reaction time", "Average delay from enemy visible to first shot (ms)."],
    reaction_std:      ["Reaction consistency", "Spread of reaction times. Triggerbots are robotically steady."],
    hit_rate:          ["Hit rate", "Share of shots fired that land."],
    headshot_rate:     ["Headshot rate", "Share of hits that are headshots."],
    path_straightness: ["Path straightness", "Net displacement ÷ total distance travelled."],
  };
  const COL_INFO = {
    match_id: "Match identifier (20 matches)", player_id: "Unique player in a match",
    tick: "Time step, 10 per second", pos_x: "X position on the 1000×1000 map",
    pos_y: "Y position on the map", speed: "Movement speed this tick",
    yaw: "Horizontal aim angle (°)", pitch: "Vertical aim angle (°)",
    yaw_delta: "Change in aim since last tick", enemy_visible: "1 if an enemy is on screen",
    is_firing: "1 if the player shot", reaction_ms: "Reaction time — only exists when firing",
    is_hit: "1 if the shot landed", is_headshot: "1 if it was a headshot",
    true_label: "Ground truth — evaluation only",
  };
  const TYPE_DESC = {
    aimbot: "Snap-to-target aim, high accuracy. Some are subtle “closet” cheaters.",
    speedhack: "Movement speed beyond the game's physical cap.",
    triggerbot: "Fires the instant a target appears, with inhuman consistency.",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  const tierOf = (p) => !p.is_anomaly ? "normal" : p.anomaly_score >= 2.5 ? "critical" : p.anomaly_score >= 1.8 ? "high" : "review";
  const TIER_COLOR = { critical: C.pink, high: C.violet, review: C.amber, normal: C.cyan };

  /* ---------- reveal on scroll ---------- */
  const revealHooks = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      const fn = revealHooks.get(e.target);
      if (fn) { fn(); revealHooks.delete(e.target); }
      io.unobserve(e.target);
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  const onReveal = (node, fn) => { revealHooks.set(node, fn); io.observe(node); };

  function countUp(node, to, { dec = 0, suffix = "", dur = 1600 } = {}) {
    if (REDUCED) { node.textContent = fmt(to, dec) + suffix; return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 4);
      node.textContent = fmt(to * e, dec) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* =========================================================
     SVG CHART KIT (no external libraries — works offline)
     ========================================================= */
  const NS = "http://www.w3.org/2000/svg";
  const S = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const tip = {
    show(html, e) {
      const t = $("#tip"); t.innerHTML = html; t.classList.add("on");
      const r = t.getBoundingClientRect();
      let x = e.clientX + 16, y = e.clientY + 16;
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 16;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 16;
      t.style.transform = `translate(${x}px, ${y}px)`;
    },
    hide() { $("#tip").classList.remove("on"); },
  };
  const niceTicks = (min, max, n = 5) => {
    const span = max - min || 1, step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  };
  const redraws = [];
  let rT;
  window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => redraws.forEach((f) => f()), 180); });
  function frame(host, m = { t: 16, r: 16, b: 44, l: 52 }) {
    host.innerHTML = "";
    const W = host.clientWidth, H = host.clientHeight;
    const svg = S("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" }, host);
    return { svg, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b };
  }
  function axes(f, xs, ys, { xTicks, yTicks, xLabel, yLabel, xFmt = (v) => v, yFmt = (v) => v, xGrid = false }) {
    const { svg, m, iw, ih } = f;
    const g = S("g", { class: "axes" }, svg);
    yTicks.forEach((v) => {
      const y = m.t + ys(v);
      S("line", { x1: m.l, x2: m.l + iw, y1: y, y2: y, class: "grid" }, g);
      S("text", { x: m.l - 10, y: y + 4, "text-anchor": "end", class: "tick" }, g).textContent = yFmt(v);
    });
    xTicks.forEach((v) => {
      const x = m.l + xs(v);
      if (xGrid) S("line", { x1: x, x2: x, y1: m.t, y2: m.t + ih, class: "grid" }, g);
      S("text", { x, y: m.t + ih + 18, "text-anchor": "middle", class: "tick" }, g).textContent = xFmt(v);
    });
    S("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis" }, g);
    if (xLabel) S("text", { x: m.l + iw / 2, y: m.t + ih + 38, "text-anchor": "middle", class: "axis-label" }, g).textContent = xLabel;
    if (yLabel) S("text", { x: 14, y: m.t + ih / 2, transform: `rotate(-90 14 ${m.t + ih / 2})`, "text-anchor": "middle", class: "axis-label" }, g).textContent = yLabel;
    return g;
  }
  function glowDefs(svg) {
    const d = S("defs", {}, svg);
    const f = S("filter", { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, d);
    S("feGaussianBlur", { stdDeviation: "3", result: "b" }, f);
    const mg = S("feMerge", {}, f); S("feMergeNode", { in: "b" }, mg); S("feMergeNode", { in: "SourceGraphic" }, mg);
    return d;
  }

  /* ---------- k-distance ---------- */
  function renderKDist({ D }) {
    const kd = D.model.k_distance, knee = D.model.knee_index, eps = D.model.eps;
    $("#eps-tag").textContent = `ε = ${eps.toFixed(3)}`;
    $("#k-label").textContent = `${D.model.min_samples}th`;
    const host = $("#kdist");
    const draw = (animate) => {
      const f = frame(host); const { svg, m, iw, ih } = f;
      const defs = glowDefs(svg);
      const lg = S("linearGradient", { id: "kdFill", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
      S("stop", { offset: "0", "stop-color": C.cyan, "stop-opacity": ".28" }, lg);
      S("stop", { offset: "1", "stop-color": C.cyan, "stop-opacity": "0" }, lg);
      const yMax = Math.max(...kd) * 1.05;
      const xs = (i) => (i / (kd.length - 1)) * iw, ys = (v) => ih - (v / yMax) * ih;
      axes(f, xs, ys, { xTicks: niceTicks(0, kd.length - 1, 5), yTicks: niceTicks(0, yMax, 5), xLabel: "Players, sorted by k-NN distance", yLabel: "k-NN distance", yFmt: (v) => v.toFixed(1) });
      const g = S("g", { transform: `translate(${m.l},${m.t})` }, svg);
      const d = kd.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join("");
      S("path", { d: `${d}L${iw},${ih}L0,${ih}Z`, fill: "url(#kdFill)", class: animate ? "fade-in" : "" }, g);
      const line = S("path", { d, fill: "none", stroke: C.cyan, "stroke-width": 2.2, "stroke-linejoin": "round", filter: "url(#glow)" }, g);
      if (animate && !REDUCED) { const L = line.getTotalLength(); line.style.strokeDasharray = L; line.style.strokeDashoffset = L; line.getBoundingClientRect(); line.style.transition = "stroke-dashoffset 1.8s cubic-bezier(.2,.7,.2,1)"; line.style.strokeDashoffset = 0; }
      S("line", { x1: 0, x2: iw, y1: ys(eps), y2: ys(eps), stroke: C.pink, "stroke-dasharray": "6 6", "stroke-width": 1.4 }, g);
      S("text", { x: 6, y: ys(eps) - 8, class: "tick", fill: C.pink, style: `fill:${C.pink}` }, g).textContent = `ε = ${eps.toFixed(2)}`;
      const kx = xs(knee), ky = ys(kd[knee]);
      S("circle", { cx: kx, cy: ky, r: 14, fill: "none", stroke: C.pink, "stroke-opacity": ".4", class: "pulse-ring" }, g);
      S("circle", { cx: kx, cy: ky, r: 6, fill: C.pink, stroke: "#fff", "stroke-width": 2, filter: "url(#glow)" }, g);
      S("text", { x: kx - 10, y: ky - 20, "text-anchor": "end", class: "tick", style: `fill:${C.text}` }, g).textContent = "knee → ε";
      // hover
      const guide = S("line", { y1: 0, y2: ih, stroke: "rgba(255,255,255,.25)", "stroke-width": 1, opacity: 0 }, g);
      const dot = S("circle", { r: 4.5, fill: "#fff", opacity: 0 }, g);
      const hit = S("rect", { width: iw, height: ih, fill: "transparent" }, g);
      hit.addEventListener("mousemove", (e) => {
        const r = hit.getBoundingClientRect();
        const i = Math.max(0, Math.min(kd.length - 1, Math.round(((e.clientX - r.left) / r.width) * (kd.length - 1))));
        guide.setAttribute("x1", xs(i)); guide.setAttribute("x2", xs(i)); guide.setAttribute("opacity", 1);
        dot.setAttribute("cx", xs(i)); dot.setAttribute("cy", ys(kd[i])); dot.setAttribute("opacity", 1);
        tip.show(`<b>rank ${i}</b><br>distance ${kd[i].toFixed(3)}${i === knee ? "<br><span style='color:" + C.pink + "'>← knee = ε</span>" : ""}`, e);
      });
      hit.addEventListener("mouseleave", () => { guide.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); tip.hide(); });
    };
    onReveal(host.closest(".card"), () => { draw(true); redraws.push(() => draw(false)); });
  }

  /* ---------- PCA scatter ---------- */
  let selectPlayer, pcaMode = "pred";
  function renderPCA({ players }) {
    const host = $("#pca");
    const colorOf = (p) => (pcaMode === "pred" ? (p.is_anomaly ? C.pink : C.cyan) : TYPE_COLOR[p.true_label]);
    const legendFor = () => {
      $("#pca-legend").innerHTML = pcaMode === "pred"
        ? `<span><i style="background:${C.cyan}"></i>Normal (dense core)</span><span><i style="background:${C.pink};border-radius:2px;transform:rotate(45deg)"></i>Flagged anomaly</span><span class="mono">hover a point · click a flagged one to open its dossier</span>`
        : ["human", "aimbot", "speedhack", "triggerbot"].map((t) => `<span><i style="background:${TYPE_COLOR[t]}"></i>${t}</span>`).join("") + `<span><i style="border:2px solid ${C.pink};background:transparent"></i>human wrongly flagged</span>`;
    };
    let marks = [];
    const paint = () => marks.forEach(({ node, halo, p }) => {
      const col = colorOf(p);
      node.style.fill = col; node.style.fillOpacity = p.is_anomaly || (pcaMode === "truth" && p.true_label !== "human") ? 0.95 : 0.55;
      const fp = pcaMode === "truth" && p.is_anomaly && p.true_label === "human";
      node.style.stroke = fp ? C.pink : "rgba(0,0,0,.35)"; node.style.strokeWidth = fp ? 2.5 : 1;
      if (halo) { halo.style.fill = col; halo.style.opacity = pcaMode === "pred" || p.true_label !== "human" ? 0.18 : 0; }
      node.setAttribute("transform", node.dataset.base + (pcaMode === "pred" && p.is_anomaly ? " rotate(45)" : ""));
    });
    const draw = (animate) => {
      const f = frame(host, { t: 16, r: 20, b: 44, l: 48 }); const { svg, m, iw, ih } = f;
      glowDefs(svg);
      const xsV = players.map((p) => p.pca_x), ysV = players.map((p) => p.pca_y);
      const pad = (a, b) => [(a - (b - a) * 0.06), (b + (b - a) * 0.06)];
      const [x0, x1] = pad(Math.min(...xsV), Math.max(...xsV)), [y0, y1] = pad(Math.min(...ysV), Math.max(...ysV));
      const xs = (v) => ((v - x0) / (x1 - x0)) * iw, ys = (v) => ih - ((v - y0) / (y1 - y0)) * ih;
      axes(f, xs, ys, { xTicks: niceTicks(x0, x1, 7), yTicks: niceTicks(y0, y1, 5), xLabel: "Principal component 1", yLabel: "PC 2", xGrid: true });
      const g = S("g", { transform: `translate(${m.l},${m.t})` }, svg);
      marks = [];
      const order = [...players].sort((a, b) => a.is_anomaly - b.is_anomaly);
      order.forEach((p, i) => {
        const cx = xs(p.pca_x), cy = ys(p.pca_y);
        const halo = p.is_anomaly ? S("circle", { cx, cy, r: 14, class: "halo" }, g) : null;
        const r = p.is_anomaly ? 6 : 3.6;
        const node = p.is_anomaly
          ? S("rect", { x: -r, y: -r, width: r * 2, height: r * 2, rx: 1.5, class: "pt" }, g)
          : S("circle", { cx: 0, cy: 0, r, class: "pt" }, g);
        node.dataset.base = `translate(${cx.toFixed(1)},${cy.toFixed(1)})`;
        if (animate && !REDUCED) { node.style.opacity = 0; setTimeout(() => (node.style.opacity = 1), 200 + i * 4); }
        node.addEventListener("mousemove", (e) => tip.show(`<b>${p.player_id}</b><br>score ${p.anomaly_score.toFixed(2)} · ${p.anomaly_type}<br><span style="color:${TYPE_COLOR[p.true_label]}">truth: ${p.true_label}</span>`, e));
        node.addEventListener("mouseleave", tip.hide);
        if (p.is_anomaly) { node.style.cursor = "pointer"; node.addEventListener("click", () => { tip.hide(); selectPlayer && selectPlayer(p.player_id); $("#detections").scrollIntoView({ behavior: "smooth" }); }); }
        marks.push({ node, halo, p });
      });
      paint();
    };
    legendFor();
    onReveal(host.closest(".card"), () => { draw(true); redraws.push(() => draw(false)); });
    $$(".toggle button").forEach((b) => b.addEventListener("click", () => {
      $$(".toggle button").forEach((x) => x.classList.toggle("active", x === b));
      pcaMode = b.dataset.mode; legendFor(); paint();
    }));
  }

  /* ---------- radar ---------- */
  function drawRadar(host, labels, series, maxV) {
    host.innerHTML = "";
    const W = host.clientWidth, H = host.clientHeight;
    const svg = S("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" }, host);
    glowDefs(svg);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 34, n = labels.length;
    const pt = (i, v) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; const r = (Math.min(v, maxV) / maxV) * R; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    const rings = niceTicks(0, maxV, 4).filter((v) => v > 0);
    rings.forEach((v) => {
      S("polygon", { points: labels.map((_, i) => pt(i, v).join(",")).join(" "), class: "grid", fill: "none" }, svg);
      const [tx, ty] = pt(0, v); S("text", { x: tx + 4, y: ty + 3, class: "tick small-tick" }, svg).textContent = `${v}σ`;
    });
    labels.forEach((l, i) => {
      const [x, y] = pt(i, maxV); S("line", { x1: cx, y1: cy, x2: x, y2: y, class: "grid" }, svg);
      const [lx, ly] = pt(i, maxV * 1.16);
      const t = S("text", { x: lx, y: ly + 3, "text-anchor": Math.abs(lx - cx) < 6 ? "middle" : lx > cx ? "start" : "end", class: "tick radar-label" }, svg);
      t.textContent = l;
    });
    series.forEach(({ vals, color, dash, fillOp, name }) => {
      const pts = vals.map((v, i) => pt(i, v).join(",")).join(" ");
      const poly = S("polygon", { points: pts, fill: color, "fill-opacity": fillOp, stroke: color, "stroke-width": dash ? 1.4 : 2, "stroke-dasharray": dash ? "4 4" : "", filter: dash ? "" : "url(#glow)", class: "radar-poly" }, svg);
      if (!dash) vals.forEach((v, i) => {
        const [x, y] = pt(i, v);
        const c = S("circle", { cx: x, cy: y, r: 3.5, fill: color, stroke: "#fff", "stroke-width": 1 }, svg);
        c.addEventListener("mousemove", (e) => tip.show(`<b>${labels[i]}</b><br>${name}: ${v.toFixed(2)}σ`, e));
        c.addEventListener("mouseleave", tip.hide);
      });
      if (!REDUCED) { poly.style.transformOrigin = `${cx}px ${cy}px`; poly.animate([{ transform: "scale(0.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 700, easing: "cubic-bezier(.2,.7,.2,1)" }); }
    });
  }

  /* ---------- score histogram ---------- */
  function renderHist({ players }) {
    const host = $("#hist");
    const step = 0.25;
    const max = Math.ceil(Math.max(...players.map((p) => p.anomaly_score)) / step) * step;
    const bins = Math.max(1, Math.round(max / step));
    const hum = Array(bins).fill(0), che = Array(bins).fill(0);
    players.forEach((p) => { const i = Math.min(bins - 1, Math.floor(p.anomaly_score / step)); (p.true_label === "human" ? hum : che)[i]++; });
    const draw = (animate) => {
      const f = frame(host, { t: 30, r: 16, b: 44, l: 52 }); const { svg, m, iw, ih } = f;
      const yMax = Math.max(...hum.map((h, i) => h + che[i]));
      const lmax = Math.log10(yMax * 1.6);
      const yv = (v) => (v <= 0 ? 0 : (Math.log10(v + 1) / lmax) * ih); // log(1+n) keeps 1s visible
      const bw = iw / bins;
      const xs = (v) => (v / max) * iw;
      const yTicks = [1, 10, 100, 1000].filter((v) => v <= yMax * 1.6);
      axes(f, xs, (v) => ih - yv(v), { xTicks: niceTicks(0, max, Math.min(8, bins)), yTicks, xLabel: "Anomaly score  (distance to nearest normal core ÷ ε)", yLabel: "Players (log)", xFmt: (v) => v.toFixed(1) });
      const g = S("g", { transform: `translate(${m.l},${m.t})` }, svg);
      for (let i = 0; i < bins; i++) {
        const x = i * bw + 2, w = Math.max(2, bw - 4);
        const hH = yv(hum[i]), tot = yv(hum[i] + che[i]);
        const mk = (y, h, color, label, n) => {
          if (h <= 0) return;
          const r = S("rect", { x, y, width: w, height: h, rx: 3, fill: color, class: "bar" }, g);
          if (animate && !REDUCED) { r.style.transformOrigin = `0 ${ih}px`; r.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 900, delay: i * 25, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }); }
          r.addEventListener("mousemove", (e) => tip.show(`<b>score ${(i * step).toFixed(2)} – ${((i + 1) * step).toFixed(2)}</b><br><span style="color:${color}">${label}: ${n}</span>`, e));
          r.addEventListener("mouseleave", tip.hide);
        };
        mk(ih - hH, hH, "rgba(110,243,255,.78)", "humans", hum[i]);
        mk(ih - tot, tot - hH, "rgba(255,61,129,.9)", "cheaters", che[i]);
      }
      const tx = xs(1.0);
      S("line", { x1: tx, x2: tx, y1: -14, y2: ih, stroke: "rgba(255,255,255,.6)", "stroke-dasharray": "5 5" }, g);
      S("text", { x: tx + 8, y: -4, class: "tick", style: `fill:${C.text}` }, g).textContent = "DBSCAN boundary (1.0) →";
      const lg = S("g", { transform: `translate(${iw - 170},-18)` }, g);
      [["humans", "rgba(110,243,255,.85)"], ["cheaters", C.pink]].forEach(([l, c], i) => {
        S("rect", { x: i * 88, y: 0, width: 10, height: 10, rx: 2, fill: c }, lg);
        S("text", { x: i * 88 + 16, y: 9, class: "tick" }, lg).textContent = l;
      });
    };
    onReveal(host.closest(".card"), () => { draw(true); redraws.push(() => draw(false)); });
  }

  /* =========================================================
     BOOT
     ========================================================= */
  fetch("public/data/results.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => {
      $("#loader").innerHTML = `<div class="loader-ring"></div>
        <p class="err">Couldn't load <code>public/data/results.json</code>.<br>
        Run <code>python backend/pipeline.py</code>, then serve this folder with
        <code>python -m http.server</code> and open <code>localhost:8000</code>.</p>`;
    });

  function init(D) {
    const players = D.players;
    const F = D.model.features;

    // population mean/std per feature -> z-scores (same scaling DBSCAN used)
    const stats = {};
    F.forEach((f) => {
      const v = players.map((p) => p[f]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
      stats[f] = { m, s };
    });
    players.forEach((p) => { p.z = {}; F.forEach((f) => (p.z[f] = (p[f] - stats[f].m) / stats[f].s)); p.tier = tierOf(p); });

    const flagged = players.filter((p) => p.is_anomaly).sort((a, b) => b.anomaly_score - a.anomaly_score);
    const ctx = { D, players, F, stats, flagged };

    renderKPIs(ctx);
    renderTicker(ctx);
    renderData(ctx);
    renderFeatures(ctx);
    renderKDist(ctx); renderPCA(ctx); renderHist(ctx);
    renderParams(ctx);
    renderSuspects(ctx);
    renderEval(ctx);
    renderConclusion(ctx);
    startArena(ctx);
    navBehaviour();

    $$(".reveal").forEach((n) => io.observe(n));
    setTimeout(() => $("#loader").classList.add("done"), 350);
  }

  /* ---------- hero KPIs ---------- */
  function renderKPIs({ D, flagged }) {
    const box = $("#kpis");
    const items = [
      [D.dataset.rows, "Telemetry ticks", "", 0, ""],
      [D.dataset.players, "Players analysed", "", 0, ""],
      [flagged.length, "Flagged by DBSCAN", "pink", 0, ""],
      [D.metrics.recall * 100, "Cheaters caught", "cyan", 0, "%"],
    ];
    items.forEach(([v, label, cls, dec, suf]) => {
      const k = el("div", "kpi");
      const val = el("div", `kpi-val ${cls}`, "0");
      k.append(val, el("div", "kpi-label", label));
      box.append(k);
      setTimeout(() => countUp(val, v, { dec, suffix: suf }), 700);
    });
  }

  /* ---------- ticker ---------- */
  function renderTicker({ players }) {
    const pick = [...players].sort(() => 0.5 - Math.random()).slice(0, 26);
    const html = pick.map((p) => p.is_anomaly
      ? `<span class="t-flag">▲ ${p.player_id} · score ${p.anomaly_score.toFixed(2)} · ${FEAT_INFO[p.top_reason][0].toUpperCase()}</span>`
      : `<span class="t-ok">● ${p.player_id} · cleared</span>`).join("");
    $("#ticker").innerHTML = html + html;
  }

  /* ---------- data section ---------- */
  function renderData({ D, players }) {
    const ds = D.dataset;
    const box = $("#data-stats");
    const ticksPer = Math.round(ds.rows / ds.players);
    const stats = [[ds.rows, "raw rows", 0], [ds.players, "players", 0], [ds.matches, "matches", 0],
      [ds.columns.length, "raw columns", 0], [ticksPer, "ticks per player", 0], [ds.missing_reaction_pct, "% reaction_ms empty*", 1]];
    stats.forEach(([, l]) => {
      const s = el("div", "stat");
      s.append(el("div", "stat-val", "0"), el("div", "stat-label", l));
      box.append(s);
    });
    const foot = el("p", "caption", "* Structural, not dirty: reaction time only exists on ticks where the player fired, so it stays missing at tick level and is aggregated per player.");
    foot.style.cssText = "grid-column:1/-1;padding:16px 24px 20px;margin:0";
    box.append(foot);
    onReveal(box, () => $$(".stat-val", box).forEach((n, i) => countUp(n, stats[i][0], { dec: stats[i][2] })));

    // population mix
    const counts = {};
    players.forEach((p) => (counts[p.true_label] = (counts[p.true_label] || 0) + 1));
    const order = ["human", "aimbot", "triggerbot", "speedhack"].filter((t) => counts[t]);
    const bar = $("#mix-bar"), leg = $("#mix-legend");
    order.forEach((t) => {
      const seg = el("div"); seg.style.background = TYPE_COLOR[t];
      seg.style.boxShadow = `0 0 18px ${TYPE_COLOR[t]}55`;
      seg.dataset.g = counts[t]; bar.append(seg);
      leg.append(el("div", "mix-item", `<b>${counts[t]}</b><i style="background:${TYPE_COLOR[t]}"></i>${t}`));
    });
    onReveal(bar, () => $$("div", bar).forEach((s) => (s.style.flexGrow = s.dataset.g)));

    // schema
    const sc = $("#schema");
    ds.columns.forEach((c) => {
      const chip = el("div", `col-chip ${c === "true_label" ? "hidden-col" : ""}`, `<span class="mono">${c}</span><p>${COL_INFO[c] || ""}</p>`);
      sc.append(chip);
    });
    $("#schema-count").textContent = `${ds.columns.length} columns`;
  }

  /* ---------- features ---------- */
  function renderFeatures({ F, players, flagged }) {
    const grid = $("#feat-grid");
    const normal = players.filter((p) => !p.is_anomaly);
    const mean = (arr, f) => arr.reduce((a, p) => a + Math.abs(p.z[f]), 0) / arr.length;
    const reasonCount = {};
    flagged.forEach((p) => (reasonCount[p.top_reason] = (reasonCount[p.top_reason] || 0) + 1));
    F.forEach((f, i) => {
      const [name, desc] = FEAT_INFO[f] || [f, ""];
      const zn = mean(normal, f), zf = mean(flagged, f);
      const card = el("div", "feat reveal");
      const hits = reasonCount[f] ? `<span class="feat-flag">TOP SIGNAL ×${reasonCount[f]}</span>` : "";
      card.innerHTML = `
        <div class="feat-top"><span class="feat-idx">F${String(i + 1).padStart(2, "0")}</span>${hits}</div>
        <h3>${f}</h3><p>${desc}</p>
        <div class="zbars">
          ${zrow("normal", zn, C.cyan)}
          ${zrow("flagged", zf, C.pink)}
        </div>`;
      grid.append(card);
      onReveal(card, () => $$(".zfill", card).forEach((b) => { b.style.left = b.dataset.l; b.style.width = b.dataset.w; }));
    });
    function zrow(label, z, color) {
      const MAX = 4;
      const w = Math.min(z, MAX) / MAX * 100;
      return `<div class="zrow"><span>${label}</span><div class="ztrack"><div class="zfill" style="left:0;width:0;background:${color};box-shadow:0 0 10px ${color}" data-l="0" data-w="${w}%"></div></div><span class="zval" style="color:${color}">${z.toFixed(1)}σ</span></div>`;
    }
  }

  /* ---------- params ---------- */
  function renderParams({ D, flagged }) {
    const noise = flagged.filter((p) => p.anomaly_type === "noise").length;
    const micro = flagged.length - noise;
    const rows = [
      ["ε (eps)", "neighbourhood radius", D.model.eps.toFixed(3), ""],
      ["min_samples", "points to form a dense core", D.model.min_samples, ""],
      ["Normal clusters", "dense regions of honest play", D.model.n_clusters, ""],
      ["Noise points", "belong to no dense region", noise, "pink"],
      ["Micro-cluster members", "tiny groups < 10% of players", micro, "pink"],
    ];
    $("#params").innerHTML = rows.map(([k, s, v, cls]) => `<div class="param"><div class="param-k">${k}<small>${s}</small></div><div class="param-v ${cls}">${v}</div></div>`).join("");
  }

  /* ---------- suspects + dossier ---------- */
  function renderSuspects({ D, F, players, flagged }) {
    const list = $("#suspect-list");
    const maxScore = flagged[0]?.anomaly_score || 1;
    $("#suspect-count").textContent = `${flagged.length} flagged`;
    let trailAnim, current, radarRedraw;
    redraws.push(() => { radarRedraw && radarRedraw(); if (current) playTrail(players.find((x) => x.player_id === current)); });

    const draw = (filter) => {
      list.innerHTML = "";
      flagged.filter((p) => filter === "all" || p.tier === filter).forEach((p) => {
        const i = flagged.indexOf(p);
        const b = el("button", "suspect");
        b.setAttribute("role", "option");
        b.dataset.id = p.player_id;
        b.innerHTML = `
          <span class="s-rank">${String(i + 1).padStart(2, "0")}</span>
          <span><span class="s-id">${p.player_id}</span> <span class="tier tier-${p.tier}">${p.tier}</span>
            <div class="s-reason">${FEAT_INFO[p.top_reason][0]} · ${p.anomaly_type}</div>
            <div class="s-bar"><div style="width:${(p.anomaly_score / maxScore) * 100}%;background:${TIER_COLOR[p.tier]};box-shadow:0 0 8px ${TIER_COLOR[p.tier]}"></div></div></span>
          <span class="s-score" style="color:${TIER_COLOR[p.tier]}">${p.anomaly_score.toFixed(2)}</span>`;
        b.addEventListener("click", () => select(p.player_id));
        list.append(b);
      });
      if (current) $$(".suspect", list).forEach((x) => x.classList.toggle("active", x.dataset.id === current));
    };
    $$("#filters button").forEach((b) => b.addEventListener("click", () => {
      $$("#filters button").forEach((x) => x.classList.toggle("active", x === b));
      draw(b.dataset.f);
    }));

    function select(id) {
      const p = players.find((x) => x.player_id === id);
      if (!p) return;
      current = id;
      $$(".suspect", list).forEach((x) => x.classList.toggle("active", x.dataset.id === id));
      const col = TIER_COLOR[p.tier];
      $("#d-name").textContent = p.player_id;
      const correct = p.true_label !== "human";
      $("#d-badges").innerHTML = `
        <span class="tier tier-${p.tier}">${p.tier} risk</span>
        <span class="tier" style="color:${C.muted};border:1px solid rgba(255,255,255,.14)">${p.anomaly_type}</span>
        <span class="tier" style="color:${TYPE_COLOR[p.true_label]};border:1px solid ${TYPE_COLOR[p.true_label]}55">truth: ${p.true_label}</span>`;

      // score ring
      const R = 44, L = 2 * Math.PI * R, frac = Math.min(p.anomaly_score / maxScore, 1);
      $("#d-ring").innerHTML = `<svg viewBox="0 0 104 104"><circle cx="52" cy="52" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="7"/>
        <circle class="ring-arc" cx="52" cy="52" r="${R}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${L}" style="filter:drop-shadow(0 0 6px ${col})"/></svg>
        <div class="ring-txt"><b style="color:${col}">${p.anomaly_score.toFixed(2)}</b><span>SCORE</span></div>`;
      requestAnimationFrame(() => requestAnimationFrame(() => { const a = $("#d-ring .ring-arc"); if (a) a.style.strokeDashoffset = L * (1 - frac); }));

      // radar
      const labels = F.map((f) => FEAT_INFO[f][0]);
      const vals = F.map((f) => Math.abs(p.z[f]));
      const normals = players.filter((x) => !x.is_anomaly);
      const normalAvg = F.map((f) => normals.reduce((a, x) => a + Math.abs(x.z[f]), 0) / normals.length);
      const maxV = Math.max(4, Math.min(8, Math.ceil(Math.max(...vals))));
      const drawR = () => drawRadar($("#radar"), labels, [
        { vals: normalAvg, color: C.cyan, dash: true, fillOp: 0.06, name: "avg normal" },
        { vals, color: col, dash: false, fillOp: 0.2, name: p.player_id },
      ], maxV);
      drawR(); radarRedraw = drawR;

      // verdict
      const f = p.top_reason, z = p.z[f], [fname] = FEAT_INFO[f];
      const dir = z >= 0 ? "above" : "below";
      const raw = p[f], avg = D.players.filter((x) => !x.is_anomaly).reduce((a, x) => a + x[f], 0) / D.players.filter((x) => !x.is_anomaly).length;
      const how = p.anomaly_type === "noise" ? "sits outside every dense region (DBSCAN noise)" : "belongs to a tiny micro-cluster of look-alike players";
      $("#d-verdict").innerHTML = `This player ${how}. Strongest signal: <b>${fname}</b> = <b>${raw.toFixed(2)}</b> vs. a normal average of ${avg.toFixed(2)} — <b>${Math.abs(z).toFixed(1)}σ ${dir}</b> the population mean.
        ${correct ? `<br><span style="color:${C.green}">✓ Confirmed by ground truth: <b>${p.true_label}</b>.</span>`
                  : `<br><span style="color:${C.amber}">⚠ False positive — this is an honest, highly skilled player. Score ${p.anomaly_score.toFixed(2)} puts them in the <b>review</b> tier, not auto-ban.</span>`}`;

      // trail replay
      playTrail(p);
    }

    function playTrail(p) {
      const cv = $("#trail");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = cv.clientWidth || 300;
      cv.width = size * dpr; cv.height = size * dpr;
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pts = D.trajectories[p.player_id] || [];
      const mates = players.filter((x) => x.match_id === p.match_id && x.player_id !== p.player_id);
      const pad = 14, s = (size - pad * 2) / 1000;
      const X = (v) => pad + v * s, Y = (v) => pad + (1000 - v) * s;
      const col = TIER_COLOR[p.tier];
      cancelAnimationFrame(trailAnim);
      let i = 0;
      const frame = () => {
        g.clearRect(0, 0, size, size);
        // grid
        g.strokeStyle = "rgba(255,255,255,0.04)"; g.lineWidth = 1;
        for (let k = 0; k <= 10; k++) { const q = pad + k * (size - pad * 2) / 10; g.beginPath(); g.moveTo(q, pad); g.lineTo(q, size - pad); g.moveTo(pad, q); g.lineTo(size - pad, q); g.stroke(); }
        // teammates
        mates.forEach((m) => {
          const t = D.trajectories[m.player_id]; if (!t) return;
          g.beginPath(); t.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
          g.strokeStyle = m.is_anomaly ? "rgba(255,61,129,0.18)" : "rgba(110,243,255,0.12)"; g.lineWidth = 1; g.stroke();
        });
        // suspect path
        const n = Math.min(Math.floor(i), pts.length);
        if (n > 1) {
          g.shadowColor = col; g.shadowBlur = 12;
          g.beginPath(); for (let k = 0; k < n; k++) { const [x, y] = pts[k]; k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); }
          g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = "round"; g.stroke();
          const [hx, hy] = pts[n - 1];
          g.beginPath(); g.arc(X(hx), Y(hy), 4.5, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
          g.shadowBlur = 0;
          g.beginPath(); g.arc(X(hx), Y(hy), 10 + 4 * Math.sin(performance.now() / 180), 0, Math.PI * 2); g.strokeStyle = col + "88"; g.lineWidth = 1.2; g.stroke();
        }
        g.fillStyle = C.dim; g.font = "10px JetBrains Mono"; g.fillText(`${p.match_id} · ${mates.length + 1} players`, pad + 4, size - pad - 6);
        i += REDUCED ? pts.length : 0.9;
        if (i < pts.length + 1 || !REDUCED) trailAnim = requestAnimationFrame(frame);
      };
      frame();
    }

    $("#replay").addEventListener("click", () => current && playTrail(players.find((x) => x.player_id === current)));
    selectPlayer = select;
    draw("all");
    onReveal($("#dossier"), () => flagged[0] && select(flagged[0].player_id));
  }

  /* ---------- evaluation ---------- */
  function renderEval({ D, players, flagged }) {
    const m = D.metrics, cm = m.confusion;
    const rings = [
      ["Precision", m.precision, C.violet, `${cm.tp} of ${cm.tp + cm.fp} flags are cheaters`],
      ["Recall", m.recall, C.pink, `${cm.tp} of ${cm.tp + cm.fn} cheaters caught`],
      ["F1 score", m.f1, C.cyan, "harmonic mean of P & R"],
      ["Accuracy", m.accuracy, C.green, `${cm.tp + cm.tn} of ${players.length} correct`],
    ];
    const box = $("#rings");
    rings.forEach(([label, v, col, sub]) => {
      const R = 36, L = 2 * Math.PI * R;
      const card = el("div", "ring-card");
      card.innerHTML = `<svg viewBox="0 0 86 86"><circle cx="43" cy="43" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="6"/>
        <circle class="ring-arc" cx="43" cy="43" r="${R}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${L}" style="filter:drop-shadow(0 0 6px ${col})"/></svg>
        <div><div class="rc-val" style="color:${col}">0%</div><div class="rc-label">${label}</div><div class="rc-sub">${sub}</div></div>`;
      box.append(card);
    });
    onReveal(box, () => $$(".ring-card", box).forEach((c, i) => {
      const v = rings[i][1], R = 36, L = 2 * Math.PI * R;
      $(".ring-arc", c).style.strokeDashoffset = L * (1 - v);
      countUp($(".rc-val", c), v * 100, { dec: 1, suffix: "%" });
    }));

    $("#cm").innerHTML = `
      <div></div><div class="h">Predicted<br>normal</div><div class="h">Predicted<br>cheater</div>
      <div class="h row">Actual<br>human</div>
      <div class="cell tn"><b>${cm.tn}</b><span>true negatives · correctly cleared</span></div>
      <div class="cell fp"><b>${cm.fp}</b><span>false positives · honest but flagged</span></div>
      <div class="h row">Actual<br>cheater</div>
      <div class="cell fn"><b>${cm.fn}</b><span>false negatives · missed cheaters</span></div>
      <div class="cell tp"><b>${cm.tp}</b><span>true positives · cheaters caught</span></div>`;

    const pt = $("#per-type");
    Object.entries(m.per_type_recall).forEach(([t, r]) => {
      const total = players.filter((p) => p.true_label === t).length;
      const caught = players.filter((p) => p.true_label === t && p.is_anomaly).length;
      const row = el("div", "type-row");
      row.innerHTML = `<div class="type-head"><span>${t}</span><span class="mono">${caught}/${total} · ${pct(r)}</span></div>
        <div class="type-track"><div class="type-fill" data-w="${r * 100}%" style="background:${TYPE_COLOR[t]};box-shadow:0 0 12px ${TYPE_COLOR[t]}"></div></div>
        <div class="type-desc">${TYPE_DESC[t] || ""}</div>`;
      pt.append(row);
    });
    onReveal(pt.closest(".card"), () => $$(".type-fill", pt).forEach((f) => (f.style.width = f.dataset.w)));

    // insight
    const fps = players.filter((p) => p.is_anomaly && p.true_label === "human");
    const cheaters = players.filter((p) => p.true_label !== "human");
    const minCheat = Math.min(...cheaters.map((p) => p.anomaly_score));
    const fpMin = fps.length ? Math.min(...fps.map((p) => p.anomaly_score)) : 0;
    const fpMax = fps.length ? Math.max(...fps.map((p) => p.anomaly_score)) : 0;
    $("#insight").innerHTML = `<div class="big">${cm.fn === 0 ? "0" : cm.fn}<div style="font-size:13px;font-family:var(--mono);letter-spacing:.12em;margin-top:8px;-webkit-text-fill-color:${C.muted}">MISSED</div></div>
      <div><h3>Interpretation</h3><p>DBSCAN caught every cheater without ever seeing a label.
      ${fps.length ? `The ${fps.length} false positive${fps.length > 1 ? "s are" : " is"} honest, highly skilled players with scores between <b>${fpMin.toFixed(2)}</b> and <b>${fpMax.toFixed(2)}</b> — only just past the normal boundary of 1.0. ` : ""}
      Every real cheater scored <b>≥ ${minCheat.toFixed(2)}</b>. That gap justifies a three-tier policy: <b style="color:${C.amber}">review</b> (1.0–1.8) goes to a human moderator, while <b style="color:${C.violet}">high</b> and <b style="color:${C.pink}">critical</b> (≥ 1.8) are near-certain cheats.</p></div>`;
  }

  /* ---------- conclusion ---------- */
  function renderConclusion({ D, flagged }) {
    const m = D.metrics;
    $("#concl-text").innerHTML = `Density-based clustering separates honest play from cheating without labels. On ${fmt(D.dataset.rows)} telemetry ticks from ${D.dataset.players} players, DBSCAN (ε = ${D.model.eps.toFixed(2)}, min_samples = ${D.model.min_samples}) flagged ${flagged.length} players, achieving <b>${pct(m.recall)} recall</b>, <b>${pct(m.precision)} precision</b> and an <b>F1 of ${m.f1.toFixed(2)}</b>. Treating small clusters as suspicious lets it catch coordinated cheaters who share one tool, not only lone outliers.`;
  }

  /* ---------- hero arena ---------- */
  function startArena({ D, players }) {
    const cv = $("#arena"), g = cv.getContext("2d");
    let W, H, dpr, ox, oy, s;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
      s = Math.max(W, H) / 1000 * 1.02; ox = (W - 1000 * s) / 2 + W * 0.12; oy = (H - 1000 * s) / 2;
    };
    resize(); window.addEventListener("resize", resize);
    const X = (v) => ox + v * s, Y = (v) => oy + (1000 - v) * s;
    const runners = players.map((p) => ({ p, t: D.trajectories[p.player_id] || [], off: Math.random() * 100 }));
    $("#arena-caption").textContent = `LIVE ARENA · ${D.dataset.matches} MATCHES OVERLAID`;
    const TAIL = 22;
    let t = 0, visible = true;
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(cv);

    const frame = () => {
      if (visible) {
        g.clearRect(0, 0, W, H);
        // grid
        g.strokeStyle = "rgba(255,255,255,0.035)"; g.lineWidth = 1;
        const gs = 1000 / 20;
        for (let k = 0; k <= 20; k++) {
          g.beginPath(); g.moveTo(X(k * gs), Y(0)); g.lineTo(X(k * gs), Y(1000)); g.stroke();
          g.beginPath(); g.moveTo(X(0), Y(k * gs)); g.lineTo(X(1000), Y(k * gs)); g.stroke();
        }
        runners.forEach(({ p, t: pts, off }) => {
          if (pts.length < 2) return;
          const n = pts.length;
          const head = (t * 0.35 + off) % (n + 30);
          const hi = Math.min(Math.floor(head), n - 1);
          const lo = Math.max(0, hi - TAIL);
          const flag = p.is_anomaly;
          // faint full path
          g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
          g.strokeStyle = flag ? "rgba(255,61,129,0.10)" : "rgba(110,243,255,0.045)"; g.lineWidth = 1; g.stroke();
          if (head > n) return;
          // bright tail
          for (let k = lo + 1; k <= hi; k++) {
            const a = (k - lo) / TAIL;
            g.beginPath(); g.moveTo(X(pts[k - 1][0]), Y(pts[k - 1][1])); g.lineTo(X(pts[k][0]), Y(pts[k][1]));
            g.strokeStyle = flag ? `rgba(255,61,129,${a * 0.9})` : `rgba(110,243,255,${a * 0.55})`;
            g.lineWidth = flag ? 2 : 1.3; g.stroke();
          }
          const [hx, hy] = pts[hi];
          if (flag) {
            g.shadowColor = C.pink; g.shadowBlur = 16;
            g.beginPath(); g.arc(X(hx), Y(hy), 3.6, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
            g.shadowBlur = 0;
            const r = 9 + 5 * Math.sin(t / 10 + off);
            g.beginPath(); g.arc(X(hx), Y(hy), r, 0, Math.PI * 2); g.strokeStyle = "rgba(255,61,129,0.55)"; g.lineWidth = 1; g.stroke();
            g.fillStyle = "rgba(255,61,129,0.85)"; g.font = "10px JetBrains Mono";
            g.fillText(p.player_id, X(hx) + 12, Y(hy) - 8);
          } else {
            g.beginPath(); g.arc(X(hx), Y(hy), 2, 0, Math.PI * 2); g.fillStyle = "rgba(110,243,255,0.9)"; g.fill();
          }
        });
        t += 1;
      }
      if (!REDUCED) requestAnimationFrame(frame);
    };
    t = REDUCED ? 60 : 0;
    frame();
  }

  /* ---------- nav ---------- */
  function navBehaviour() {
    const nav = $("#nav");
    const links = $$(".nav-links a");
    const secs = links.map((a) => $(a.getAttribute("href")));
    const onScroll = () => {
      nav.classList.toggle("scrolled", window.scrollY > 40);
      let cur = -1;
      secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top < window.innerHeight * 0.4) cur = i; });
      links.forEach((a, i) => a.classList.toggle("active", i === cur));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
