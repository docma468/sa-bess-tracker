/* SA Battery Tracker front end. Reads data/index.json, data/live.json and data/days/*.json. */
(() => {
  "use strict";
  const STEP = 300000;
  const HOUR = 3600000;
  const AXW = window.innerWidth < 600 ? 46 : 66;
  const state = { view: "fleet", unit: null, hours: 24, tz: "Australia/Brisbane" };
  const days = new Map();       // date -> day json
  let index = null, live = null;
  let socChart = null, mwChart = null;

  // ------------------------------------------------------------ utils
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (n, d = 0) => n == null || isNaN(n) ? "–" : n.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const getJSON = async (url) => {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "v=" + Math.floor(Date.now() / 60000));
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  };
  function dtf(opts) { return new Intl.DateTimeFormat("en-AU", { timeZone: state.tz, hour12: false, ...opts }); }
  const fTime = (ms) => dtf({ hour: "2-digit", minute: "2-digit" }).format(ms);
  const fDay = (ms) => dtf({ weekday: "short", day: "numeric", month: "short" }).format(ms);
  const fFull = (ms) => dtf({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
  const tzName = () => state.tz === "Australia/Brisbane" ? "NEM time" : "Adelaide time";
  function hoursLabel(h) { return h == null ? "–" : h >= 1 ? fmt(h, 1) + " h" : fmt(h * 60) + " min"; }
  function fitClass(e) { return e == null ? ["–", ""] : e < 5 ? ["Good", "good"] : e <= 10 ? ["Fair", ""] : ["Low", "low"]; }

  // ------------------------------------------------------------ url state
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (["fleet", "top10", "unit"].includes(p.get("view"))) state.view = p.get("view");
    if (p.get("u")) state.unit = p.get("u");
    if ([24, 72, 168, 744].includes(+p.get("h"))) state.hours = +p.get("h");
    if (p.get("tz") === "adl") state.tz = "Australia/Adelaide";
  }
  function writeHash() {
    const p = new URLSearchParams({ view: state.view, h: state.hours });
    if (state.view === "unit" && state.unit) p.set("u", state.unit);
    if (state.tz !== "Australia/Brisbane") p.set("tz", "adl");
    history.replaceState(null, "", "#" + p.toString());
  }

  // ------------------------------------------------------------ data
  async function ensureDays(hours) {
    const from = live.latest - hours * HOUR - 24 * HOUR;
    const want = index.days.filter((d) => {
      const start = Date.parse(d + "T04:00:00+10:00");
      return start + 24 * HOUR > from;
    });
    await Promise.all(want.filter((d) => !days.has(d)).map(async (d) => {
      try { days.set(d, await getJSON(`data/days/${d}.json`)); } catch (e) { console.warn(e); }
    }));
    return want.filter((d) => days.has(d)).map((d) => days.get(d)).sort((a, b) => a.start - b.start);
  }

  /** Build aligned 5-minute series from the completed days plus the live tail. */
  function buildSeries(dayList) {
    const start = dayList.length ? dayList[0].start : live.start;
    const end = live.latest;
    const n = Math.round((end - start) / STEP) + 1;
    const t = new Array(n), price = new Array(n).fill(null);
    for (let i = 0; i < n; i++) t[i] = start + i * STEP;
    const units = {};
    const uget = (u) => units[u] || (units[u] = { act: new Array(n).fill(null), est: new Array(n).fill(null), mw: new Array(n).fill(null) });
    for (const d of dayList) {
      const off = Math.round((d.start - start) / STEP);
      d.price.forEach((v, i) => { if (off + i < n && off + i >= 0) price[off + i] = v; });
      for (const [u, s] of Object.entries(d.units)) {
        const U = uget(u);
        s.e.forEach((v, i) => { const k = off + i; if (k >= 0 && k < n) U.act[k] = v; });
        s.mw.forEach((v, i) => { const k = off + i; if (k >= 0 && k < n) U.mw[k] = v; });
      }
    }
    const loff = Math.round((live.start - start) / STEP);
    live.price.forEach((v, i) => { const k = loff + i; if (k >= 0 && k < n && price[k] == null) price[k] = v; });
    for (const [u, s] of Object.entries(live.units)) {
      const U = uget(u);
      s.e.forEach((v, i) => { const k = loff + i; if (k >= 0 && k < n) U.est[k] = v; });
      s.mw.forEach((v, i) => { const k = loff + i; if (k >= 0 && k < n && U.mw[k] == null) U.mw[k] = v; });
    }
    return { t, price, units };
  }

  function capOf(u) { const s = live.summary.find((x) => x.duid === u); return s ? s.mwh : null; }

  /** Combine a set of units into SOC % (actual + estimate), MW. */
  function combine(S, duids) {
    const n = S.t.length;
    const act = new Array(n).fill(null), est = new Array(n).fill(null), mw = new Array(n).fill(null);
    const caps = Object.fromEntries(duids.map((u) => [u, capOf(u)]));
    for (let i = 0; i < n; i++) {
      let ea = 0, ca = 0, ee = 0, ce = 0, m = 0, mm = false, anyA = 0, anyE = 0;
      for (const u of duids) {
        const U = S.units[u]; if (!U || !caps[u]) continue;
        if (U.act[i] != null) { ea += U.act[i]; ca += caps[u]; anyA++; }
        if (U.est[i] != null) { ee += U.est[i]; ce += caps[u]; anyE++; }
        if (U.mw[i] != null) { m += U.mw[i]; mm = true; }
      }
      // only plot combined values when (nearly) every unit reported, so gaps don't fake a dip
      if (anyA && anyA >= duids.length * 0.8) act[i] = 100 * ea / ca;
      if (anyE && anyE >= duids.length * 0.8) est[i] = 100 * ee / ce;
      mw[i] = mm ? m : null;
    }
    return { act, est, mw };
  }

  function bucket(t, arrs, every) {
    if (every <= 1) return [t, arrs];
    const nt = [], out = arrs.map(() => []);
    for (let i = 0; i < t.length; i += every) {
      nt.push(t[i]);
      arrs.forEach((a, j) => {
        let s = 0, c = 0;
        for (let k = i; k < Math.min(i + every, t.length); k++) if (a[k] != null) { s += a[k]; c++; }
        out[j].push(c ? s / c : null);
      });
    }
    return [nt, out];
  }

  function forecastPoints() {
    const f = live.forecast || {};
    const p5 = (f.p5 || []).filter((p) => p[0] > live.latest);
    const lastP5 = p5.length ? p5[p5.length - 1][0] : live.latest;
    const pd = (f.pd || []).filter((p) => p[0] > lastP5);
    const pts = [...p5, ...pd];
    // include the current price so the dotted line joins the solid one
    const now = live.price.length ? live.price[live.price.length - 1] : null;
    if (now != null) pts.unshift([live.latest, now]);
    return pts;
  }

  // ------------------------------------------------------------ rendering
  function renderHeader() {
    const age = (Date.now() - live.latest) / 60000;
    const at = (tz) => {
      const d = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(live.latest);
      const h = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" }).format(live.latest);
      return `<b><span class="dd">${d}, </span>${h}</b>`;
    };
    $("#updated").innerHTML = `<div><span class="dot${age > 25 ? " stale" : ""}"></span>Data to ${at("Australia/Brisbane")} NEM time</div>
      <div>Data to ${at("Australia/Adelaide")} Adelaide time</div>`;
    $("#footReg").textContent = `Battery list: ${live.registry.source}. Page refreshes itself every 5 minutes.`;
  }

  function renderKPIs() {
    const f = live.fleet;
    const priceNow = [...live.price].reverse().find((v) => v != null);
    const fc = forecastPoints().filter((p) => p[0] > live.latest && p[0] <= live.latest + HOUR);
    const fcAvg = fc.length ? fc.reduce((a, p) => a + p[1], 0) / fc.length : null;
    const net = f.mw;
    $("#kpis").innerHTML = `
      <div class="module marine"><div class="kpi">${fmt(100 * f.soc)}<small>%</small></div>
        <div class="kpi-label">Fleet state of charge (estimate)</div><div class="meter"><i style="width:${Math.min(100, 100 * f.soc)}%"></i></div></div>
      <div class="module"><div class="kpi">${fmt(f.mwh)}<small> MWh</small></div>
        <div class="kpi-label">Stored now, of ${fmt(f.cap_mwh)} MWh</div></div>
      <div class="module"><div class="kpi">${net >= 0 ? "" : "−"}${fmt(Math.abs(net))}<small> MW</small></div>
        <div class="kpi-label">Net ${net >= 0 ? "discharging" : "charging"} · ${fmt(f.discharging_mw)} out, ${fmt(Math.abs(f.charging_mw))} in</div></div>
      <div class="module"><div class="kpi"><small>$</small>${fmt(priceNow)}</div>
        <div class="kpi-label">SA spot $/MWh now${fcAvg != null ? ` · next hour ~$${fmt(fcAvg)}` : ""}</div></div>
      <div class="module"><div class="kpi">${f.tracked}</div>
        <div class="kpi-label">Batteries tracked · ${fmt(f.cap_mw)} MW</div></div>`;
  }

  function selection() {
    const all = live.summary.map((s) => s.duid);
    if (state.view === "unit" && state.unit && all.includes(state.unit)) {
      const s = live.summary.find((x) => x.duid === state.unit);
      return { duids: [state.unit], title: s.name, sub: `${s.duid} · ${fmt(s.mw)} MW / ${fmt(s.mwh)} MWh · ${s.participant}` };
    }
    if (state.view === "top10") {
      return { duids: all.slice(0, 10), title: "Top 10 combined", sub: "The ten largest batteries by MWh, combined" };
    }
    return { duids: all, title: "SA fleet", sub: `All ${all.length} batteries combined · ${fmt(live.fleet.cap_mw)} MW / ${fmt(live.fleet.cap_mwh)} MWh` };
  }

  const nowLine = {
    id: "nowLine",
    afterDatasetsDraw(chart) {
      const x = chart.scales.x.getPixelForValue(live.latest);
      const { top, bottom } = chart.chartArea;
      if (x < chart.chartArea.left || x > chart.chartArea.right) return;
      const c = chart.ctx; c.save();
      c.strokeStyle = css("--muted"); c.setLineDash([3, 3]); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      if (chart.canvas.id === "socChart") {
        c.setLineDash([]); c.fillStyle = css("--heading"); c.font = "700 12px Inter, sans-serif"; c.textAlign = "left";
        c.fillText("now", x + 4, top + 12);
      }
      c.restore();
    },
  };

  function xScale(min, max) {
    const span = max - min;
    const stepH = span <= 30 * HOUR ? 3 : span <= 80 * HOUR ? 12 : span <= 8 * 24 * HOUR ? 24 : 72;
    return {
      type: "linear", min, max,
      grid: { color: css("--rule") },
      afterBuildTicks: (axis) => {
        // ticks on round local hours
        const step = stepH * HOUR;
        const off = tzOffset(min);
        let t = Math.ceil((min + off) / step) * step - off;
        const ticks = [];
        for (; t <= max; t += step) ticks.push({ value: t });
        axis.ticks = ticks;
      },
      ticks: {
        color: css("--muted"), maxRotation: 0, autoSkip: true,
        callback: (v) => {
          const hh = fTime(v);
          return stepH >= 24 ? fDay(v) : hh === "00:00" ? fDay(v) : hh;
        },
      },
    };
  }
  function tzOffset(ms) {
    // offset of the selected zone from UTC at ms, in ms
    const p = dtf({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(ms);
    const g = (k) => +p.find((x) => x.type === k).value;
    const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    return asUTC - Math.floor(ms / 60000) * 60000;
  }

  async function renderCharts() {
    const dayList = await ensureDays(state.hours);
    const S = buildSeries(dayList);
    window.__series = S;
    const sel = selection();
    const C = combine(S, sel.duids);
    const every = state.hours > 168 ? 6 : state.hours > 72 ? 3 : 1;
    const [t, [act, est, mw, price]] = bucket(S.t, [C.act, C.est, C.mw, S.price], every);
    const fc = forecastPoints();
    const min = live.latest - state.hours * HOUR;
    const ahead = Math.max(4 * HOUR, state.hours * HOUR * 0.2);
    const fcEnd = fc.length ? Math.min(fc[fc.length - 1][0] + 30 * 60000, live.latest + ahead) : live.latest;
    const max = Math.max(live.latest + HOUR, fcEnd);

    $("#chartTitle").textContent = sel.title;
    $("#chartSub").textContent = sel.sub + ` · ${tzName()}`;
    const marine = css("--heading"), est_c = css("--line-est"), priceC = css("--price"), muted = css("--muted"), rule = css("--rule");
    $("#legend").innerHTML = `
      <span><i class="sw" style="border-color:${marine}"></i>Actual SOC (AEMO)</span>
      <span><i class="sw dash" style="border-color:${est_c}"></i>Estimated SOC</span>
      <span><i class="sw" style="border-color:${priceC};border-top-width:2px"></i>Spot price</span>
      <span><i class="sw dot" style="border-color:${priceC}"></i>AEMO forecast price</span>`;

    const pts = (xs, ys) => xs.map((x, i) => ({ x, y: ys[i] == null ? null : +ys[i].toFixed(2) }));
    const priceVals = price.filter((v) => v != null).concat(fc.filter((p) => p[0] <= max).map((p) => p[1]));
    // keep price axis readable: clip extreme spikes, they still show in the tooltip
    const sorted = [...priceVals].sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    const pMax = Math.max(100, Math.ceil(q(0.98) / 50) * 50 + 50);
    const pMin = Math.min(0, Math.floor(q(0.01) / 50) * 50);

    const socData = {
      datasets: [
        { label: "Actual SOC", data: pts(t, act), borderColor: marine, backgroundColor: marine, borderWidth: 3, pointRadius: 0, yAxisID: "y", spanGaps: false, order: 1 },
        { label: "Estimated SOC", data: pts(t, est), borderColor: est_c, backgroundColor: est_c, borderWidth: 3, borderDash: [8, 5], pointRadius: 0, yAxisID: "y", order: 2 },
        { label: "Spot price", data: pts(t, price), borderColor: priceC, backgroundColor: priceC, borderWidth: 2, pointRadius: 0, stepped: "before", yAxisID: "p", order: 3 },
        { label: "Forecast price", data: fc.filter((p) => p[0] <= max).map((p) => ({ x: p[0], y: p[1] })), borderColor: priceC, backgroundColor: priceC, borderWidth: 2.5, borderDash: [3, 4], pointRadius: 0, stepped: "before", yAxisID: "p", order: 4 },
      ],
    };
    const tooltip = {
      mode: "index", intersect: false,
      callbacks: {
        title: (items) => items.length ? fFull(items[0].parsed.x) : "",
        label: (c) => {
          const v = c.parsed.y; if (v == null) return null;
          if (c.dataset.yAxisID === "p") return `${c.dataset.label}: $${fmt(v, 2)}/MWh`;
          if (c.dataset.yAxisID === "m") return `${c.dataset.label}: ${fmt(Math.abs(v), 1)} MW`;
          return `${c.dataset.label}: ${fmt(v, 1)}%`;
        },
      },
      filter: (i) => i.parsed.y != null,
    };
    Chart.defaults.font.family = "Inter, 'Helvetica Neue', Arial, sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.font.weight = "600";
    const base = {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip },
    };
    const socOpts = {
      ...base,
      scales: {
        x: xScale(min, max),
        y: { afterFit: (a) => { a.width = AXW; }, min: 0, max: 100, title: { display: true, text: "State of charge %", color: marine, font: { weight: "700", size: 13 } }, ticks: { color: muted, stepSize: 25 }, grid: { color: rule } },
        p: { afterFit: (a) => { a.width = AXW; }, position: "right", min: pMin, max: pMax, title: { display: true, text: "$/MWh", color: marine, font: { weight: "700", size: 13 } }, ticks: { color: muted }, grid: { display: false } },
      },
    };
    const dis = mw.map((v) => v == null ? null : Math.max(0, v));
    const chg = mw.map((v) => v == null ? null : Math.min(0, v));
    const mwData = {
      datasets: [
        { label: "Discharging", data: pts(t, dis), borderColor: marine, backgroundColor: hexA(marine, 0.55), fill: "origin", borderWidth: 2, pointRadius: 0, stepped: "before", yAxisID: "m" },
        { label: "Charging", data: pts(t, chg), borderColor: css("--cyan-dark"), backgroundColor: hexA(css("--cyan-dark"), 0.5), fill: "origin", borderWidth: 2, pointRadius: 0, stepped: "before", yAxisID: "m" },
      ],
    };
    const mwOpts = {
      ...base,
      scales: {
        x: xScale(min, max),
        r: { position: "right", afterFit: (a) => { a.width = AXW; }, ticks: { display: false }, grid: { display: false }, border: { display: false } },
        m: { afterFit: (a) => { a.width = AXW; }, title: { display: true, text: "MW (+ out, − in)", color: marine, font: { weight: "700", size: 13 } }, ticks: { color: muted }, grid: { color: (c) => c.tick.value === 0 ? muted : rule } },
      },
    };
    if (socChart) socChart.destroy();
    if (mwChart) mwChart.destroy();
    socChart = new Chart($("#socChart"), { type: "line", data: socData, options: socOpts, plugins: [nowLine] });
    mwChart = new Chart($("#mwChart"), { type: "line", data: mwData, options: mwOpts, plugins: [nowLine] });
    renderTop10(S, min);
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    if (h.length !== 6) return hex;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }

  function renderTop10(S, min) {
    const panel = $("#top10Panel");
    panel.hidden = state.view !== "top10";
    if (panel.hidden) return;
    const top = live.summary.slice(0, 10);
    $("#grid10").innerHTML = top.map((s) => `
      <button class="card" data-u="${esc(s.duid)}">
        <div class="nm">${esc(s.name)}</div>
        <div class="meta">${fmt(s.mw)} MW · ${fmt(s.mwh)} MWh</div>
        <div class="big">${s.soc == null ? "–" : fmt(100 * s.soc) + "%"}</div>
        <div class="mode">${modeText(s)}</div>
        <canvas width="420" height="112"></canvas>
      </button>`).join("");
    const i0 = Math.max(0, S.t.findIndex((x) => x >= min));
    document.querySelectorAll("#grid10 .card").forEach((el) => {
      const u = el.dataset.u, U = S.units[u], cap = capOf(u);
      el.addEventListener("click", () => setView("unit", u));
      if (!U || !cap) return;
      const ys = S.t.slice(i0).map((_, k) => { const i = i0 + k; const v = U.act[i] ?? U.est[i]; return v == null ? null : v / cap; });
      spark(el.querySelector("canvas"), ys, U.act.slice(i0).filter((v) => v != null).length);
    });
  }

  function spark(cv, ys, nAct) {
    const c = cv.getContext("2d"), W = cv.width, Hh = cv.height, n = ys.length;
    c.clearRect(0, 0, W, Hh);
    c.strokeStyle = css("--rule"); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, Hh - 1); c.lineTo(W, Hh - 1); c.stroke();
    const draw = (from, to, color, dash) => {
      c.strokeStyle = color; c.lineWidth = 3; c.setLineDash(dash); c.beginPath();
      let pen = false;
      for (let i = from; i < to; i++) {
        const v = ys[i]; if (v == null) { pen = false; continue; }
        const x = (i / Math.max(1, n - 1)) * W, y = Hh - 4 - v * (Hh - 8);
        pen ? c.lineTo(x, y) : c.moveTo(x, y); pen = true;
      }
      c.stroke(); c.setLineDash([]);
    };
    // find split between actual and estimate (last non-null actual index)
    let split = 0; for (let i = 0, seen = 0; i < n; i++) { if (seen < nAct) split = i + 1; if (ys[i] != null) seen++; }
    draw(0, Math.min(n, split), css("--heading"), []);
    draw(Math.max(0, split - 1), n, css("--line-est"), [8, 6]);
  }

  function modeText(s) {
    if (s.mode === "idle") return "Idle";
    return `${s.mode === "charging" ? "Charging" : "Discharging"} ${fmt(Math.abs(s.now_mw))} MW`;
  }

  function renderGlance() {
    const top = live.summary.slice(0, 10);
    $("#glance").innerHTML = top.map((s) => {
      const soc = s.soc == null ? null : 100 * s.soc;
      const arrow = s.mode === "discharging" ? '<i class="arrow up" title="Discharging">▲</i>' : s.mode === "charging" ? '<i class="arrow dn" title="Charging">▼</i>' : '<i class="arrow"></i>';
      return `<button class="gbar" data-u="${esc(s.duid)}" title="${esc(s.name)}: ${soc == null ? "no data" : fmt(soc) + "%"}, ${fmt(s.now_mwh)} of ${fmt(s.mwh)} MWh">
        <span class="gname">${esc(s.name)}</span>
        <span class="gtrk"><i style="width:${soc == null ? 0 : Math.min(100, soc)}%"></i><em style="left:25%"></em><em style="left:50%"></em><em style="left:75%"></em></span>
        <span class="gval">${arrow}<b>${soc == null ? "–" : fmt(soc) + "%"}</b><small>${fmt(s.now_mwh)} / ${fmt(s.mwh)} MWh</small></span>
      </button>`;
    }).join("");
    document.querySelectorAll("#glance .gbar").forEach((b) => b.addEventListener("click", () => {
      setView("unit", b.dataset.u);
      $("#mainPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function renderTable() {
    const tb = $("#tbl tbody");
    tb.innerHTML = live.summary.map((s) => {
      const [fit, cls] = fitClass(s.typical_err_pct);
      const soc = s.soc == null ? null : 100 * s.soc;
      return `<tr data-u="${esc(s.duid)}" class="${state.view === "unit" && state.unit === s.duid ? "sel" : ""}">
        <td><span class="nm">${esc(s.name)}</span><span class="duid">${esc(s.duid)}</span></td>
        <td class="num">${fmt(s.mw)}</td><td class="num">${fmt(s.mwh)}</td>
        <td><div class="socbar"><span class="trk"><i style="width:${soc == null ? 0 : Math.min(100, soc)}%"></i></span><b>${soc == null ? "–" : fmt(soc) + "%"}</b></div></td>
        <td class="num">${fmt(s.now_mw, 1)}</td>
        <td>${s.mode === "idle" ? "Idle" : s.mode === "charging" ? "Charging" : "Discharging"}</td>
        <td><span class="pill ${cls}" title="Average gap to actual over 14 days: ${s.typical_err_pct ?? "–"}% of capacity">${fit}${s.typical_err_pct != null ? ` · ${fmt(s.typical_err_pct, 1)}%` : ""}</span></td>
      </tr>`;
    }).join("");
    tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => {
      setView("unit", tr.dataset.u);
      $("#mainPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function renderControls() {
    document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
    document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.h === state.hours));
    document.querySelectorAll("#tzSeg button").forEach((b) => b.classList.toggle("on", b.dataset.tz === state.tz));
    const sel = $("#unitSel");
    sel.hidden = state.view !== "unit";
    if (!sel.options.length) {
      sel.innerHTML = live.summary.map((s) => `<option value="${esc(s.duid)}">${esc(s.name)} (${fmt(s.mwh)} MWh)</option>`).join("");
    }
    if (state.unit) sel.value = state.unit;
  }

  function setView(view, unit) {
    state.view = view;
    if (unit) state.unit = unit;
    if (view === "unit" && !state.unit) state.unit = live.summary[0].duid;
    renderAll(false);
  }

  async function renderAll(full = true) {
    writeHash();
    renderControls();
    renderHeader();
    if (full) { renderKPIs(); renderGlance(); }
    renderTable();
    await renderCharts();
  }

  // ------------------------------------------------------------ boot
  async function load() {
    [index, live] = await Promise.all([getJSON("data/index.json"), getJSON("data/live.json")]);
  }

  function bind() {
    $("#viewSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setView(b.dataset.view); });
    $("#rangeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.hours = +b.dataset.h; renderAll(false); } });
    $("#tzSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.tz = b.dataset.tz; renderAll(false); } });
    $("#unitSel").addEventListener("change", (e) => setView("unit", e.target.value));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll(false));
    setInterval(async () => {
      try {
        const prev = live.generated;
        live = await getJSON("data/live.json");
        if (live.generated !== prev) { index = await getJSON("data/index.json"); renderAll(); } else renderHeader();
      } catch (e) { console.warn(e); }
    }, 5 * 60000);
  }

  (async () => {
    readHash();
    try {
      await load();
      bind();
      await renderAll();
    } catch (e) {
      console.error(e);
      $("#updated").innerHTML = `<span class="err">Couldn't load data. Try again in a minute.</span>`;
    }
  })();
})();
