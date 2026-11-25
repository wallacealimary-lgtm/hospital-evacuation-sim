// furniture.js — furnish rooms from their names, so any project with similar room
// names gets furniture for free.
//
// Each rule matches a room name and lays out items against the walls (away from
// doors) or in the middle. Items that `block` become obstacles in the walking grid.
// Items can also offer "slots": where a bed-bound patient lies, where a dependent
// patient sits beside their bed, or a seat for someone waiting.
//
// After a room is furnished we check every free cell can still reach a door; if
// not, that room's furniture is made see-through (visual only) so no one is trapped.

const DOOR_CLEAR = 1.3;     // keep this far (m) from the centre of any door

// kind -> [height m, colour]   (colours are used by both views)
export const KINDS = {
  bed:      [0.6, '#e9eef5'], trolley: [0.6, '#dfe6ee'], locker: [0.9, '#b9a98f'],
  chair:    [0.85, '#7a8796'], sofa: [0.75, '#6c7a8c'], desk: [0.75, '#b39b78'], table: [0.75, '#b39b78'],
  counter:  [1.05, '#8f7d64'], shelf: [1.9, '#9aa3ad'], couch: [0.65, '#5d8fb0'], equipment: [1.5, '#8d99a6'],
  scanner:  [1.9, '#d7dce2'], kitchen: [0.9, '#a9b1ba'], bench: [0.45, '#7a8796'],
};

const RULES = [
  // patients who stay in their beds: the bed is a slot, not an obstacle (the bed leaves with them)
  { re: /critical care room|isolation room|recovery\b|^recovery/i, fn: (L, r) => { L.beds(Math.max(1, r.beds), { slot: 'bed' }); L.wallItems('equipment', 0.6, 0.6, Math.max(1, r.beds)); } },
  { re: /operating theatre/i, fn: L => { L.centre('trolley', 2.1, 0.7, { slot: 'bed' }); L.wallItems('equipment', 1.0, 0.8, 3); L.wallItems('shelf', 1.8, 0.5, 2); } },
  { re: /anaesthetic room|resuscitation/i, fn: (L, r) => { L.centre('trolley', 2.1, 0.8, { slot: 'bed' }); L.wallItems('equipment', 1.0, 0.7, 2); L.wallItems('shelf', 1.8, 0.5, 1); } },
  // patients who get out of bed into a wheelchair: blocking beds, a seat beside each
  { re: /bedroom|bed room|\d-bed/i, fn: (L, r) => { L.beds(r.beds, { side: true }); L.wallItems('locker', 0.5, 0.5, r.beds); } },
  { re: /majors cubicles|second-stage recovery|admissions lounge/i, fn: L => { L.beds(6, { trolley: true }); } },
  // seating
  { re: /wait|day room|relatives' room|relatives' overnight|lounge|multi-faith/i, fn: (L, r) => { if (/reception/i.test(r.name)) L.wallItems('counter', 3.0, 0.8, 1); L.seatsAlongWalls(); L.seatRows(); } },
  { re: /concourse/i, fn: L => { L.wallItems('counter', 4.0, 0.9, 1); L.benches(); } },
  { re: /cafe & seating/i, fn: L => L.cafe() },
  { re: /seminar|teaching|interview/i, fn: L => L.meetingTable() },
  { re: /staff rest|staff room|on-call|overnight/i, fn: L => { L.wallItems('sofa', 2.0, 0.85, 3, { seat: true }); L.centre('table', 1.2, 0.6); } },
  // clinical rooms
  { re: /consult|exam|triage|treatment|procedure|plaster|phlebotomy|ultrasound|therapy room|near-patient/i, fn: L => { L.wallItems('couch', 1.9, 0.7, 1); L.wallItems('desk', 1.2, 0.6, 1, { seat: true }); L.wallItems('equipment', 0.6, 0.6, 1); } },
  { re: /x-ray room/i, fn: L => { L.centre('scanner', 2.2, 0.9); L.wallItems('equipment', 1.0, 0.8, 1); } },
  { re: /ct scanner/i, fn: L => { L.centre('scanner', 2.0, 2.2); L.wallItems('equipment', 1.2, 0.8, 1); } },
  { re: /physiotherapy gym/i, fn: L => { L.wallItems('couch', 2.0, 0.8, 3); L.centre('equipment', 3.0, 0.8); } },
  // staff work spaces
  { re: /nurse base|staff base|central staff|reception & admissions|coordinator/i, fn: L => { L.wallItems('counter', 3.2, 0.8, 1, { seat: true }); L.wallItems('desk', 1.4, 0.7, 2, { seat: true }); } },
  { re: /office|admin|records|reporting|control room|pharmacy$/i, fn: (L, r) => L.wallItems('desk', 1.4, 0.7, Math.max(1, Math.floor(r.area / 7)), { seat: true }) },
  { re: /kitchen|pantry|servery/i, fn: L => L.wallItems('kitchen', 2.4, 0.65, 3) },
  { re: /store|utility|sluice|linen|disposal|cleaners|consumables|sterile|decontamination|goods in|exit bay|parking bay/i, fn: L => L.wallItems('shelf', 2.0, 0.55, 6) },
];

export function furnish(grid, building, { walkableFrom } = {}) {
  const items = [], slots = building.rooms.map(() => ({ bed: [], side: [], seat: [] }));
  for (const g of grid.levels) {
    const cellsByRoom = new Map();
    for (let i = 0; i < g.room.length; i++) if (g.room[i] >= 0 && !g.blocked[i]) {
      let a = cellsByRoom.get(g.room[i]); if (!a) cellsByRoom.set(g.room[i], a = []); a.push(i);
    }
    const doors = building.doors.filter(d => d.level === g.code);
    for (const [ri, cells] of cellsByRoom) {
      const r = building.rooms[ri];
      if (r.kind !== 'room' && r.kind !== 'concourse') continue;
      const rule = RULES.find(x => x.re.test(r.name));
      if (!rule) continue;
      const L = new Layout(g, ri, cells, doors);
      if (!L.ok) continue;
      rule.fn(L, r);
      // keep the room passable: block the items, check every free cell still reaches a door
      const marked = [];
      for (const it of L.items) if (it.blocks) for (const i of L.cellsOf(it)) if (!g.blocked[i]) { g.blocked[i] = 1; marked.push(i); }
      if (marked.length && !L.allReachable()) {
        for (const i of marked) g.blocked[i] = 0;
        for (const it of L.items) it.blocks = false;
      }
      for (const it of L.items) { it.level = g.index; it.room = ri; items.push(it); }
      for (const k of ['bed', 'side', 'seat']) slots[ri][k].push(...L.slots[k].filter(s => !g.blocked[L.cellAt(s.x, s.y)]));
    }
  }
  return { items, slots };
}

class Layout {
  constructor(g, ri, cells, doors) {
    this.g = g; this.ri = ri; this.cells = cells; this.items = []; this.slots = { bed: [], side: [], seat: [] };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of cells) { const cx = i % g.W, cy = (i / g.W) | 0; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
    this.ok = cells.length / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.75;     // only furnish roughly rectangular rooms
    this.R = { x0: g.minX + x0 * g.cell, x1: g.minX + (x1 + 1) * g.cell, y0: g.minY + y0 * g.cell, y1: g.minY + (y1 + 1) * g.cell };
    const R = this.R;
    this.doors = doors.filter(d => d.x > R.x0 - 0.8 && d.x < R.x1 + 0.8 && d.y > R.y0 - 0.8 && d.y < R.y1 + 0.8);
    // walls, best first: furthest from any door, then longest
    const sides = [
      { s: 'S', len: R.x1 - R.x0, mid: [(R.x0 + R.x1) / 2, R.y0] }, { s: 'N', len: R.x1 - R.x0, mid: [(R.x0 + R.x1) / 2, R.y1] },
      { s: 'W', len: R.y1 - R.y0, mid: [R.x0, (R.y0 + R.y1) / 2] }, { s: 'E', len: R.y1 - R.y0, mid: [R.x1, (R.y0 + R.y1) / 2] },
    ];
    for (const sd of sides) sd.doorDist = Math.min(99, ...this.doors.map(d => this.distToSide(d, sd.s)));
    this.sides = sides.sort((a, b) => (b.doorDist > 1) - (a.doorDist > 1) || b.len - a.len || b.doorDist - a.doorDist);
  }
  distToSide(d, s) {
    const R = this.R;
    if (s === 'S' || s === 'N') { const y = s === 'S' ? R.y0 : R.y1; return Math.abs(d.y - y) + Math.max(0, R.x0 - d.x, d.x - R.x1); }
    const x = s === 'W' ? R.x0 : R.x1; return Math.abs(d.x - x) + Math.max(0, R.y0 - d.y, d.y - R.y1);
  }
  cellAt(x, y) { const g = this.g; return Math.floor((y - g.minY) / g.cell) * g.W + Math.floor((x - g.minX) / g.cell); }
  cellsOf(it) {
    const g = this.g, out = [];
    for (let y = it.y0 + 0.01; y < it.y1; y += g.cell) for (let x = it.x0 + 0.01; x < it.x1; x += g.cell) out.push(this.cellAt(x, y));
    return out;
  }
  fits(it, gap) {
    const R = this.R, m = 1e-6;
    if (it.x0 < R.x0 - m || it.y0 < R.y0 - m || it.x1 > R.x1 + m || it.y1 > R.y1 + m) return false;
    for (const d of this.doors) {
      const cx = Math.max(it.x0, Math.min(d.x, it.x1)), cy = Math.max(it.y0, Math.min(d.y, it.y1));
      if (Math.hypot(cx - d.x, cy - d.y) < DOOR_CLEAR) return false;
    }
    for (const o of this.items) {
      const gg = it.blocks && o.blocks ? gap : 0.05;
      if (it.x0 < o.x1 + gg && it.x1 > o.x0 - gg && it.y0 < o.y1 + gg && it.y1 > o.y0 - gg) return false;
    }
    for (const i of this.cellsOf(it)) if (this.g.room[i] !== this.ri || this.g.blocked[i] || this.g.door[i] >= 0) return false;
    return true;
  }
  add(kind, x0, y0, x1, y1, extra = {}, gap = 0.7) {
    const it = { kind, x0, y0, x1, y1, blocks: !['chair', 'bench'].includes(kind) && extra.slot !== 'bed', ...extra };
    if (!this.fits(it, gap)) return null;
    this.items.push(it);
    return it;
  }
  // `w` runs along the wall, `d` sticks out from it. Returns placed items.
  alongWall(kind, w, d, n, opts = {}, sides = this.sides) {
    const out = [], R = this.R, step = opts.step || 0.25;
    for (const { s } of sides) {
      const horiz = s === 'S' || s === 'N', len = horiz ? R.x1 - R.x0 : R.y1 - R.y0;
      for (let t = 0.1; t + w <= len - 0.1 && out.length < n; t += step) {
        let x0, y0, x1, y1;
        if (horiz) { x0 = R.x0 + t; x1 = x0 + w; y0 = s === 'S' ? R.y0 : R.y1 - d; y1 = y0 + d; }
        else { y0 = R.y0 + t; y1 = y0 + w; x0 = s === 'W' ? R.x0 : R.x1 - d; x1 = x0 + d; }
        const it = this.add(kind, x0, y0, x1, y1, { wall: s, ...opts.extra }, opts.gap ?? 0.7);
        if (it) { out.push(it); t += w + (opts.spacing ?? 0.6) - step; }
      }
      if (out.length >= n) break;
    }
    return out;
  }
  wallItems(kind, w, d, n, { seat = false } = {}) {
    for (const it of this.alongWall(kind, w, d, n)) if (seat) this.seatInFront(it, 0.5);
  }
  seatInFront(it, off) {
    const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2;
    const [x, y] = { S: [cx, it.y1 + off], N: [cx, it.y0 - off], W: [it.x1 + off, cy], E: [it.x0 - off, cy] }[it.wall] || [cx, cy];
    const ch = this.add('chair', x - 0.25, y - 0.25, x + 0.25, y + 0.25);
    if (ch) this.slots.seat.push({ x, y });
  }
  // beds head-to-wall. side: a seat beside each bed for a wheelchair patient. slot 'bed': the patient lies here.
  beds(n, { side = false, slot = null, trolley = false } = {}) {
    const kind = trolley ? 'trolley' : 'bed', heading = { S: Math.PI / 2, N: -Math.PI / 2, W: 0, E: Math.PI };
    const placed = this.alongWall(kind, 1.0, 2.1, n, { spacing: 1.4, extra: slot ? { slot } : {} });
    for (const b of placed) {
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      b.heading = heading[b.wall];
      if (slot === 'bed') this.slots.bed.push({ x: cx, y: cy, heading: b.heading, item: b });
      if (side) {
        const horiz = b.wall === 'S' || b.wall === 'N';
        for (const sg of [1, -1]) {
          const x = horiz ? cx + sg * 1.0 : cx, y = horiz ? cy : cy + sg * 1.0;
          if (this.fitsPoint(x, y)) { this.slots.side.push({ x, y }); break; }
        }
      }
    }
  }
  fitsPoint(x, y) { const i = this.cellAt(x, y); return this.g.room[i] === this.ri && !this.g.blocked[i] && !this.items.some(o => o.blocks && x > o.x0 - 0.3 && x < o.x1 + 0.3 && y > o.y0 - 0.3 && y < o.y1 + 0.3); }
  centre(kind, w, d, extra = {}) {
    const R = this.R, cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2, long = R.x1 - R.x0 >= R.y1 - R.y0;
    const [hw, hd] = long ? [w / 2, d / 2] : [d / 2, w / 2];
    const it = this.add(kind, cx - hw, cy - hd, cx + hw, cy + hd, { heading: long ? 0 : Math.PI / 2, ...extra });
    if (it && extra.slot === 'bed') this.slots.bed.push({ x: cx, y: cy, heading: it.heading, item: it });
    return it;
  }
  seatsAlongWalls() {
    for (const it of this.alongWall('chair', 0.5, 0.5, 60, { spacing: 0.08, gap: 0.05 }, this.sides)) this.slots.seat.push({ x: (it.x0 + it.x1) / 2, y: (it.y0 + it.y1) / 2 });
  }
  seatRows() {                                     // back-to-back rows down the middle of big rooms
    const R = this.R, horiz = R.x1 - R.x0 >= R.y1 - R.y0, depth = horiz ? R.y1 - R.y0 : R.x1 - R.x0;
    if (depth < 6.5) return;
    const mid = horiz ? (R.y0 + R.y1) / 2 : (R.x0 + R.x1) / 2, len = horiz ? R.x1 - R.x0 : R.y1 - R.y0;
    for (const off of [-0.27, 0.27]) for (let t = 2.0; t < len - 2.0; t += 0.55) {
      const [x, y] = horiz ? [R.x0 + t, mid + off] : [mid + off, R.y0 + t];
      const ch = this.add('chair', x - 0.25, y - 0.25, x + 0.25, y + 0.25);
      if (ch) this.slots.seat.push({ x, y });
    }
  }
  benches() {
    const R = this.R;
    for (let x = R.x0 + 4; x < R.x1 - 4; x += 6) for (let y = R.y0 + 4; y < R.y1 - 4; y += 7) {
      const b = this.add('bench', x, y, x + 2.0, y + 0.5);
      if (b) this.slots.seat.push({ x: x + 0.5, y: y + 0.25 }, { x: x + 1.5, y: y + 0.25 });
    }
  }
  cafe() {
    const R = this.R;
    for (let x = R.x0 + 1.4; x < R.x1 - 1.4; x += 2.4) for (let y = R.y0 + 1.4; y < R.y1 - 1.4; y += 2.4) {
      if (!this.add('table', x - 0.4, y - 0.4, x + 0.4, y + 0.4, {}, 1.2)) continue;
      for (const sx of [-0.65, 0.65]) if (this.add('chair', x + sx - 0.22, y - 0.22, x + sx + 0.22, y + 0.22)) this.slots.seat.push({ x: x + sx, y });
    }
  }
  meetingTable() {
    const R = this.R, w = R.x1 - R.x0 - 2.6, d = R.y1 - R.y0 - 2.6;
    if (w < 0.8 || d < 0.8) return;
    const cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2, tw = Math.min(w, 6), td = Math.min(d, 1.4);
    const t = this.add('table', cx - tw / 2, cy - td / 2, cx + tw / 2, cy + td / 2);
    if (!t) return;
    for (let x = t.x0 + 0.4; x < t.x1 - 0.2; x += 0.75) for (const y of [t.y0 - 0.4, t.y1 + 0.4])
      if (this.add('chair', x - 0.22, y - 0.22, x + 0.22, y + 0.22)) this.slots.seat.push({ x, y });
  }
  // every free cell of the room can still reach one of its doors (or, without doors, the room point area)
  allReachable() {
    const g = this.g, seen = new Set(), q = [];
    for (const i of this.cells) {
      if (g.blocked[i]) continue;
      const cx = i % g.W, cy = (i / g.W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = (cy + dy) * g.W + cx + dx; if (g.door[j] >= 0 || (g.room[j] !== this.ri && !g.blocked[j])) { if (!seen.has(i)) { seen.add(i); q.push(i); } break; } }
    }
    if (!q.length) return true;
    while (q.length) {
      const i = q.pop(), cx = i % g.W, cy = (i / g.W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = (cy + dy) * g.W + cx + dx;
        if (!seen.has(j) && g.room[j] === this.ri && !g.blocked[j]) { seen.add(j); q.push(j); }
      }
    }
    return this.cells.every(i => g.blocked[i] || seen.has(i));
  }
}
