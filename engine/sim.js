// sim.js — the simulation loop. Each step (0.1 s of building time):
//   1. a dispatcher sends free staff to dependent patients who are waiting
//   2. every person picks a direction (down the flow field, or towards a patient)
//   3. people push apart from each other and slow down in crowds
//   4. people who reach a stair join its queue; people who reach safety are counted
//
// States:  idle (before reacting) · moving · waiting (needs help) · responding (staff on the way)
//          escorting (staff attached to a patient) · onstair · safe · refuge · hold (told to stay)

import { buildGrids, flowField, downhill, cellAt, walkable, cellCentre } from './grid.js';
import { PROFILES, populate, between, crowdFactor, DEFAULT_STAFFING } from './people.js';
import { SCENARIOS } from './scenarios.js';

const DT = 0.1;
const STAIR_SECONDS = 14;        // time to walk one storey of stairs at 1.2 m/s
const STAIR_HEADWAY = 0.8;       // seconds between people entering one stair (about 1.25 people/s)
const ATTACH_DIST = 1.3;
const STOREY = 4.5;              // metres floor to floor, for lift travel time

// Evacuation lifts. `use`: off | beds (bed-bound patients) | dependent (beds + wheelchairs) | everyone
export const DEFAULT_LIFTS = { use: 'off', inService: 2, capacity: 13, speed: 1.0, doorTime: 12,
  // how long it takes staff to bring a patient down one storey of stairs (evac mattress / evac chair)
  bedStairSeconds: 150, chairStairSeconds: 60 };
const LIFT_WEIGHT = { bed: 10, wheelchair: 3 };      // a bed and its 2 staff fill most of a 13-person bed lift

export class Sim {
  constructor(building, grid = null) {
    this.building = building;
    this.grid = grid || buildGrids(building);
    this.roomIndex = Object.fromEntries(building.rooms.map((r, i) => [r.id, i]));
    this.roomCells = building.rooms.map(() => []);
    this.grid.levels.forEach(g => { for (let i = 0; i < g.room.length; i++) if (g.room[i] >= 0 && !g.blocked[i]) this.roomCells[g.room[i]].push(i); });
    this.levelOf = Object.fromEntries(this.grid.levels.map((g, i) => [g.code, i]));
    this.stairRoom = new Map();   // room index -> {shaft, levelIndex}
    for (const s of building.vertical) if (s.kind === 'stair')
      for (const [code, rid] of Object.entries(s.rooms)) this.stairRoom.set(this.roomIndex[rid], { shaft: s.name, li: this.levelOf[code] });
  }

  // fire = { room: roomIndex } or null
  reset({ scenario = 'full', shift = 'day', seed = 1, fire = null, staffing = DEFAULT_STAFFING[shift], lifts = {} } = {}) {
    this.rand = mulberry32(seed);
    this.t = 0; this.done = false; this.events = [];
    this.fire = fire ? { room: fire.room, levelIndex: this.levelOf[this.building.rooms[fire.room].level] } : null;
    this.scenarioId = scenario;
    this.sc = SCENARIOS[scenario].setup(this);
    this.roomFieldCache = new Map();
    this.stairFields = null;
    this.waitLogged = new Set();
    this.stairs = new Map();      // `${shaft}|${li}` -> { nextEntry, transit: [] }
    this.exitUse = new Map();
    this.series = [];
    this.agents = [];
    this.usedSlots = new Set(); this.hiddenItems = new Set();
    this.setupLifts({ ...DEFAULT_LIFTS, ...lifts });
    this.staffing = staffing;
    for (const p of populate(this.building, shift, this.rand, staffing)) this.spawn(p.room, p.profile);
    this.staffCount = this.agents.filter(a => a.profile === 'staff').length;
    for (const a of this.agents) {
      a.mover = this.sc.movers(a);
      if (!a.mover) a.state = 'hold';
    }
    this.total = this.agents.filter(a => a.mover).length;
    this.log(`${this.agents.length} people in the building (${shift}, ${this.staffCount} staff at ${Math.round(staffing * 100)}% staffing); ${this.total} must move. ${this.sc.label || SCENARIOS[scenario].label}.`);
    this.sample();
  }

  spawn(ri, profile) {
    const cells = this.roomCells[ri];
    if (!cells.length) return;
    const room = this.building.rooms[ri], li = this.levelOf[room.level], g = this.grid.levels[li];
    const P = PROFILES[profile];
    let x, y, heading;
    // furniture slots first: bed patients in their beds, wheelchair users beside theirs, others on a seat
    const sl = this.grid.slots?.[ri], pool = profile === 'bed' ? sl?.bed : profile === 'wheelchair' ? sl?.side : sl?.seat;
    const slot = pool?.find(q => !this.usedSlots.has(q));
    if (slot) {
      this.usedSlots.add(slot); x = slot.x; y = slot.y; heading = slot.heading;
      if (slot.item) this.hiddenItems.add(slot.item);    // the patient is drawn as the bed
    }
    for (let tries = 0; tries < 25 && !slot; tries++) {
      const i = cells[(this.rand() * cells.length) | 0];
      if (g.nearWall[i]) continue;
      [x, y] = cellCentre(g, i);
      x += (this.rand() - 0.5) * g.cell; y += (this.rand() - 0.5) * g.cell;
      if (!this.agents.some(b => b.level === li && Math.hypot(b.x - x, b.y - y) < b.radius + P.radius)) break;
    }
    if (x == null) return;
    this.agents.push({
      id: this.agents.length, profile, P, level: li, x, y, vx: 0, vy: 0, room: ri, radius: P.radius,
      state: 'idle', tGo: between(this.rand, P.premove), helpers: [], escort: null, patient: null, lastDoor: -1, tSafe: null, heading,
      seated: !!slot && pool === sl.seat,
    });
  }

  // Cost multiplier per cell: the room on fire is very unattractive to walk through.
  hazardCost(li) {
    if (!this.fire || this.fire.levelIndex !== li) return null;
    const g = this.grid.levels[li], fr = this.fire.room;
    return i => g.room[i] === fr ? 25 : 1;
  }

  // Route to one waiting patient (they don't move until their helpers arrive, so cache it).
  bedsideField(p) {
    if (!p.field || p.fieldLevel !== p.level) {
      const g = this.grid.levels[p.level], i = cellAt(g, p.x, p.y);
      p.field = flowField(g, new Map([[i, 0]]), this.hazardCost(p.level)); p.fieldLevel = p.level;
    }
    return p.field;
  }

  roomField(li, ri) {
    const key = li + ':' + ri;
    if (!this.roomFieldCache.has(key)) {
      const src = new Map(this.roomCells[ri].map(i => [i, 0]));
      this.roomFieldCache.set(key, flowField(this.grid.levels[li], src, this.hazardCost(li)));
    }
    return this.roomFieldCache.get(key);
  }

  log(msg) { this.events.push({ t: this.t, msg }); }

  // ------------------------------------------------------------------ main step
  step() {
    if (this.done) return;
    this.t += DT;
    const tick = Math.round(this.t / DT);
    if (tick % 10 === 0) this.dispatch();
    this.buildHash();
    for (const a of this.agents) this.think(a);
    for (const a of this.agents) this.move(a);
    this.updateStairs();
    this.updateLifts();
    for (const a of this.agents) if (a.state === 'escorting') this.follow(a);
    if (tick % 10 === 0) this.sample();
    if (this.remaining() === 0 && !this.done) {
      this.done = true; this.sample();
      this.log(`Everyone who had to move is safe after ${fmt(this.t)}.`);
    }
  }

  remaining() {
    let n = 0;
    for (const a of this.agents) if (a.mover && a.state !== 'safe' && a.state !== 'refuge' && a.state !== 'trapped' && !(a.profile === 'staff' && a.state !== 'escorting' && this.isSafeAt(a))) n++;
    return n;
  }
  isSafeAt(a) {
    const i = cellAt(this.grid.levels[a.level], a.x, a.y);
    return i >= 0 && this.sc.safe[a.level][i] === 1;
  }

  sample() {
    const c = { t: this.t, remaining: this.remaining(), waiting: 0, onstair: 0, safe: 0 };
    for (const a of this.agents) {
      if (a.state === 'waiting') c.waiting++;
      else if (a.state === 'onstair') c.onstair++;
      else if (a.state === 'safe' || a.state === 'refuge') c.safe++;
    }
    this.series.push(c);
  }

  // ---------------------------------------------------- dispatcher (staff -> patients)
  dispatch() {
    const needy = this.agents.filter(a => a.mover && a.state === 'waiting' && a.helpers.length + a.pending < a.P.helpers);
    if (!needy.length) return;
    // one line per floor when patients have been waiting for help for two minutes
    for (const p of needy) {
      const code = this.grid.levels[p.level].code;
      if (this.t - p.tGo > 120 && !this.waitLogged.has(code)) {
        this.waitLogged.add(code);
        this.log(`${code}: ${needy.filter(q => q.level === p.level).length} dependent patients still waiting for staff after 2:00.`);
      }
    }
    // free staff: anyone not already busy, including staff told to stay put elsewhere on the same floor
    const free = this.agents.filter(s => s.profile === 'staff' && this.t >= s.tGo && !s.patient &&
      (s.state === 'moving' || s.state === 'safe' || s.state === 'refuge' || s.state === 'idle' || s.state === 'hold'));
    for (const p of needy) {
      while (p.helpers.length + p.pending < p.P.helpers) {
        let best = null, bd = Infinity;
        for (const s of free) {
          if (s.patient) continue;
          if (s.level !== p.level && !this.sc.useStairs) continue;     // only cross floors when stairs are in play
          const d = Math.hypot(s.x - p.x, s.y - p.y) + Math.abs(s.level - p.level) * 40;
          if (d < bd) { bd = d; best = s; }
        }
        if (!best) break;
        best.patient = p; best.state = 'responding'; best.hidden = false; p.pending++;
      }
    }
  }

  // ------------------------------------------------------- decide what to do
  think(a) {
    if (a.state === 'idle' && this.t >= a.tGo && a.mover) {
      if (a.P.helpers) { a.state = 'waiting'; a.pending = 0; }
      else a.state = 'moving';
    }
    if (a.state === 'safe' || a.state === 'refuge') return;
    if (a.state === 'moving') {
      if (this.isSafeAt(a)) return this.reachSafety(a);
      const g = this.grid.levels[a.level], f = this.routeField(a), i = cellAt(g, a.x, a.y);
      if (!f || i < 0 || f[i] >= flowField.INF) {           // no route to safety from here
        a.state = 'trapped';
        this.log(`A ${a.P.label.toLowerCase()} in ${this.building.rooms[a.room].name} has no route to safety.`);
      }
    }
  }

  reachSafety(a) {
    a.state = this.sc.refuge ? 'refuge' : 'safe'; a.tSafe = this.t;
    if (a.lastDoor >= 0 && !this.sc.refuge) this.exitUse.set(a.lastDoor, (this.exitUse.get(a.lastDoor) || 0) + 1);
    for (const s of a.helpers) { s.state = 'moving'; s.escort = null; s.patient = null; if (this.isSafeAt(s)) { s.state = this.sc.refuge ? 'refuge' : 'safe'; s.tSafe = this.t; } }
    a.helpers = [];
  }

  // ------------------------------------------------------- movement
  buildHash() {
    this.hash = new Map();
    for (const a of this.agents) {
      if (a.state === 'onstair' || a.state === 'inlift' || a.state === 'escorting' || a.state === 'safe' || a.state === 'refuge') continue;
      const k = hkey(a.level, a.x, a.y);
      let b = this.hash.get(k); if (!b) this.hash.set(k, b = []); b.push(a);
    }
  }

  move(a) {
    const g = this.grid.levels[a.level];
    let dir = [0, 0], speed = 0;
    if (a.state === 'moving') {
      const field = this.routeField(a);
      if (!field) return;
      dir = downhill(g, field, a.x, a.y);
      speed = a.helpers.length ? a.P.escortSpeed : a.P.speed;
    } else if (a.state === 'responding') {
      const p = a.patient;
      if (Math.hypot(p.x - a.x, p.y - a.y) < ATTACH_DIST) { this.attach(a, p); return; }
      const here = cellAt(g, a.x, a.y);
      if (p.level !== a.level) {                                   // wrong floor: head for a stair
        const sr = here >= 0 ? this.stairRoom.get(g.room[here]) : null;
        if (sr && sr.li === a.level) { this.climb(a, sr.shaft, p.level > a.level ? 1 : -1); return; }
        dir = downhill(g, this.stairField(a.level), a.x, a.y);
      } else dir = downhill(g, this.bedsideField(p), a.x, a.y);    // a walking route right to the patient
      speed = a.P.speed;
    } else if ((a.state === 'safe' || a.state === 'refuge') && this.t - a.tSafe < 6) {
      // drift a little further into safety so the doorway stays clear
      const m = Math.hypot(a.vx, a.vy);
      if (m > 0.05) { a.x += a.vx / m * 0.6 * DT; a.y += a.vy / m * 0.6 * DT; if (!walkable(g, cellAt(g, a.x, a.y))) { a.x -= a.vx / m * 0.6 * DT; a.y -= a.vy / m * 0.6 * DT; } }
      return;
    } else if (a.state === 'hold' || a.state === 'idle') {
      // standing still, but people step aside when someone needs to get past
      this.nudge(a, g); return;
    } else return;

    // stuck for 15 s (e.g. two groups meeting in a doorway)? sidestep for a moment
    if (a.state === 'moving') {
      const f = this.routeField(a)[cellAt(g, a.x, a.y)];
      if (a.bestF == null || f < a.bestF - 0.5) { a.bestF = f; a.tBest = this.t; }
      else if (this.t - a.tBest > 15) {
        if (!a.sidestep || this.t > a.sidestep.until) a.sidestep = { until: this.t + 2, s: this.rand() < 0.5 ? 1 : -1 };
        dir = [dir[0] - dir[1] * a.sidestep.s * 1.2, dir[1] + dir[0] * a.sidestep.s * 1.2];
        const m = Math.hypot(dir[0], dir[1]) || 1; dir = [dir[0] / m, dir[1] / m];
        if (this.t - a.tBest > 19) a.tBest = this.t - 13;   // try again in a few seconds
      }
    }

    // neighbours: push apart, and count density
    let sx = 0, sy = 0, near = 0;
    forNeighbours(this.hash, a, b => {
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1e-3;
      if (d < 1.0) near++;
      const overlap = a.radius + b.radius + 0.05 - d;
      if (overlap > 0) { sx += dx / d * overlap; sy += dy / d * overlap; }
    });
    const density = near / (Math.PI * 1.0);
    const v = speed * crowdFactor(density);
    const tx = dir[0] * v, ty = dir[1] * v;
    a.vx += (tx - a.vx) * Math.min(1, DT / 0.4);
    a.vy += (ty - a.vy) * Math.min(1, DT / 0.4);
    const k = 0.5;
    let nx = a.x + a.vx * DT + sx * k, ny = a.y + a.vy * DT + sy * k;
    // slide along walls
    if (!walkable(g, cellAt(g, nx, ny))) {
      if (walkable(g, cellAt(g, nx, a.y))) ny = a.y;
      else if (walkable(g, cellAt(g, a.x, ny))) nx = a.x;
      else { nx = a.x; ny = a.y; }
    }
    a.x = nx; a.y = ny;
    const ci = cellAt(g, a.x, a.y);
    if (ci >= 0 && g.door[ci] >= 0) a.lastDoor = g.door[ci];
    // reached a stair going down?
    if (a.state === 'moving' && a.level > 0 && ci >= 0 && this.takesLift(a)) {
      if (this.liftField[a.level][ci] < 3) this.joinLift(a);
    } else if (a.state === 'moving' && this.sc.useStairs && a.level > 0 && ci >= 0) {
      const sr = this.stairRoom.get(g.room[ci]);
      if (sr && sr.li === a.level) this.enterStair(a, sr.shaft);
    }
  }

  nudge(a, g) {
    let sx = 0, sy = 0;
    forNeighbours(this.hash, a, b => {
      if (b.state !== 'moving' && b.state !== 'responding') return;   // only yield to people on the move
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1e-3;
      const overlap = a.radius + b.radius + 0.15 - d;
      if (overlap > 0) { sx += dx / d * overlap; sy += dy / d * overlap; }
    });
    if (!sx && !sy) return;
    const nx = a.x + sx * 0.6, ny = a.y + sy * 0.6;
    if (walkable(g, cellAt(g, nx, ny))) { a.x = nx; a.y = ny; }
    else if (walkable(g, cellAt(g, nx, a.y))) a.x = nx;
    else if (walkable(g, cellAt(g, a.x, ny))) a.y = ny;
  }

  attach(s, p) {
    s.state = 'escorting'; s.escort = p; p.pending--; p.helpers.push(s);
    if (p.helpers.length >= p.P.helpers) {
      p.state = 'moving';
      this.log(`${p.helpers.length} staff moving a ${p.P.label.toLowerCase()} from ${this.building.rooms[p.room].name}.`);
    }
  }

  follow(s) {
    const p = s.escort, k = p.helpers.indexOf(s), m = Math.hypot(p.vx, p.vy);
    const ux = m > 0.05 ? p.vx / m : 1, uy = m > 0.05 ? p.vy / m : 0;
    const side = k === 0 ? 1 : -1;
    s.level = p.level; s.hidden = p.state === 'onstair' || p.state === 'inlift';
    const x = p.x - ux * (p.radius + 0.25) + -uy * side * 0.35;
    const y = p.y - uy * (p.radius + 0.25) + ux * side * 0.35;
    const g = this.grid.levels[p.level];
    if (walkable(g, cellAt(g, x, y))) { s.x = x; s.y = y; } else { s.x = p.x; s.y = p.y; }
  }

  // ------------------------------------------------------- stairs
  enterStair(a, shaft) {
    const key = shaft + '|' + a.level;
    let st = this.stairs.get(key);
    if (!st) this.stairs.set(key, st = { nextEntry: 0, transit: [] });
    if (this.t < st.nextEntry) return;                      // wait on the landing
    const factor = a.helpers.length ? this.stairFactor(a) : 1.2 / a.P.speed;
    st.nextEntry = this.t + STAIR_HEADWAY * (a.helpers.length ? this.stairFactor(a) : 1);
    st.transit.push({ a, out: this.t + STAIR_SECONDS * factor, shaft, to: a.level - 1 });
    a.state = 'onstair';
  }


  // ------------------------------------------------------- evacuation lifts
  // Each lift is a car that answers the oldest call on an upper floor, loads people up
  // to its capacity (a bed and its two staff nearly fill it), stops on the way down if
  // there is room, and unloads on the ground floor. Travel time = storeys x 4.5 m / speed
  // + 4 s to accelerate and stop; `doorTime` covers doors opening, loading and closing.
  setupLifts(opts) {
    this.liftOpts = opts; this.cars = []; this.liftField = []; this.liftRooms = new Map();
    if (opts.use === 'off' || !this.sc.useStairs) return;
    const shafts = this.building.vertical.filter(v => v.kind === 'lift')
      .sort((a, b) => /evacuation/i.test(b.name) - /evacuation/i.test(a.name) || a.name.localeCompare(b.name))
      .slice(0, opts.inService);
    for (const s of shafts) {
      const car = { name: s.name.replace(/\s*\(.*\)/, ''), shaft: s, level: 0, pos: 0, state: 'idle', load: [], queue: this.grid.levels.map(() => []), trips: 0, carried: 0 };
      for (const [code, rid] of Object.entries(s.rooms)) this.liftRooms.set(this.roomIndex[rid], { car, li: this.levelOf[code] });
      this.cars.push(car);
    }
    this.grid.levels.forEach((g, li) => {
      if (li === 0) return;
      const src = new Map();
      for (const [ri, lr] of this.liftRooms) if (lr.li === li) for (const i of this.roomCells[ri]) src.set(i, 0);
      this.liftField[li] = flowField(g, src, this.hazardCost(li));
    });
  }
  takesLift(a) {
    if (!this.cars.length || a.level === 0 || a.profile === 'staff' && a.escort) return false;
    const u = this.liftOpts.use;
    return u === 'everyone' || (u === 'dependent' && a.P.helpers > 0) || (u === 'beds' && a.profile === 'bed');
  }
  routeField(a) { return this.takesLift(a) && a.state === 'moving' ? this.liftField[a.level] : this.sc.fields[a.level]; }
  liftWeight(a) { return LIFT_WEIGHT[a.profile] || 1; }
  stairFactor(a) { return (a.profile === 'bed' ? this.liftOpts.bedStairSeconds : this.liftOpts.chairStairSeconds) / STAIR_SECONDS; }

  joinLift(a) {
    // the lift with the shortest wait: each person already queuing counts like 8 m of walking
    let best = null, bd = Infinity;
    for (const [ri, lr] of this.liftRooms) if (lr.li === a.level) {
      const r = this.building.rooms[ri], d = Math.hypot(r.x - a.x, r.y - a.y) + 8 * lr.car.queue[a.level].reduce((s, q) => s + this.liftWeight(q), 0);
      if (d < bd) { bd = d; best = lr.car; }
    }
    a.state = 'liftwait'; a.tCall = this.t;
    best.queue[a.level].push(a);
  }

  updateLifts() {
    const o = this.liftOpts;
    for (const car of this.cars) {
      if (car.state === 'moving') {
        const k = Math.min(1, (this.t - car.t0) / (car.t1 - car.t0));
        car.pos = car.from + (car.to - car.from) * (k * k * (3 - 2 * k));   // ease in and out
        if (this.t < car.t1) continue;
        car.level = car.to; car.pos = car.to; car.state = 'doors'; car.t1 = this.t + o.doorTime;
        if (car.level === 0) this.unload(car); else this.board(car);
      } else if (car.state === 'doors') {
        if (this.t < car.t1) continue;
        if (car.load.length) {
          // room for more? stop at the next floor down that is calling, otherwise go to the ground
          const spare = o.capacity - car.load.reduce((s, a) => s + this.liftWeight(a), 0);
          let next = 0;
          for (let l = car.level - 1; l > 0; l--) if (car.queue[l].length && this.liftWeight(car.queue[l][0]) <= spare) { next = l; break; }
          this.travel(car, next);
        } else car.state = 'idle';
      }
      if (car.state === 'idle') {
        let call = -1, oldest = Infinity;
        car.queue.forEach((q, l) => { if (l > 0 && q.length && q[0].tCall < oldest) { oldest = q[0].tCall; call = l; } });
        if (call < 0) continue;
        if (call === car.level) { car.state = 'doors'; car.t1 = this.t + o.doorTime; this.board(car); }
        else this.travel(car, call);
      }
    }
  }
  travel(car, to) {
    car.state = 'moving'; car.from = car.level; car.to = to; car.t0 = this.t;
    car.t1 = this.t + Math.abs(to - car.level) * STOREY / this.liftOpts.speed + 4;
  }
  board(car) {
    const q = car.queue[car.level];
    let used = car.load.reduce((s, a) => s + this.liftWeight(a), 0);
    while (q.length && used + this.liftWeight(q[0]) <= this.liftOpts.capacity) {
      const a = q.shift(); used += this.liftWeight(a);
      a.state = 'inlift'; car.load.push(a);
    }
    if (car.load.length) car.trips++;
  }
  unload(car) {
    const ri = this.roomIndex[car.shaft.rooms[this.grid.levels[0].code]], g = this.grid.levels[0];
    const cells = this.roomCells[ri].slice().sort((p, q) => this.sc.fields[0][p] - this.sc.fields[0][q]);
    car.load.forEach((a, k) => {
      const [x, y] = cellCentre(g, cells[Math.min(k * 3, cells.length - 1)]);
      Object.assign(a, { level: 0, x, y, state: 'moving', room: ri, lastDoor: -1, bestF: null });
    });
    car.carried += car.load.reduce((s, a) => s + 1 + a.helpers.length, 0);
    this.log(`${car.name} brought ${car.load.length === 1 ? 'a ' + car.load[0].P.label.toLowerCase() : car.load.length + ' people'} down to ${g.code}.`);
    car.load = [];
  }

  // Staff going to a patient on another floor: walk to the nearest stair, then climb.
  stairField(li) {
    if (!this.stairFields) this.stairFields = [];
    if (!this.stairFields[li]) {
      const src = new Map();
      for (const [ri, sr] of this.stairRoom) if (sr.li === li) for (const i of this.roomCells[ri]) src.set(i, 0);
      this.stairFields[li] = flowField(this.grid.levels[li], src);
    }
    return this.stairFields[li];
  }
  climb(a, shaft, dir) {
    const key = shaft + '|up';
    let st = this.stairs.get(key);
    if (!st) this.stairs.set(key, st = { nextEntry: 0, transit: [] });
    st.transit.push({ a, out: this.t + STAIR_SECONDS * 1.4, shaft, to: a.level + dir, state: 'responding' });
    a.state = 'onstair';
  }

  updateStairs() {
    for (const st of this.stairs.values()) {
      st.transit = st.transit.filter(tr => {
        if (this.t < tr.out) return true;
        const s = this.building.vertical.find(v => v.name === tr.shaft);
        const ri = this.roomIndex[s.rooms[this.grid.levels[tr.to].code]], g = this.grid.levels[tr.to];
        const cells = this.roomCells[ri];
        // step out at the bottom of the flight, nearest the way out
        let best = cells[0], bv = Infinity;
        for (const i of cells) if (this.sc.fields[tr.to][i] < bv && !g.nearWall[i]) { bv = this.sc.fields[tr.to][i]; best = i; }
        const [x, y] = cellCentre(g, best);
        Object.assign(tr.a, { level: tr.to, x: x + (this.rand() - 0.5) * 0.5, y: y + (this.rand() - 0.5) * 0.5, state: tr.state || 'moving', room: ri, lastDoor: -1 });
        return false;
      });
    }
  }
}

// ---------------------------------------------------------------- helpers
const hkey = (l, x, y) => l * 1e8 + Math.floor(x) * 1e4 + Math.floor(y);
function forNeighbours(hash, a, fn) {
  const cx = Math.floor(a.x), cy = Math.floor(a.y);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const b = hash.get(a.level * 1e8 + (cx + dx) * 1e4 + (cy + dy));
    if (b) for (const o of b) if (o !== a) fn(o);
  }
}
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export { DT };
