// app.js — the viewer. Loads a building, runs the Sim, draws it on a canvas.
// Open with ?b=<path to a sim.building.v1 file> to load another project.

import { buildGrids, cellAt } from './engine/grid.js';
import { Sim, fmt } from './engine/sim.js';
import { PROFILES, DEFAULT_STAFFING } from './engine/people.js';
import { SCENARIOS } from './engine/scenarios.js';
import { DEFAULT_LIFTS } from './engine/sim.js';
import { KINDS } from './engine/furniture.js';

const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const params = new URLSearchParams(location.search);
const SRC = params.get('b') || './buildings/RCH.building.json';

const state = { lifts: { ...DEFAULT_LIFTS }, staffing: 1, sweep: null, scenario: 'full', shift: 'day', speed: 5, running: false, view: 'all', fire: null, mode: '2d' };
let hasComps = false;
let building, grid, sim, bg = [], layout = [], scale = 1, v3 = null;

init();

// A building file the visitor loaded is kept for this tab, then the page reloads with ?b=local.
const LOCAL_KEY = 'sim.localBuilding';
async function loadBuilding() {
  if (SRC === 'local') {
    let txt = null;
    try { txt = sessionStorage.getItem(LOCAL_KEY); } catch {}
    if (txt) { $('backRch').hidden = false; return JSON.parse(txt); }
    showLoadError('The building you loaded is no longer stored in this tab, so the hospital is shown instead. Load it again with "Load your building…".');
    return (await fetch('./buildings/RCH.building.json')).json();
  }
  if (params.get('b')) $('backRch').hidden = false;
  return (await fetch(SRC)).json();
}
function showLoadError(msg) { const e = $('loadErr'); e.textContent = msg; e.hidden = false; }
$('loadFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const txt = await f.text(), b = JSON.parse(txt);
    const problem = checkBuilding(b);
    if (problem) return showLoadError(`${f.name}: ${problem}`);
    try { sessionStorage.setItem(LOCAL_KEY, txt); } catch { return showLoadError(`${f.name} is too big to keep in this browser tab (${(txt.length / 1e6).toFixed(1)} MB). Run the sim locally instead (see the README).`); }
    location.search = '?b=local';
  } catch (err) { showLoadError(`${f.name} is not a building file: ${err.message}`); }
});
// The minimum a building file needs, with friendly messages.
function checkBuilding(b) {
  if (b?.schema !== 'sim.building.v1') return 'this is not a sim.building.v1 file. Convert your model with tools/ifc_to_building.py first.';
  for (const k of ['levels', 'walls', 'doors', 'rooms']) if (!Array.isArray(b[k]) || !b[k].length) return `it has no ${k}.`;
  return null;
}
// Fill in anything an adapter left out, so hand-made or partial files still run.
function normalise(b) {
  b.project ||= { code: 'MY', name: 'Your building' };
  b.vertical ||= [];
  for (const w of b.walls) w.t ??= 0.2;
  for (const d of b.doors) { d.fire ??= ''; d.kind ??= 'single'; d.width ??= 0.9; d.axis ??= 'x'; }
  for (const r of b.rooms) {
    r.kind ||= 'room'; r.name ??= r.id; r.number ??= ''; r.area ??= 0; r.occupancy ??= 0; r.beds ??= 0;
    r.dependency ??= 'independent'; r.compartment ??= ''; r.dept ??= '';
  }
  return b;
}

async function init() {
  building = normalise(await loadBuilding());
  $('proj').textContent = building.project.name;
  grid = buildGrids(building);
  sim = new Sim(building, grid);
  // default fire for horizontal evacuation: the first single bedroom on the first ward floor
  state.fire = building.rooms.findIndex(r => r.level === 'L01' && /bedroom/i.test(r.name));
  if (state.fire < 0) state.fire = Math.max(0, building.rooms.findIndex(r => r.kind === 'room' && r.compartment));
  // Sideways (horizontal) evacuation needs fire compartments; plain models usually have none.
  hasComps = new Set(building.rooms.map(r => r.compartment).filter(Boolean)).size > 1;

  for (const [id, sc] of Object.entries(SCENARIOS)) if (!sc.needsFire || hasComps) $('scenario').add(new Option(sc.label, id));
  $('scenario').onchange = e => { state.scenario = e.target.value; reset(); };
  seg('shift', v => { state.shift = v; state.staffing = DEFAULT_STAFFING[v]; $('staffing').value = toSlider(state.staffing); reset(); });
  $('staffing').oninput = e => { state.staffing = fromSlider(+e.target.value); $('staffingVal').textContent = pct(state.staffing); };
  $('staffing').onchange = reset;
  $('sweep').onclick = sweep;
  // lift & stair variables: every change restarts the run with the new settings
  const units = { liftCap: v => `${v} ppl`, liftSpeed: v => `${(+v).toFixed(1)} m/s`, liftDoor: v => `${v} s`, bedStair: v => `${v} s`, chairStair: v => `${v} s` };
  const keys = { liftCap: 'capacity', liftSpeed: 'speed', liftDoor: 'doorTime', bedStair: 'bedStairSeconds', chairStair: 'chairStairSeconds' };
  for (const [id, key] of Object.entries(keys)) {
    const el = $(id), out = document.querySelector(`b[data-for=${id}]`);
    out.textContent = units[id](el.value);
    el.oninput = () => { out.textContent = units[id](el.value); };
    el.onchange = () => { state.lifts[key] = +el.value; reset(); };
  }
  $('liftUse').onchange = e => { state.lifts.use = e.target.value; reset(); };
  seg('liftN', v => { state.lifts.inService = +v; reset(); });
  $('orbit').onchange = e => { if (v3) { v3.controls.autoRotate = e.target.checked; v3.controls.autoRotateSpeed = 0.6; } };
  seg('speed', v => { state.speed = +v; });
  seg('mode', v => setMode(v));
  seg('wallH', v => { if (v3) { v3.opts.wallH = +v; v3.rebuild(sim, roomColour); } });
  $('explode').oninput = e => { if (v3) { v3.opts.explode = +e.target.value; v3.rebuild(sim, roomColour); } };
  $('seed').onchange = reset;
  $('play').onclick = () => { if (sim.done) reset(); state.running = !state.running; $('play').textContent = state.running ? 'Pause' : 'Run'; };
  $('reset').onclick = reset;
  $('legend').innerHTML = Object.values(PROFILES).map(p => `<div><i style="background:${p.colour}"></i>${p.label}</div>`).join('') +
    `<div><i style="background:var(--safe)"></i>Safe</div><div><i style="background:var(--fire)"></i>Fire (click a room to move it)</div>`;

  const cv = $('view');
  cv.addEventListener('mousemove', hover);
  cv.addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });
  cv.addEventListener('click', clickRoom);
  new ResizeObserver(() => { relayout(); draw(); }).observe($('stage'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { paintBackgrounds(); draw(); v3?.rebuild(sim, roomColour); });
  reset();
  window.peopleSim = { get sim() { return sim; }, get view3d() { return v3; } };   // handy from the browser console
  requestAnimationFrame(loop);
}

function seg(id, fn) {
  $(id).querySelectorAll('button').forEach(b => b.onclick = () => {
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); fn(b.dataset.v);
  });
}

function reset() {
  state.running = false; $('play').textContent = 'Run';
  const sc = SCENARIOS[state.scenario];
  sim.reset({ lifts: state.lifts, staffing: state.staffing, scenario: state.scenario, shift: state.shift, seed: +$('seed').value || 1, fire: (sc.needsFire || state.fireAlways) && state.fire >= 0 ? { room: state.fire } : null });
  $('scDesc').textContent = sc.describe;
  $('staffingVal').textContent = `${pct(state.staffing)} · ${sim.staffCount} staff`;
  if (state.sweep && state.sweep.key !== sweepKey()) state.sweep = null;   // the curve belongs to other settings
  curve();
  $('fireHint').textContent = sc.needsFire ? `🔥 ${building.rooms[state.fire].name} (${building.rooms[state.fire].compartment}). Click any room to start the fire there.` : '';
  if (sc.needsFire) state.view = building.rooms[state.fire].level;
  tabs(); relayout(); paintBackgrounds(); panel(); draw();
  applyLevels();          // 3D: show floors up to the one in view, and repaint the fire room
}

// 3D is loaded only when first asked for, so the 2D view never waits for three.js.
async function setMode(mode) {
  state.mode = mode;
  if (mode === '3d' && !v3) {
    const { View3D } = await import('./view3d.js');
    v3 = new View3D($('view3d'), building, grid, { css, onPick: ({ ri }) => setFire(ri) });
    v3.rebuild(sim, roomColour);
  }
  $('view').hidden = mode === '3d'; $('view3d').hidden = mode !== '3d'; $('opts3d').hidden = mode !== '3d';
  relayout(); applyLevels();
}
function applyLevels() {
  if (!v3) return;
  const li = state.view === 'all' ? grid.levels.length - 1 : grid.levels.findIndex(g => g.code === state.view);
  v3.setLevels(li); v3.rebuild(sim, roomColour);
}

function tabs() {
  const counts = grid.levels.map(() => 0);
  for (const a of sim.agents) if (!a.hidden && a.state !== 'onstair' && a.state !== 'safe') counts[a.level]++;
  const items = [['all', 'All levels'], ...grid.levels.map((g, i) => [g.code, `${g.code} · ${counts[i]}`])];
  $('tabs').innerHTML = items.map(([v, l]) => `<button data-v="${v}" class="${state.view === v ? 'on' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { state.view = b.dataset.v; tabs(); relayout(); draw(); applyLevels(); });
}

// ------------------------------------------------------------------ layout & background
function relayout() {
  if (state.mode === '3d' && v3) {
    const w = $('stage').clientWidth - 32;
    v3.resize(w, Math.max(360, Math.min(innerHeight - 170, w * 0.72)));
  }
  const cv = $('view'), f = grid.frame;
  const shown = grid.levels.filter(g => state.view === 'all' || g.code === state.view);
  const width = $('stage').clientWidth - 32;
  scale = width / (f.W * f.cell);
  const levelH = f.H * f.cell * scale, gap = 28;
  layout = shown.map((g, k) => ({ g, ox: 0, oy: k * (levelH + gap) + 22 }));
  const dpr = devicePixelRatio || 1;
  cv.style.height = (shown.length * (levelH + gap)) + 'px';
  cv.width = width * dpr; cv.height = shown.length * (levelH + gap) * dpr;
}

// world (m) -> canvas px. North is up.
const sx = (L, x) => L.ox + (x - grid.frame.minX) * scale;
const sy = (L, y) => L.oy + (grid.frame.minY + grid.frame.H * grid.frame.cell - y) * scale;

// One colour rule for both views: compartment tint, stairs/lifts lilac, the fire room reddened.
function roomColour(ri) {
  if (ri < 0) return css('--floor');
  const r = building.rooms[ri];
  if (r.kind === 'stair' || r.kind === 'lift') return css('--stair');
  const comps = roomColour.comps ||= [...new Set(building.rooms.map(q => q.compartment.replace(/^L\d+-/, '')))].sort();
  let col = hex(css(['--comp-a', '--comp-b', '--comp-c', '--comp-d'][comps.indexOf(r.compartment.replace(/^L\d+-/, '')) % 4]));
  if (ri === state.fire && SCENARIOS[state.scenario].needsFire) col = mix(col, hex(css('--fire')), 0.35);
  return '#' + col.map(v => v.toString(16).padStart(2, '0')).join('');
}

function paintBackgrounds() {
  const outside = hex(css('--outside'));
  const cache = new Map(), roomColourCached = ri => cache.get(ri) ?? (cache.set(ri, roomColour(ri)), cache.get(ri));
  bg = grid.levels.map(g => {
    const c = document.createElement('canvas'); c.width = g.W; c.height = g.H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(g.W, g.H);
    for (let cy = 0; cy < g.H; cy++) for (let cx = 0; cx < g.W; cx++) {
      const i = cy * g.W + cx, o = ((g.H - 1 - cy) * g.W + cx) * 4;
      let col = outside;
      if (!g.outside[i]) {
        col = hex(roomColourCached(g.room[i]));
      }
      img.data.set([col[0], col[1], col[2], 255], o);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
}

// ------------------------------------------------------------------ drawing
function draw() {
  const cv = $('view'), ctx = cv.getContext('2d'), dpr = devicePixelRatio || 1, f = grid.frame;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const wall = css('--wall'), door = css('--door'), ink = css('--ink'), muted = css('--muted'), safeC = css('--safe'), fireC = css('--fire');
  for (const L of layout) {
    const g = L.g, li = g.index;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg[li], L.ox, L.oy, g.W * f.cell * scale, g.H * f.cell * scale);
    ctx.fillStyle = ink; ctx.font = '600 13px system-ui'; ctx.fillText(building.levels[li].name || g.code, L.ox + 4, L.oy - 7);
    // walls
    ctx.strokeStyle = wall; ctx.lineCap = 'butt';
    for (const w of building.walls) if (w.level === g.code) {
      ctx.lineWidth = Math.max(1, w.t * scale);
      ctx.beginPath(); ctx.moveTo(sx(L, w.x1), sy(L, w.y1)); ctx.lineTo(sx(L, w.x2), sy(L, w.y2)); ctx.stroke();
    }
    // doors: punch the opening back out of the wall
    ctx.fillStyle = door;
    for (const d of building.doors) if (d.level === g.code) {
      const [hx, hy] = d.axis === 'x' ? [d.width / 2, 0.2] : [0.2, d.width / 2];
      ctx.fillRect(sx(L, d.x - hx), sy(L, d.y + hy), 2 * hx * scale, 2 * hy * scale);
    }
    // room labels when zoomed in
    if (scale > 9) {
      ctx.fillStyle = muted; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
      for (const r of building.rooms) if (r.level === g.code && r.area > 20 && r.kind !== 'corridor')
        ctx.fillText(r.name.length > 22 ? r.name.slice(0, 21) + '…' : r.name, sx(L, r.x), sy(L, r.y));
      ctx.textAlign = 'start';
    }
    // furniture
    for (const it of grid.furniture) {
      if (it.level !== li || sim.hiddenItems.has(it)) continue;
      ctx.fillStyle = KINDS[it.kind][1]; ctx.globalAlpha = it.blocks ? 0.85 : 0.55;
      ctx.fillRect(sx(L, it.x0), sy(L, it.y1), (it.x1 - it.x0) * scale, (it.y1 - it.y0) * scale);
    }
    ctx.globalAlpha = 1;
    // lifts: car position and waiting queue on each floor
    for (const car of sim.cars) {
      const r = building.rooms[sim.roomIndex[car.shaft.rooms[g.code]]];
      if (!r) continue;
      const here = Math.abs(car.pos - li) < 0.05, x = sx(L, r.x), y = sy(L, r.y), q = car.queue[li].length;
      ctx.fillStyle = here ? css('--accent') : 'transparent'; ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5;
      ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10);
      ctx.fillStyle = ink; ctx.font = '600 11px system-ui';
      if (q) ctx.fillText(`⧗${q}`, x + 8, y + 4);
      if (here && car.load.length) ctx.fillText(`${car.load.length}`, x - 3, y - 8);
    }
    // fire
    if (sim.fire && sim.fire.levelIndex === li) {
      const r = building.rooms[sim.fire.room], p = 1 + 0.15 * Math.sin(performance.now() / 200);
      const grd = ctx.createRadialGradient(sx(L, r.x), sy(L, r.y), 0, sx(L, r.x), sy(L, r.y), 3 * scale * p);
      grd.addColorStop(0, fireC); grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx(L, r.x), sy(L, r.y), 3 * scale * p, 0, 7); ctx.fill();
    }
    // people
    for (const a of sim.agents) {
      if (a.level !== li || a.hidden || a.state === 'onstair' || a.state === 'inlift') continue;
      const x = sx(L, a.x), y = sy(L, a.y), rr = Math.max(1.6, a.radius * scale);
      if (a.state === 'safe') { if (sim.t - a.tSafe > 8) continue; ctx.globalAlpha = 0.5; ctx.fillStyle = safeC; }
      else { ctx.globalAlpha = a.state === 'hold' ? 0.45 : 1; ctx.fillStyle = a.P.colour; }
      if (a.state === 'refuge') ctx.globalAlpha = 0.6;
      if (a.state === 'escorting') { ctx.strokeStyle = a.P.colour; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(sx(L, a.escort.x), sy(L, a.escort.y)); ctx.stroke(); }
      if (a.profile === 'bed') {
        const sp = Math.hypot(a.vx, a.vy), ang = sp > 0.05 ? Math.atan2(a.vy, a.vx) : (a.heading ?? 0);
        ctx.save(); ctx.translate(x, y); ctx.rotate(-ang); ctx.fillRect(-1.05 * scale, -0.47 * scale, 2.1 * scale, 0.94 * scale); ctx.restore();
      } else { ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill(); }
      if (a.state === 'waiting') {
        ctx.strokeStyle = a.P.colour; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, rr + 2 + 2 * Math.sin(performance.now() / 180), 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // stair queues
    ctx.fillStyle = ink; ctx.font = '600 11px system-ui';
    for (const [key, st] of sim.stairs) {
      const [shaft, l] = key.split('|');
      if (+l !== li || !st.transit.length) continue;
      const s = building.vertical.find(v => v.name === shaft), r = building.rooms[sim.roomIndex[s.rooms[g.code]]];
      ctx.fillText(`↓${st.transit.length}`, sx(L, r.x) + 4, sy(L, r.y) - 4);
    }
  }
}

// ------------------------------------------------------------------ side panel
function panel() {
  const last = sim.series.at(-1) || { remaining: 0, waiting: 0, safe: 0 };
  $('sTime').textContent = fmt(sim.t);
  $('sLeft').textContent = last.remaining;
  $('sSafe').textContent = last.safe;
  $('sWait').textContent = last.waiting;
  hud(last);
  $('liftStatus').innerHTML = !sim.cars.length ? (state.lifts.use === 'off' ? 'Stairs only. Pick who may use the evacuation lifts above.' : 'Lifts only run in a full evacuation.')
    : sim.cars.map(c => {
      const where = c.state === 'moving' ? `${c.to < c.from ? '▼' : '▲'} ${grid.levels[c.from].code}→${grid.levels[c.to].code}` : `■ ${grid.levels[c.level].code}${c.state === 'doors' ? ' doors open' : ''}`;
      const waiting = c.queue.reduce((s, q) => s + q.length, 0);
      return `<div><b style="color:var(--ink)">${c.name}</b> ${where} · ${c.load.length} aboard · ${waiting} waiting · ${c.trips} trips, ${c.carried} people down</div>`;
    }).join('');
  $('log').innerHTML = sim.events.slice().reverse().map(e => `<li><time>${fmt(e.t)}</time>${esc(e.msg)}</li>`).join('');
  const ex = [...sim.exitUse].sort((a, b) => b[1] - a[1]);
  $('exits').innerHTML = ex.length ? ex.map(([d, n]) => `<tr><td>${building.doors[d].id} <span style="color:var(--muted)">(${building.doors[d].width.toFixed(1)} m)</span></td><td>${n}</td></tr>`).join('')
    : `<tr><td style="color:var(--muted)">${SCENARIOS[state.scenario].needsFire ? 'No one leaves the building in this scenario.' : 'Not run yet.'}</td></tr>`;
  chart();
}

function chart() {
  const cv = $('chart'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const s = sim.series, max = Math.max(1, sim.total), tMax = Math.max(120, sim.t);
  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  const px = t => 30 + (W - 36) * t / tMax, py = v => 6 + (H - 24) * (1 - v / max);
  ctx.beginPath(); ctx.moveTo(30, py(0)); ctx.lineTo(W - 6, py(0)); ctx.stroke();
  ctx.fillText(max, 2, py(max) + 8); ctx.fillText('0', 18, py(0) + 3);
  for (let m = 0; m <= tMax / 60; m += Math.max(1, Math.round(tMax / 60 / 5))) ctx.fillText(`${m}m`, px(m * 60) - 6, H - 4);
  const line = (key, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
    s.forEach((c, k) => k ? ctx.lineTo(px(c.t), py(c[key])) : ctx.moveTo(px(c.t), py(c[key])));
    ctx.stroke();
  };
  line('remaining', css('--accent'));
  line('waiting', PROFILES.wheelchair.colour);
}

// ------------------------------------------------------------------ staffing sweep
// Re-run the current scenario headless at each staffing level. Each run takes well
// under a second, and we yield to the browser between runs so the page stays alive.
const sweepKey = () => [state.scenario, state.shift, $('seed').value, state.fire, JSON.stringify(state.lifts)].join('|');
async function sweep() {
  const levels = [0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5];
  const sc = SCENARIOS[state.scenario], fire = sc.needsFire && state.fire >= 0 ? { room: state.fire } : null;
  const probe = new Sim(building, grid);
  state.sweep = { key: sweepKey(), points: [] };
  $('sweep').disabled = true;
  for (const f of levels) {
    $('sweepStatus').textContent = `running ${pct(f)}…`;
    await new Promise(r => setTimeout(r, 0));
    probe.reset({ lifts: state.lifts, scenario: state.scenario, shift: state.shift, seed: +$('seed').value || 1, fire, staffing: f });
    while (!probe.done && probe.t < 3600) probe.step();
    const waiting = probe.agents.filter(a => a.state === 'waiting').length;
    state.sweep.points.push({ f, staff: probe.staffCount, t: probe.done ? probe.t : null, waiting });
    curve();
  }
  const ok = state.sweep.points.filter(p => p.t != null);
  const knee = ok.find(p => p.t <= Math.min(...ok.map(q => q.t)) * 1.1);
  $('sweepStatus').textContent = knee ? `within 10% of the best time from ${knee.staff} staff (${pct(knee.f)})` : 'no level got everyone out within an hour';
  $('sweep').disabled = false;
}

function curve() {
  const cv = $('curve'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const pts = state.sweep?.points || [];
  ctx.fillStyle = css('--muted'); ctx.font = '11px system-ui';
  if (!pts.length) { ctx.fillText('Not run for these settings yet.', 4, 16); return; }
  const tMax = Math.max(60, ...pts.map(p => p.t ?? 0)) * 1.1, L = 34, B = H - 30;
  // x = number of staff on a log scale; staffing fractions map to staff via the sweep points
  const sMin = Math.max(1, Math.min(...pts.map(p => p.staff))), sMax = Math.max(sMin * 10, ...pts.map(p => p.staff), sim.staffCount);
  const lx = n => L + (W - L - 8) * Math.log(Math.max(n, sMin) / sMin) / Math.log(sMax / sMin);
  const staffAt = f => { const p = pts.find(q => q.f === f); return p ? p.staff : f * sMax / 1.5; };
  const px = f => lx(staffAt(f)), py = t => 8 + (B - 8) * (1 - t / tMax);
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, B); ctx.lineTo(W - 8, B); ctx.stroke();
  for (let m = 0; m <= tMax / 60; m += Math.max(1, Math.round(tMax / 60 / 4))) { ctx.fillText(`${m}m`, 4, py(m * 60) + 4); }
  for (const n of [5, 10, 20, 50, 100, 200, 500, 1000]) if (n >= sMin && n <= sMax) ctx.fillText(n, lx(n) - 6, B + 14);
  ctx.fillText('staff on duty', W / 2 - 30, H - 3);
  // current slider position
  ctx.strokeStyle = css('--muted'); ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(lx(sim.staffCount), 8); ctx.lineTo(lx(sim.staffCount), B); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.beginPath();
  let started = false;
  for (const p of pts) if (p.t != null) { started ? ctx.lineTo(px(p.f), py(p.t)) : ctx.moveTo(px(p.f), py(p.t)); started = true; } else started = false;
  ctx.stroke();
  for (const p of pts) {
    ctx.fillStyle = p.t == null ? css('--fire') : css('--accent');
    ctx.beginPath(); ctx.arc(px(p.f), p.t == null ? 12 : py(p.t), 3.5, 0, 7); ctx.fill();
  }
  // hover-free labels: time at each end and the slider position
  ctx.fillStyle = css('--ink');
  const here = pts.reduce((a, b) => Math.abs(Math.log(b.f / state.staffing)) < Math.abs(Math.log(a.f / state.staffing)) ? b : a);
  ctx.fillText(here.t != null ? `${fmt(here.t)} with ${here.staff} staff` : `not clear in 1 h · ${here.waiting} left`, Math.min(px(here.f) + 6, W - 120), here.t != null ? py(here.t) - 8 : 26);
}

// ------------------------------------------------------------------ interaction
function pick(ev) {
  const r = $('view').getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  for (const L of layout) {
    const wx = grid.frame.minX + (x - L.ox) / scale, wy = grid.frame.minY + grid.frame.H * grid.frame.cell - (y - L.oy) / scale;
    const i = cellAt(L.g, wx, wy);
    if (i >= 0 && y >= L.oy && y <= L.oy + L.g.H * L.g.cell * scale) return { L, ri: L.g.room[i], x, y };
  }
  return null;
}
function hover(ev) {
  const p = pick(ev), tip = $('tip');
  if (!p || p.ri < 0) { tip.style.display = 'none'; return; }
  const r = building.rooms[p.ri];
  const here = sim.agents.filter(a => a.room === p.ri && a.level === p.L.g.index && a.state !== 'safe').length;
  tip.innerHTML = `<b>${esc(r.name)}</b><br>${r.number} · ${r.compartment} · ${r.area} m²<br>Design occupancy ${r.occupancy}${r.beds ? ` · ${r.beds} bed(s), ${r.dependency}` : ''}`;
  tip.style.display = 'block'; tip.style.left = (p.x + 30) + 'px'; tip.style.top = (p.y + 56) + 'px';
}
function clickRoom(ev) {
  const p = pick(ev);
  if (p && p.ri >= 0) setFire(p.ri);
}
function setFire(ri) {
  const p = { ri };
  const r = building.rooms[p.ri];
  if (!hasComps || r.kind === 'stair' || r.kind === 'lift' || r.level === undefined) return;
  state.fire = p.ri;
  if (!SCENARIOS[state.scenario].needsFire) { state.scenario = 'horizontal'; $('scenario').value = 'horizontal'; }
  reset();
}

// ------------------------------------------------------------------ main loop
let lastPanel = 0, lastFrame = performance.now(), acc = 0;
function loop(now) {
  const dt = Math.min(0.5, (now - lastFrame) / 1000); lastFrame = now;   // keep the speed honest at low frame rates
  if (state.running && !sim.done) {
    acc += dt * state.speed;
    let steps = 0;
    while (acc >= 0.1 && steps < 600) { sim.step(); acc -= 0.1; steps++; }
    if (sim.done) { state.running = false; $('play').textContent = 'Run again'; panel(); tabs(); }
  }
  if (state.mode === '3d' && v3) v3.render(sim, now); else draw();
  if (now - lastPanel > 250) { panel(); if (state.running) tabs(); lastPanel = now; }
  requestAnimationFrame(loop);
}

// On-screen summary for recordings: clock, who is left, and the settings that matter.
function hud(last) {
  $('hTime').textContent = fmt(sim.t);
  $('hLine').textContent = sim.done ? `Everyone safe in ${fmt(sim.t)}` : `${last.remaining} still to reach safety`;
  const lift = { off: 'stairs only', beds: 'lifts for beds', dependent: 'lifts for dependent patients', everyone: 'lifts for everyone' }[state.lifts.use];
  $('hSub').textContent = `${SCENARIOS[state.scenario].label.replace(/ \(.*\)/, '')} · ${state.shift} · ${sim.staffCount} staff · ${lift}${sim.cars.length ? ` ×${sim.cars.length}` : ''}`;
}

// ------------------------------------------------------------------ utils
// The staffing slider is logarithmic: 0..100 maps to 1%..150% of design staffing.
const fromSlider = v => +(0.01 * Math.pow(150, v / 100)).toFixed(3);
const toSlider = f => Math.round(100 * Math.log(f / 0.01) / Math.log(150));
const pct = f => f < 0.1 ? `${(f * 100).toFixed(f < 0.02 ? 1 : 0)}%` : `${Math.round(f * 100)}%`;
function hex(s) {
  s = s.replace('#', ''); if (s.length === 3) s = [...s].map(c => c + c).join('');
  return [0, 2, 4].map(k => parseInt(s.slice(k, k + 2), 16));
}
const mix = (a, b, t) => a.map((v, k) => Math.round(v * (1 - t) + b[k] * t));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
