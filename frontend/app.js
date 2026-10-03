/* =========================================================
   Spectator — front-end
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
    renderScanner(ctx);
    renderChallenge(ctx);
    renderTheatre(ctx);
    renderLab(ctx);
    renderBench(ctx);
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

  /* =========================================================
     LIVE SCANNER  (talks to the Flask backend + SQLite)
     ========================================================= */
  const API = (window.Spectator_API || "").replace(/\/$/, "");
  const TIER_META = {
    clean:    { label: "CLEAN",          color: C.green,  text: "Behaviour sits inside the dense core of honest players. No action needed." },
    review:   { label: "UNDER REVIEW",   color: C.amber,  text: "Just outside normal behaviour — could be a very skilled player. Sent to a human moderator." },
    high:     { label: "HIGH RISK",      color: C.violet, text: "Far outside every dense region of honest play — very likely assisted." },
    critical: { label: "CHEAT DETECTED", color: C.pink,   text: "Extreme deviation from every honest player — near-certain cheat." },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
    return j;
  }
  let backendOnline = false;
  const fv = (x) => (Math.abs(x) >= 10 ? (+x).toFixed(1) : (+x).toFixed(3));

  function renderScanner({ D, players, F }) {
    const status = $("#api-status"), form = $("#scan-form"), btn = $("#scan-btn"), out = $("#scan-result");
    const tagIn = $("#f-tag"), matchIn = $("#f-match"), err = $("#form-error");
    let mode = "stats", file = null;

    // ---- slider ranges & presets from the reference population (same data the backend trains on)
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const RANGE = {}, DEF = {};
    F.forEach((f) => {
      const v = players.map((p) => p[f]); const lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.15;
      RANGE[f] = ["hit_rate", "headshot_rate", "path_straightness"].includes(f) ? [0, 1] : [Math.max(0, lo - pad), hi + pad];
      DEF[f] = med(v);
    });
    const groupMed = (fn) => { const g = players.filter(fn); const o = {}; F.forEach((f) => (o[f] = med(g.map((p) => p[f])))); return g.length ? o : null; };
    const humans = players.filter((p) => p.true_label === "human");
    const pros = [...humans].filter((p) => !p.is_anomaly).sort((a, b) => b.hit_rate - a.hit_rate).slice(0, 15);
    const PRESETS = [
      ["Casual player", C.cyan, groupMed((p) => p.true_label === "human")],
      ["Pro player", C.green, pros.length ? groupMed((p) => pros.includes(p)) : null],
      ["Aimbot", C.pink, groupMed((p) => p.true_label === "aimbot")],
      ["Speedhack", C.amber, groupMed((p) => p.true_label === "speedhack")],
      ["Triggerbot", C.violet, groupMed((p) => p.true_label === "triggerbot")],
    ].filter((x) => x[2]);

    // ---- sliders
    const box = $("#sliders");
    const decimals = (f) => (RANGE[f][1] - RANGE[f][0] > 20 ? 1 : 3);
    F.forEach((f) => {
      const [lo, hi] = RANGE[f];
      const row = el("div", "sl");
      row.innerHTML = `<div class="sl-top"><span>${FEAT_INFO[f][0]} <small>${f}</small></span><input type="number" step="any" data-f="${f}" aria-label="${FEAT_INFO[f][0]} value"></div>
        <input type="range" min="${lo}" max="${hi}" step="${(hi - lo) / 400}" data-f="${f}" aria-label="${FEAT_INFO[f][0]}">`;
      box.append(row);
    });
    const setVal = (f, v) => {
      const r = $(`input[type=range][data-f="${f}"]`, box), n = $(`input[type=number][data-f="${f}"]`, box);
      const [lo, hi] = RANGE[f];
      r.value = Math.min(hi, Math.max(lo, v));
      n.value = (+v).toFixed(decimals(f));
      r.style.setProperty("--p", `${((r.value - lo) / (hi - lo)) * 100}%`);
      const z = (v - ctxStats[f].m) / ctxStats[f].s;
      r.closest(".sl").classList.toggle("hot", Math.abs(z) > 2);
    };
    const ctxStats = {};
    F.forEach((f) => { const v = players.map((p) => p[f]); const m = v.reduce((a, b) => a + b, 0) / v.length; ctxStats[f] = { m, s: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1 }; });
    const getVals = () => { const o = {}; F.forEach((f) => (o[f] = parseFloat($(`input[type=number][data-f="${f}"]`, box).value))); return o; };
    box.addEventListener("input", (e) => {
      const f = e.target.dataset.f; if (!f) return;
      $$("#presets .chip").forEach((c) => c.classList.remove("active"));
      if (e.target.type === "range") setVal(f, +e.target.value);
      else { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { const r = $(`input[type=range][data-f="${f}"]`, box); r.value = v; r.style.setProperty("--p", `${((Math.min(RANGE[f][1], Math.max(RANGE[f][0], v)) - RANGE[f][0]) / (RANGE[f][1] - RANGE[f][0])) * 100}%`); } }
    });
    F.forEach((f) => setVal(f, DEF[f]));

    // ---- presets
    const pbox = $("#presets");
    PRESETS.forEach(([name, color, vals]) => {
      const b = el("button", "chip", `<i style="background:${color};box-shadow:0 0 8px ${color}"></i>${name}`);
      b.type = "button"; b.style.color = color;
      b.addEventListener("click", () => {
        F.forEach((f) => setVal(f, vals[f]));
        $$(".chip", pbox).forEach((c) => c.classList.toggle("active", c === b));
        if (!tagIn.value.trim()) tagIn.value = { "Casual player": "Casual_Carl", "Pro player": "ProAim_Priya", Aimbot: "xX_H3adsh0t_Xx", Speedhack: "ZoomZoom99", Triggerbot: "InstaReact" }[name] || name;
      });
      pbox.append(b);
    });

    // ---- tabs + upload
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.tab;
      $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
      $("#pane-stats").hidden = mode !== "stats"; $("#pane-upload").hidden = mode !== "upload";
    }));
    const fi = $("#f-file"), drop = $("#drop");
    fi.addEventListener("change", () => {
      file = fi.files[0] || null;
      $("#drop-text").textContent = file ? `✓ ${file.name}` : "Drop a telemetry .csv here or click to browse";
      drop.classList.toggle("has", !!file);
    });
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) { fi.files = e.dataTransfer.files; fi.dispatchEvent(new Event("change")); } });

    // ---- backend status
    const setStatus = (ok, html) => { status.className = `api-status ${ok ? "ok" : "off"}`; $("span", status).innerHTML = html; btn.disabled = !ok; };
    const check = () => api("/api/health").then((h) => {
      backendOnline = true;
      setStatus(true, `Backend online · Flask + DBSCAN · <b>${h.scans_saved}</b> scan${h.scans_saved === 1 ? "" : "s"} in database`);
      loadHistory();
    }).catch(() => {
      backendOnline = false;
      setStatus(false, `Backend offline — run <code>python backend/app.py</code> and open <code>localhost:5000</code>`);
    });
    check();

    // ---- submit
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = ""; tagIn.classList.remove("invalid");
      const tag = tagIn.value.trim(), match = matchIn.value.trim();
      if (!/^[A-Za-z0-9_.\- ]{2,24}$/.test(tag)) { tagIn.classList.add("invalid"); err.textContent = "Enter a gamertag (2–24 characters: letters, numbers, space, _ . -)."; tagIn.focus(); return; }
      let req;
      if (mode === "upload") {
        if (!file) { err.textContent = "Choose a telemetry .csv file first — or download a sample below."; return; }
        const fd = new FormData(); fd.append("gamertag", tag); fd.append("match_id", match); fd.append("file", file);
        req = api("/api/scan/upload", { method: "POST", body: fd });
      } else {
        const vals = getVals();
        const bad = F.find((f) => !Number.isFinite(vals[f]) || vals[f] < 0);
        if (bad) { err.textContent = `“${FEAT_INFO[bad][0]}” needs a positive number.`; return; }
        req = api("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gamertag: tag, match_id: match, features: vals }) });
      }
      btn.disabled = true; $(".scan-btn-txt", btn).textContent = "Scanning…";
      showScanning(D);
      try {
        const [res] = await Promise.all([req, new Promise((r) => setTimeout(r, REDUCED ? 0 : 2100))]);
        showResult(res, D, players);
        loadHistory(res.id);
        api("/api/health").then((h) => setStatus(true, `Backend online · Flask + DBSCAN · <b>${h.scans_saved}</b> scan${h.scans_saved === 1 ? "" : "s"} in database`)).catch(() => {});
      } catch (ex) {
        out.innerHTML = `<div class="sr-idle"><div class="radar"><i></i><i></i><i></i><b></b></div><h3>Scan failed</h3><p class="muted">${esc(ex.message)}</p></div>`;
        if (!backendOnline) check();
      } finally {
        btn.disabled = !backendOnline; $(".scan-btn-txt", btn).textContent = "Run Spectator scan";
      }
    });

    function showScanning(D) {
      const lines = [
        `POST ${mode === "upload" ? "/api/scan/upload" : "/api/scan"}`,
        mode === "upload" ? "parsing telemetry · extracting 10 features" : "validating 10 behavioural features",
        "standardising with population μ / σ",
        `searching normal core points · ε = ${D.model.eps.toFixed(3)}`,
        "computing anomaly score = distance ÷ ε",
        "INSERT INTO scans → Spectator.db",
      ];
      out.innerHTML = `<div class="sr-scanning"><div class="radar"><i></i><i></i><i></i><b></b></div><div class="term">${lines.map((l, i) => `<div style="animation-delay:${i * 0.32}s" class="${i < lines.length ? "ok" : ""}">${l}</div>`).join("")}</div></div>`;
    }

    function showResult(r, D, players) {
      const meta = TIER_META[r.tier] || TIER_META.review;
      const col = meta.color, R = 44, L = 2 * Math.PI * R;
      const frac = Math.min(r.score / 6, 1);
      const clean = r.tier === "clean";
      out.innerHTML = `<div class="sr-done">
        <div class="sr-top">
          <div><span class="mono muted small">SCAN #${r.id} · SAVED TO DATABASE</span>
            <div class="verdict-label" style="color:${col};text-shadow:0 0 30px ${col}66">${meta.label}</div>
            <h3>${esc(r.gamertag)}</h3>
            <div class="sr-meta">${r.match_id ? esc(r.match_id) + " · " : ""}${esc(r.source)}</div></div>
          <div class="score-ring"><svg viewBox="0 0 104 104"><circle cx="52" cy="52" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="7"/>
            <circle class="ring-arc" cx="52" cy="52" r="${R}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${L}" style="filter:drop-shadow(0 0 6px ${col})"/></svg>
            <div class="ring-txt"><b style="color:${col}">${r.score.toFixed(2)}</b><span>SCORE</span></div></div>
        </div>
        <p class="sr-text">${meta.text} ${clean ? `Score ${r.score.toFixed(2)} ≤ 1.0 means this player is within ε of an honest core player.` : `Score ${r.score.toFixed(2)} means the nearest honest core player is <b>${r.score.toFixed(1)}×</b> further away than DBSCAN's ε.`}</p>
        <div><div class="mini-title">${clean ? "Largest deviations · all within normal play" : "Why Spectator flagged this player"}</div>
          ${r.reasons.map((x) => { const zc = Math.abs(x.z) > 2 ? col : C.cyan; return `<div class="reason"><b>${x.label}</b><span class="rz" style="color:${zc}">${x.z >= 0 ? "+" : ""}${x.z.toFixed(1)}σ</span>
            <div class="rbar"><div data-w="${Math.min(Math.abs(x.z) / 6, 1) * 100}%" style="background:${zc};box-shadow:0 0 8px ${zc}"></div></div>
            <p>${clean ? "" : "This player " + esc(x.text) + " · "}value <b>${fv(x.value)}</b> vs normal ${fv(x.normal)}</p></div>`; }).join("")}
        </div>
        <div><div class="mini-title">Position among ${players.length} reference players</div><div class="sr-map" id="sr-map"></div></div>
      </div>`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const a = $(".ring-arc", out); if (a) a.style.strokeDashoffset = L * (1 - frac);
        $$(".rbar div", out).forEach((b) => (b.style.width = b.dataset.w));
      }));
      drawMiniMap($("#sr-map"), players, r, col);
    }

    function drawMiniMap(host, players, r, col) {
      host.innerHTML = "";
      const W = host.clientWidth, H = host.clientHeight, pad = 18;
      const xs0 = players.map((p) => p.pca_x).concat(r.pca[0]), ys0 = players.map((p) => p.pca_y).concat(r.pca[1]);
      const [x0, x1] = [Math.min(...xs0), Math.max(...xs0)], [y0, y1] = [Math.min(...ys0), Math.max(...ys0)];
      const X = (v) => pad + ((v - x0) / (x1 - x0 || 1)) * (W - pad * 2), Y = (v) => H - pad - ((v - y0) / (y1 - y0 || 1)) * (H - pad * 2);
      const svg = S("svg", { width: W, height: H, class: "chart" }, host);
      players.forEach((p) => S("circle", { cx: X(p.pca_x), cy: Y(p.pca_y), r: p.is_anomaly ? 2.6 : 2, fill: p.is_anomaly ? C.pink : C.cyan, opacity: p.is_anomaly ? 0.45 : 0.35 }, svg));
      const cx = X(r.pca[0]), cy = Y(r.pca[1]);
      S("circle", { cx, cy, r: 14, fill: "none", stroke: col, class: "pulse-ring" }, svg);
      S("circle", { cx, cy, r: 6, fill: col, stroke: "#fff", "stroke-width": 2 }, svg);
      const t = S("text", { x: cx + (cx > W - 110 ? -12 : 12), y: cy - 10, "text-anchor": cx > W - 110 ? "end" : "start", class: "tick", style: `fill:${C.text}` }, svg);
      t.textContent = r.gamertag;
    }

    // ---- history table (from the database)
    const tbody = $("#scan-table tbody");
    function loadHistory(freshId) {
      api("/api/scans?limit=50").then((rows) => {
        $("#db-count").textContent = `· ${rows.length} record${rows.length === 1 ? "" : "s"}`;
        if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted empty">No scans yet — run your first scan above.</td></tr>`; return; }
        tbody.innerHTML = rows.map((s) => {
          const m = TIER_META[s.tier] || TIER_META.review;
          const t = new Date(s.created_at);
          return `<tr class="${s.id === freshId ? "fresh" : ""}"><td class="mono muted">${s.id}</td>
            <td class="mono muted">${t.toLocaleDateString([], { day: "2-digit", month: "short" })} ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
            <td class="mono">${esc(s.gamertag)}</td><td class="mono muted">${esc(s.match_id || "—")}</td><td class="muted">${esc(s.source)}</td>
            <td class="mono" style="color:${m.color}">${s.score.toFixed(2)}</td>
            <td><span class="tier" style="color:${m.color};border:1px solid ${m.color}55;background:${m.color}14">${m.label}</span></td></tr>`;
        }).join("");
      }).catch(() => {});
    }
    $("#db-refresh").addEventListener("click", () => loadHistory());
    $("#db-clear").addEventListener("click", () => {
      if (!backendOnline || !confirm("Delete all saved scans from the database?")) return;
      api("/api/scans", { method: "DELETE" }).then(() => { loadHistory(); check(); }).catch(() => {});
    });
  }

  /* ---------- parameter lab ---------- */
  function renderLab({ D, players }) {
    const S0 = D.sensitivity; if (!S0) { $("#lab").remove(); return; }
    const eG = S0.eps_grid, mG = S0.min_samples_grid;
    const find = (e, m) => S0.runs.find((r) => r.min_samples === m && Math.abs(r.eps - e) < 1e-6);
    const kneeEps = D.model.eps, defMs = D.model.min_samples;
    const nearestIdx = (v) => eG.reduce((b, e, i) => (Math.abs(e - v) < Math.abs(eG[b] - v) ? i : b), 0);
    let ei = nearestIdx(kneeEps), ms = mG.includes(defMs) ? defMs : mG[0];
    const range = $("#lab-eps"); range.max = eG.length - 1; range.value = ei;
    $("#lab-tag").textContent = `${S0.runs.length} DBSCAN runs`;
    const seg = $("#lab-ms");
    mG.forEach((m) => { const b = el("button", m === ms ? "active" : "", m); b.type = "button"; b.addEventListener("click", () => { ms = m; $$("button", seg).forEach((x) => x.classList.toggle("active", x === b)); update(); }); seg.append(b); });
    const best = S0.runs.filter((r) => r.min_samples === defMs).reduce((a, b) => (b.f1 > a.f1 ? b : a));
    $("#lab-knee").addEventListener("click", () => { ms = defMs; $$("button", seg).forEach((x) => x.classList.toggle("active", +x.textContent === ms)); ei = nearestIdx(kneeEps); range.value = ei; update(); });
    $("#lab-best").addEventListener("click", () => { ms = best.min_samples; $$("button", seg).forEach((x) => x.classList.toggle("active", +x.textContent === ms)); ei = nearestIdx(best.eps); range.value = ei; update(); });
    range.addEventListener("input", () => { ei = +range.value; update(); });

    let curveHost = $("#lab-curve"), mapHost = $("#lab-map"), mapMarks = null;
    function drawCurve() {
      const f = frame(curveHost, { t: 14, r: 12, b: 40, l: 40 }); const { svg, m, iw, ih } = f;
      const runs = S0.runs.filter((r) => r.min_samples === ms);
      const xs = (v) => ((v - eG[0]) / (eG[eG.length - 1] - eG[0])) * iw, ys = (v) => ih - v * ih;
      axes(f, xs, ys, { xTicks: niceTicks(eG[0], eG[eG.length - 1], 6), yTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: "ε", yFmt: (v) => v.toFixed(2), xFmt: (v) => v.toFixed(1) });
      const g = S("g", { transform: `translate(${m.l},${m.t})` }, svg);
      [["precision", C.violet, 1.6], ["recall", C.pink, 1.6], ["f1", C.cyan, 2.6]].forEach(([k, c, w]) => {
        S("path", { d: runs.map((r, i) => `${i ? "L" : "M"}${xs(r.eps).toFixed(1)},${ys(r[k]).toFixed(1)}`).join(""), fill: "none", stroke: c, "stroke-width": w, "stroke-linejoin": "round" }, g);
      });
      const kx = xs(kneeEps);
      S("line", { x1: kx, x2: kx, y1: 0, y2: ih, stroke: "rgba(255,255,255,.35)", "stroke-dasharray": "3 4" }, g);
      S("text", { x: kx + 5, y: ih - 6, class: "tick" }, g).textContent = "knee";
      const cur = find(eG[ei], ms), cx = xs(eG[ei]);
      S("line", { x1: cx, x2: cx, y1: 0, y2: ih, stroke: C.text, "stroke-width": 1.2 }, g);
      S("circle", { cx, cy: ys(cur.f1), r: 5.5, fill: C.cyan, stroke: "#fff", "stroke-width": 2 }, g);
    }
    function drawMap() {
      mapHost.innerHTML = "";
      const W = mapHost.clientWidth, H = mapHost.clientHeight, pad = 16;
      const svg = S("svg", { width: W, height: H, class: "chart" }, mapHost);
      const xs0 = players.map((p) => p.pca_x), ys0 = players.map((p) => p.pca_y);
      const [x0, x1, y0, y1] = [Math.min(...xs0), Math.max(...xs0), Math.min(...ys0), Math.max(...ys0)];
      S("rect", { x: 0, y: 0, width: W, height: H, rx: 14, fill: "rgba(0,0,0,.25)", stroke: "rgba(255,255,255,.08)" }, svg);
      mapMarks = players.map((p) => {
        const c = S("circle", { cx: pad + ((p.pca_x - x0) / (x1 - x0)) * (W - pad * 2), cy: H - pad - ((p.pca_y - y0) / (y1 - y0)) * (H - pad * 2), r: 3.4, class: "pt" }, svg);
        c.addEventListener("mousemove", (e) => tip.show(`<b>${p.player_id}</b><br>truth: ${p.true_label}`, e)); c.addEventListener("mouseleave", tip.hide);
        return c;
      });
    }
    function paintMap(run) {
      const flagged = new Set(run.anomalies);
      mapMarks.forEach((c, i) => {
        const p = players[i], fl = flagged.has(i), cheat = p.true_label !== "human";
        const col = fl ? (cheat ? C.pink : C.amber) : cheat ? "#fff" : C.cyan;
        c.style.fill = fl || cheat ? col : C.cyan; c.style.fillOpacity = fl ? 0.95 : cheat ? 0.9 : 0.4;
        c.setAttribute("r", fl ? 5 : cheat ? 4.5 : 3.2);
        c.style.stroke = !fl && cheat ? C.pink : "none"; c.style.strokeWidth = 1.5;
      });
    }
    function update() {
      const run = find(eG[ei], ms);
      $("#lab-eps-v").textContent = eG[ei].toFixed(2);
      range.style.setProperty("--p", `${(ei / (eG.length - 1)) * 100}%`);
      const cheats = players.filter((p) => p.true_label !== "human").length;
      const caught = run.anomalies.filter((i) => players[i].true_label !== "human").length;
      const fp = run.flagged - caught;
      $("#lab-metrics").innerHTML = [["F1", run.f1.toFixed(2), C.cyan], ["Precision", run.precision.toFixed(2), C.violet], ["Recall", run.recall.toFixed(2), C.pink],
        ["Flagged", run.flagged, C.text], ["False +", fp, fp ? C.amber : C.green], ["Missed", cheats - caught, cheats - caught ? C.pink : C.green]]
        .map(([k, v, c]) => `<div class="lm"><b style="color:${c}">${v}</b><span>${k}</span></div>`).join("");
      const isKnee = Math.abs(eG[ei] - kneeEps) < 0.051 && ms === defMs;
      $("#lab-note").innerHTML = eG[ei] < 1.2 ? "ε too small: almost nobody has enough neighbours, so <b>everyone</b> looks like noise."
        : eG[ei] > 3.5 ? "ε too large: cheaters get swallowed into the normal cluster and are <b>missed</b>."
        : isKnee ? "This is the ε chosen <b>without labels</b> by the k-distance knee — the honest choice."
        : Math.abs(eG[ei] - best.eps) < 0.051 && ms === best.min_samples ? "Best F1 on this data — but picking ε with the answers in hand is <b>data leakage</b>. The knee method needs no labels."
        : `${run.clusters} normal cluster${run.clusters === 1 ? "" : "s"} · ${run.flagged} players outside dense regions.`;
      drawCurve(); if (!mapMarks) drawMap(); paintMap(run);
    }
    onReveal($("#lab"), () => { update(); redraws.push(() => { mapMarks = null; update(); }); });
  }

  /* ---------- benchmark ---------- */
  function renderBench({ D }) {
    const B = D.benchmark; if (!B) { $("#bench").remove(); return; }
    const rates = Object.keys(B[0].by_rate);
    const RC = [C.amber, C.cyan, C.violet];
    $("#bench-table").innerHTML = `<thead><tr><th>Method</th><th>Needs cheat rate?</th><th>F1 @5%</th><th>F1 @12%</th><th>F1 @20%</th><th>Average F1</th><th>Worst-case F1</th></tr></thead><tbody>` +
      B.map((b) => `<tr class="${b.method === "DBSCAN" ? "win" : ""}"><td>${b.method}<div class="muted" style="font-weight:400;font-size:12px">${b.note}</div></td>
        <td class="${b.needs_contamination ? "yes" : "no"}">${b.needs_contamination ? "yes — must guess" : "no"}</td>
        ${rates.map((r) => `<td class="mono">${b.by_rate[r].toFixed(2)}</td>`).join("")}
        <td class="mono">${b.f1_mean.toFixed(2)}</td><td class="mono" style="color:${b.f1_min >= 0.85 ? C.green : C.muted}">${b.f1_min.toFixed(2)}</td></tr>`).join("") + "</tbody>";
    const host = $("#bench-chart");
    const draw = (animate) => {
      const f = frame(host, { t: 30, r: 12, b: 48, l: 40 }); const { svg, m, iw, ih } = f;
      const n = B.length, gw = iw / n, bw = Math.min(26, (gw - 24) / rates.length);
      const ys = (v) => ih - v * ih;
      axes(f, (i) => gw * i + gw / 2, ys, { xTicks: [], yTicks: [0, 0.25, 0.5, 0.75, 1], yFmt: (v) => v.toFixed(2) });
      const g = S("g", { transform: `translate(${m.l},${m.t})` }, svg);
      B.forEach((b, i) => {
        const cx = gw * i + gw / 2;
        if (b.method === "DBSCAN") S("rect", { x: gw * i + 4, y: -22, width: gw - 8, height: ih + 22, rx: 10, fill: "rgba(255,61,129,.07)", stroke: "rgba(255,61,129,.3)" }, g);
        rates.forEach((r, k) => {
          const v = b.by_rate[r], x = cx + (k - (rates.length - 1) / 2) * (bw + 4) - bw / 2;
          const rect = S("rect", { x, y: ys(v), width: bw, height: ih - ys(v), rx: 3, fill: RC[k], class: "bar" }, g);
          if (animate && !REDUCED) { rect.style.transformOrigin = `0 ${ih}px`; rect.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 900, delay: i * 90 + k * 40, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }); }
          rect.addEventListener("mousemove", (e) => tip.show(`<b>${b.method}</b><br>guessed rate ${Math.round(+r * 100)}% → F1 ${v.toFixed(3)}`, e));
          rect.addEventListener("mouseleave", tip.hide);
        });
        const t = S("text", { x: cx, y: ih + 20, "text-anchor": "middle", class: "tick", style: b.method === "DBSCAN" ? `fill:${C.pink};font-weight:600` : "" }, g);
        t.textContent = b.method;
      });
      const lg = S("g", { transform: `translate(0,-24)` }, g);
      rates.forEach((r, k) => { S("rect", { x: k * 118, y: 0, width: 10, height: 10, rx: 2, fill: RC[k] }, lg); S("text", { x: k * 118 + 16, y: 9, class: "tick" }, lg).textContent = `guessed ${Math.round(+r * 100)}%`; });
    };
    onReveal($("#bench"), () => { draw(true); redraws.push(() => draw(false)); });
  }

  /* =========================================================
     BEAT Spectator — red-team challenge
     ========================================================= */
  function renderChallenge({ D }) {
    const form = $("#ch-form"), btn = $("#ch-btn"), out = $("#ch-result"), err = $("#ch-error"), tagIn = $("#ch-tag");
    const KEYS = ["aim_lock", "smoothing", "speed_boost", "reaction_ms", "reaction_jitter"];
    const FMT = { aim_lock: (v) => `${Math.round(v * 100)}%`, smoothing: (v) => `${Math.round(v * 100)}%`, speed_boost: (v) => `${(+v).toFixed(2)}×`, reaction_ms: (v) => `${Math.round(v)} ms`, reaction_jitter: (v) => `± ${Math.round(v)} ms` };
    const trig = $("#c-auto_trigger");
    const LOADOUTS = [
      ["Honest", C.cyan, { aim_lock: 0, smoothing: 0, speed_boost: 1, auto_trigger: false, reaction_ms: 150, reaction_jitter: 30 }],
      ["Rage aimbot", C.pink, { aim_lock: 1, smoothing: 0, speed_boost: 1, auto_trigger: true, reaction_ms: 60, reaction_jitter: 5 }],
      ["Closet cheater", C.violet, { aim_lock: 0.25, smoothing: 0.6, speed_boost: 1, auto_trigger: false, reaction_ms: 150, reaction_jitter: 30 }],
      ["Triggerbot", C.amber, { aim_lock: 0, smoothing: 0, speed_boost: 1, auto_trigger: true, reaction_ms: 90, reaction_jitter: 8 }],
      ["Speed demon", C.green, { aim_lock: 0, smoothing: 0, speed_boost: 1.8, auto_trigger: false, reaction_ms: 150, reaction_jitter: 30 }],
    ];
    const set = (k, v) => {
      const r = $("#c-" + k); r.value = v;
      r.style.setProperty("--p", `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
      $("#v-" + k).textContent = FMT[k](+r.value);
    };
    const syncTrig = () => $("#ch-trig").classList.toggle("off", !trig.checked);
    KEYS.forEach((k) => $("#c-" + k).addEventListener("input", (e) => { set(k, e.target.value); $$("#ch-presets .chip").forEach((c) => c.classList.remove("active")); }));
    trig.addEventListener("change", () => { syncTrig(); $$("#ch-presets .chip").forEach((c) => c.classList.remove("active")); });
    const apply = (cfg) => { KEYS.forEach((k) => set(k, cfg[k])); trig.checked = cfg.auto_trigger; syncTrig(); };
    LOADOUTS.forEach(([name, color, cfg], i) => {
      const b = el("button", "chip" + (i === 0 ? " active" : ""), `<i style="background:${color};box-shadow:0 0 8px ${color}"></i>${name}`);
      b.type = "button"; b.style.color = color;
      b.addEventListener("click", () => { apply(cfg); $$("#ch-presets .chip").forEach((c) => c.classList.toggle("active", c === b)); });
      $("#ch-presets").append(b);
    });
    apply(LOADOUTS[0][2]);

    let myId = null;
    function loadBoard() {
      api("/api/leaderboard").then((lb) => {
        $("#lb-stats").textContent = lb.attempts ? `${lb.attempts} cheats deployed · ${lb.caught} caught (${Math.round((lb.caught / lb.attempts) * 100)}%)` : "";
        const row = (r, fame) => `<li class="${r.id === myId ? "me" : ""}"><span><b>${esc(r.gamertag)}</b><small>${cheatSummary(r.params)}</small></span>
          <span class="v" style="color:${fame ? C.green : C.pink}">${fame ? r.evasion_score.toFixed(1) : Math.round(r.detection_rate * 100) + "%"}<small>${fame ? `+${r.power.toFixed(0)}% adv · ${Math.round(r.detection_rate * 100)}% det.` : `+${r.power.toFixed(0)}% adv`}</small></span></li>`;
        $("#lb-fame").innerHTML = lb.hall_of_fame.length ? lb.hall_of_fame.map((r) => row(r, true)).join("") : `<li class="empty">No cheat has slipped past Spectator yet.</li>`;
        $("#lb-shame").innerHTML = lb.wall_of_shame.length ? lb.wall_of_shame.map((r) => row(r, false)).join("") : `<li class="empty">Nobody caught yet — be the first.</li>`;
      }).catch(() => {
        $("#lb-fame").innerHTML = $("#lb-shame").innerHTML = `<li class="empty">Start the backend to see the leaderboard.</li>`;
      });
    }
    function cheatSummary(p) {
      const parts = [];
      if (p.aim_lock > 0) parts.push(`aim ${Math.round(p.aim_lock * 100)}%${p.smoothing > 0 ? ` · smooth ${Math.round(p.smoothing * 100)}%` : ""}`);
      if (p.auto_trigger) parts.push(`trigger ${Math.round(p.reaction_ms)}±${Math.round(p.reaction_jitter)}ms`);
      if (p.speed_boost > 1) parts.push(`speed ${(+p.speed_boost).toFixed(2)}×`);
      return parts.join(" · ") || "no cheat";
    }
    onReveal($("#lb"), loadBoard);

    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = "";
      const tag = tagIn.value.trim() || "Anonymous";
      if (!/^[A-Za-z0-9_.\- ]{2,24}$/.test(tag)) { err.textContent = "Gamertag: 2–24 characters (letters, numbers, space, _ . -)."; return; }
      if (!backendOnline) { err.innerHTML = "Backend offline — start it with <code>python backend/app.py</code>."; return; }
      const cheat = { auto_trigger: trig.checked }; KEYS.forEach((k) => (cheat[k] = +$("#c-" + k).value));
      btn.disabled = true; $(".scan-btn-txt", btn).textContent = "Deploying…";
      out.innerHTML = `<div class="sr-scanning"><div class="trial-grid" id="tg">${Array.from({ length: 20 }, (_, i) => `<span>${i + 1}</span>`).join("")}</div>
        <div class="term">${["simulating 20 matches · 300 ticks each", "extracting 10 behavioural features per match", "scoring each match against DBSCAN core", "INSERT INTO challenges → Spectator.db"].map((l, i) => `<div class="ok" style="animation-delay:${i * 0.5}s">${l}</div>`).join("")}</div></div>`;
      const cells = $$("#tg span");
      let k = 0; const spin = setInterval(() => { cells.forEach((c) => c.classList.remove("run")); cells[k % 20].classList.add("run"); k++; }, 70);
      try {
        const [r] = await Promise.all([api("/api/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gamertag: tag, cheat }) }), new Promise((res) => setTimeout(res, REDUCED ? 0 : 1600))]);
        clearInterval(spin); cells.forEach((c) => c.classList.remove("run"));
        for (let i = 0; i < 20; i++) { cells[i].classList.add(r.scores[i] > 1 ? "c" : "e"); if (!REDUCED) await new Promise((res) => setTimeout(res, 45)); }
        if (!REDUCED) await new Promise((res) => setTimeout(res, 450));
        myId = r.id; showOutcome(r); loadBoard();
      } catch (ex) {
        clearInterval(spin);
        out.innerHTML = `<div class="sr-idle"><div class="skull">☠</div><h3>Deploy failed</h3><p class="muted">${esc(ex.message)}</p></div>`;
      } finally { btn.disabled = false; $(".scan-btn-txt", btn).textContent = "Deploy cheat · 20 matches"; }
    });

    function showOutcome(r) {
      const caught = r.verdict === "caught", honest = r.verdict === "honest";
      const col = honest ? C.cyan : caught ? C.pink : C.green;
      const title = honest ? "CLEAN" : caught ? "CAUGHT" : "UNDETECTED";
      const line = honest ? "No cheat enabled — Spectator saw an ordinary player. Turn something on and try to sneak past."
        : caught ? `Spectator flagged your cheat in <b>${r.caught} of ${r.trials}</b> matches. ${r.power > 40 ? "That much advantage is impossible to hide." : "Even a small edge leaves a fingerprint."}`
        : `You slipped past in <b>${r.trials - r.caught} of ${r.trials}</b> matches — but your cheat only gave <b>+${r.power.toFixed(0)}%</b> advantage. ${r.power < 15 ? "Spectator forces cheaters to play almost like humans." : "Nicely done — you're on the leaderboard."}`;
      const rs = r.replay.reasons;
      out.innerHTML = `<div class="sr-done">
        <div class="sr-top"><div><span class="mono muted small">DEPLOYMENT #${r.id} · ${esc(r.gamertag)}</span>
          <div class="ch-verdict" style="color:${col};text-shadow:0 0 40px ${col}77">${title}</div></div>
          ${r.verdict === "evaded" ? `<div style="text-align:right"><span class="mono muted small">RANK</span><div class="verdict-label" style="color:${C.text};margin:6px 0 0">#${r.rank}</div></div>` : ""}</div>
        <div class="trial-grid">${r.scores.map((s, i) => `<span class="${s > 1 ? "c" : "e"}" title="match ${i + 1}: score ${s.toFixed(2)}">${s > 1 ? "✕" : "✓"}</span>`).join("")}</div>
        <p class="sr-text">${line}</p>
        <div class="ch-stats">
          <div class="lm"><b style="color:${C.pink}">${Math.round(r.detection_rate * 100)}%</b><span>detection</span></div>
          <div class="lm"><b style="color:${C.amber}">+${r.power.toFixed(0)}%</b><span>advantage</span></div>
          <div class="lm"><b style="color:${C.green}">${r.evasion_score.toFixed(1)}</b><span>evasion score</span></div>
          <div class="lm"><b style="color:${C.cyan}">${r.replay.score.toFixed(2)}</b><span>median score</span></div>
        </div>
        <div><div class="mini-title">Replay · median match <button class="replay-btn" type="button" id="ch-rp">↻ replay</button></div><canvas class="ch-replay" id="ch-canvas"></canvas></div>
        <div><div class="mini-title">${caught ? "What gave you away" : "Spectator's closest look"}</div>
          ${rs.map((x) => { const zc = Math.abs(x.z) > 2 ? col : C.cyan; return `<div class="reason"><b>${x.label}</b><span class="rz" style="color:${zc}">${x.z >= 0 ? "+" : ""}${x.z.toFixed(1)}σ</span><div class="rbar"><div data-w="${Math.min(Math.abs(x.z) / 6, 1) * 100}%" style="background:${zc}"></div></div><p>value <b>${fv(x.value)}</b> vs honest median ${fv(x.normal)}</p></div>`; }).join("")}
        </div></div>`;
      requestAnimationFrame(() => requestAnimationFrame(() => $$(".rbar div", out).forEach((b) => (b.style.width = b.dataset.w))));
      const play = () => replayMatch($("#ch-canvas"), r.replay, col);
      play(); $("#ch-rp").addEventListener("click", play);
    }

    let rpAnim;
    function replayMatch(cv, rp, col) {
      cancelAnimationFrame(rpAnim);
      const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const P = rp.path; const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
      const pad = 90; let x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
      const s = Math.min(W / (x1 - x0), H / (y1 - y0)); const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
      const X = (v) => ox + (v - x0) * s, Y = (v) => H - (oy + (v - y0) * s);
      const shots = rp.shots; const dur = REDUCED ? 1 : 6000; const t0 = performance.now();
      const frame = (now) => {
        const k = Math.min(1, (now - t0) / dur), tick = k * (P.length * 2 - 1), n = Math.max(1, Math.floor(tick / 2));
        g.clearRect(0, 0, W, H);
        g.strokeStyle = "rgba(255,255,255,.04)"; g.lineWidth = 1;
        for (let gx = Math.ceil(x0 / 50) * 50; gx < x1; gx += 50) { g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), H); g.stroke(); }
        for (let gy = Math.ceil(y0 / 50) * 50; gy < y1; gy += 50) { g.beginPath(); g.moveTo(0, Y(gy)); g.lineTo(W, Y(gy)); g.stroke(); }
        g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1; g.stroke();
        g.beginPath(); for (let i = 0; i < n; i++) { const [x, y] = P[i]; i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); }
        g.strokeStyle = col; g.lineWidth = 2; g.shadowColor = col; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
        shots.forEach((sh) => {
          const age = tick - sh.t; if (age < 0 || age > 14) return;
          const a = 1 - age / 14, ex = sh.x + 70 * Math.cos((sh.target * Math.PI) / 180), ey = sh.y + 70 * Math.sin((sh.target * Math.PI) / 180);
          const ax = sh.x + 90 * Math.cos((sh.aim * Math.PI) / 180), ay = sh.y + 90 * Math.sin((sh.aim * Math.PI) / 180);
          g.globalAlpha = a;
          g.beginPath(); g.arc(X(ex), Y(ey), 5, 0, Math.PI * 2); g.fillStyle = sh.hit ? C.pink : C.amber; g.fill();
          g.beginPath(); g.moveTo(X(sh.x), Y(sh.y)); g.lineTo(X(ax), Y(ay)); g.strokeStyle = sh.fire ? "#fff" : "rgba(255,255,255,.4)"; g.lineWidth = sh.fire ? 1.4 : 1; g.setLineDash(sh.fire ? [] : [3, 3]); g.stroke(); g.setLineDash([]);
          if (sh.hit) { g.beginPath(); g.arc(X(ex), Y(ey), 5 + 14 * (1 - a), 0, Math.PI * 2); g.strokeStyle = C.pink; g.lineWidth = 1.5; g.stroke(); if (sh.hs) { g.fillStyle = C.pink; g.font = "10px JetBrains Mono"; g.fillText("HEADSHOT", X(ex) + 9, Y(ey) - 8); } }
          g.globalAlpha = 1;
        });
        const [hx, hy] = P[n - 1];
        g.beginPath(); g.arc(X(hx), Y(hy), 5, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
        g.beginPath(); g.arc(X(hx), Y(hy), 11 + 3 * Math.sin(now / 150), 0, Math.PI * 2); g.strokeStyle = col + "99"; g.lineWidth = 1.2; g.stroke();
        const fired = shots.filter((sh) => sh.t <= tick && sh.fire).length, hits = shots.filter((sh) => sh.t <= tick && sh.hit).length;
        g.fillStyle = C.muted; g.font = "11px JetBrains Mono";
        g.fillText(`t ${(tick / 10).toFixed(1)}s   shots ${fired}   hits ${hits}`, 12, H - 12);
        if (k < 1) rpAnim = requestAnimationFrame(frame);
      };
      rpAnim = requestAnimationFrame(frame);
    }
  }

  /* =========================================================
     MATCH REPLAY THEATRE
     ========================================================= */
  function renderTheatre({ D, players }) {
    const cv = $("#th-canvas"), g = cv.getContext("2d");
    const matches = [...new Set(players.map((p) => p.match_id))].sort();
    let cur = matches.find((m) => players.some((p) => p.match_id === m && p.is_anomaly)) || matches[0];
    let t = 0, playing = !REDUCED, speed = 1, last = 0, hl = null, W = 0, H = 0, dpr = 1, visible = false;
    const box = $("#th-matches");
    matches.forEach((m) => {
      const n = players.filter((p) => p.match_id === m && p.is_anomaly).length;
      const b = el("button", m === cur ? "active" : "", `${m}${n ? `<i></i>${n}` : ""}`); b.type = "button";
      b.addEventListener("click", () => { cur = m; t = 0; $$("button", box).forEach((x) => x.classList.toggle("active", x === b)); side(); });
      box.append(b);
    });
    const colorOf = (p) => (p.is_anomaly ? TIER_COLOR[p.tier] : C.cyan);
    function side() {
      const ps = players.filter((p) => p.match_id === cur).sort((a, b) => b.anomaly_score - a.anomaly_score);
      $("#th-match-label").textContent = `MATCH ${cur} · ${ps.length} PLAYERS · ${ps.filter((p) => p.is_anomaly).length} FLAGGED`;
      $("#th-players").innerHTML = ps.map((p) => `<button type="button" class="th-p ${p.is_anomaly ? "flag" : ""}" data-id="${p.player_id}"><i style="background:${colorOf(p)};box-shadow:0 0 8px ${colorOf(p)}"></i>
        <span><b>${p.player_id.split("_")[1]}</b><small>${p.is_anomaly ? `${p.tier} · ${FEAT_INFO[p.top_reason][0].toLowerCase()}` : "normal"}</small></span><span class="s" style="color:${colorOf(p)}">${p.anomaly_score.toFixed(2)}</span></button>`).join("");
      $$(".th-p").forEach((b) => {
        b.addEventListener("mouseenter", () => (hl = b.dataset.id)); b.addEventListener("mouseleave", () => (hl = null));
        b.addEventListener("click", () => { selectPlayer && players.find((p) => p.player_id === b.dataset.id).is_anomaly && (selectPlayer(b.dataset.id), $("#detections").scrollIntoView({ behavior: "smooth" })); });
      });
    }
    const resize = () => { dpr = Math.min(window.devicePixelRatio || 1, 2); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const play = $("#th-play"), range = $("#th-time");
    const setPlay = (v) => { playing = v; play.textContent = v ? "❚❚" : "▶"; };
    play.addEventListener("click", () => { if (t >= 1) t = 0; setPlay(!playing); });
    range.addEventListener("input", () => { t = range.value / 100; setPlay(false); });
    $$("#th-speed button").forEach((b) => b.addEventListener("click", () => { speed = +b.dataset.s; $$("#th-speed button").forEach((x) => x.classList.toggle("active", x === b)); }));
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(cv);
    window.addEventListener("resize", resize);
    const DUR = 30000;
    function draw(now) {
      const dt = last ? now - last : 0; last = now;
      if (visible) {
        if (!W) resize();
        if (playing) { t += (dt * speed) / DUR; if (t >= 1) { t = 1; setPlay(false); } }
        range.value = t * 100; range.style.setProperty("--p", `${t * 100}%`);
        const sec = t * 30; $("#th-clock").textContent = `00:${String(Math.floor(sec)).padStart(2, "0")} / 00:30`;
        const ps = players.filter((p) => p.match_id === cur);
        const all = ps.flatMap((p) => D.trajectories[p.player_id] || []);
        const pad = 40; let x0 = Math.min(...all.map((q) => q[0])) - pad, x1 = Math.max(...all.map((q) => q[0])) + pad, y0 = Math.min(...all.map((q) => q[1])) - pad, y1 = Math.max(...all.map((q) => q[1])) + pad;
        const sc = Math.min(W / (x1 - x0), H / (y1 - y0)), ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
        const X = (v) => ox + (v - x0) * sc, Y = (v) => H - (oy + (v - y0) * sc);
        g.clearRect(0, 0, W, H);
        g.strokeStyle = "rgba(255,255,255,.035)"; g.lineWidth = 1;
        for (let gx = Math.ceil(x0 / 50) * 50; gx < x1; gx += 50) { g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), H); g.stroke(); }
        for (let gy = Math.ceil(y0 / 50) * 50; gy < y1; gy += 50) { g.beginPath(); g.moveTo(0, Y(gy)); g.lineTo(W, Y(gy)); g.stroke(); }
        ps.forEach((p) => {
          const tr = D.trajectories[p.player_id]; if (!tr || tr.length < 2) return;
          const f = t * (tr.length - 1), i = Math.floor(f), fr = f - i;
          const col = colorOf(p), dim = hl && hl !== p.player_id;
          g.globalAlpha = dim ? 0.15 : 1;
          g.beginPath(); for (let k = 0; k <= i; k++) { const [x, y] = tr[k]; k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); }
          g.strokeStyle = col; g.lineWidth = p.is_anomaly ? 2.2 : 1.2; g.globalAlpha = (dim ? 0.1 : p.is_anomaly ? 0.85 : 0.35);
          if (p.is_anomaly) { g.shadowColor = col; g.shadowBlur = 12; }
          g.stroke(); g.shadowBlur = 0; g.globalAlpha = dim ? 0.2 : 1;
          const a = tr[i], b = tr[Math.min(i + 1, tr.length - 1)];
          const hx = a[0] + (b[0] - a[0]) * fr, hy = a[1] + (b[1] - a[1]) * fr;
          g.beginPath(); g.arc(X(hx), Y(hy), p.is_anomaly ? 5 : 3.5, 0, Math.PI * 2); g.fillStyle = p.is_anomaly ? "#fff" : col; g.fill();
          if (p.is_anomaly) {
            g.beginPath(); g.arc(X(hx), Y(hy), 11 + 4 * Math.sin(now / 160), 0, Math.PI * 2); g.strokeStyle = col; g.lineWidth = 1.2; g.stroke();
            g.fillStyle = col; g.font = "600 11px JetBrains Mono"; g.fillText(`${p.player_id.split("_")[1]} · ${p.tier.toUpperCase()}`, X(hx) + 14, Y(hy) - 10);
          } else if (hl === p.player_id) { g.fillStyle = C.text; g.font = "11px JetBrains Mono"; g.fillText(p.player_id.split("_")[1], X(hx) + 9, Y(hy) - 8); }
          g.globalAlpha = 1;
        });
      }
      requestAnimationFrame(draw);
    }
    side(); setPlay(playing);
    onReveal($("#theatre"), () => { resize(); requestAnimationFrame(draw); });
  }

  /* ---------- conclusion ---------- */
  function renderConclusion({ D, flagged }) {
    const m = D.metrics;
    const b = D.benchmark || [];
    const others = b.filter((x) => x.method !== "DBSCAN");
    const worst = others.length ? Math.min(...others.map((x) => x.f1_min)) : null;
    $("#concl-text").innerHTML = `Density-based clustering separates honest play from cheating without labels. On ${fmt(D.dataset.rows)} telemetry ticks from ${D.dataset.players} players, DBSCAN (ε = ${D.model.eps.toFixed(2)}, min_samples = ${D.model.min_samples}) flagged ${flagged.length} players, achieving <b>${pct(m.recall)} recall</b>, <b>${pct(m.precision)} precision</b> and an <b>F1 of ${m.f1.toFixed(2)}</b>.${worst != null ? ` Unlike Isolation Forest, LOF, One-Class SVM and K-Means, it needs <b>no guess of the cheat rate</b> — when that guess is wrong their F1 drops as low as ${worst.toFixed(2)}, while DBSCAN stays at ${m.f1.toFixed(2)}.` : ""} The trained model is served by a Flask API that scores new players live and stores every scan in SQLite.`;
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
