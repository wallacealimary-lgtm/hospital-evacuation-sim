// grid.js — turns a sim.building.v1 file into walkable grids, one per level.
//
// Idea: chop each floor into small squares (cells). A cell is either blocked
// (inside a wall) or walkable. Doors are cut out of the walls. Then:
//   - "outside" = everything reachable from the edge of the grid with doors shut
//   - each room claims the cells around its room point (flood fill with doors shut)
//   - a "flow field" stores, for every cell, the walking distance to a goal.
//     A person just steps towards the neighbouring cell with the lowest number.

import { furnish } from './furniture.js';

export const CELL = 0.25;            // metres per cell
const MARGIN = 5;                    // metres of outside space around the building
const DOOR_DEPTH = 0.45;             // half-depth of the cut a door makes through its wall
const INF = 1e9;

// Options: furniture (furnish rooms), cell (grid size in metres), frameLevels (only these
// level codes set the extent of the grid; the dock sim uses the warehouse floor only).
export function buildGrids(building, { furniture = true, cell = CELL, frameLevels = null } = {}) {
  const xs = [], ys = [];
  for (const w of building.walls) if (!frameLevels || frameLevels.includes(w.level)) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
  const minX = Math.min(...xs) - MARGIN, minY = Math.min(...ys) - MARGIN;
  const W = Math.ceil((Math.max(...xs) + MARGIN - minX) / cell);
  const H = Math.ceil((Math.max(...ys) + MARGIN - minY) / cell);
  const frame = { minX, minY, W, H, cell };

  const levels = building.levels.map((lv, li) => {
    const n = W * H;
    const g = {
      code: lv.code, index: li, ...frame,
      blocked: new Uint8Array(n),     // 1 = wall
      door: new Int16Array(n).fill(-1),// door index for cells cut by a door
      outside: new Uint8Array(n),
      room: new Int16Array(n).fill(-1),// room index that owns the cell
      nearWall: new Uint8Array(n),     // 1 = touching a wall (slightly costlier to walk)
    };
    rasteriseWalls(g, building.walls.filter(w => w.level === lv.code));
    building.doors.forEach((d, di) => { if (d.level === lv.code) cutDoor(g, d, di); });
    floodOutside(g);
    if (li > 0) for (let i = 0; i < n; i++) if (g.outside[i]) g.blocked[i] = 1; // no walking on air
    markNearWall(g);
    return g;
  });

  assignRooms(levels, building.rooms);
  const grid = { frame, levels, furniture: [], slots: building.rooms.map(() => ({ bed: [], side: [], seat: [] })) };
  if (furniture) {
    const f = furnish(grid, building); grid.furniture = f.items; grid.slots = f.slots;
    for (const g of levels) markNearWall(g);           // furniture adds new edges to keep clear of
  }
  return grid;
}

export const idx = (g, cx, cy) => cy * g.W + cx;
export const toCell = (g, x, y) => [Math.floor((x - g.minX) / g.cell), Math.floor((y - g.minY) / g.cell)];
export const cellCentre = (g, i) => [g.minX + ((i % g.W) + 0.5) * g.cell, g.minY + (Math.floor(i / g.W) + 0.5) * g.cell];
export function cellAt(g, x, y) {
  const [cx, cy] = toCell(g, x, y);
  return (cx < 0 || cy < 0 || cx >= g.W || cy >= g.H) ? -1 : idx(g, cx, cy);
}
export const walkable = (g, i) => i >= 0 && !g.blocked[i];

function rasteriseWalls(g, walls) {
  // On a grid coarser than the default, a thin wall can fall between two rows of cell
  // centres and vanish, so walls are fattened to at least ~0.7 of a cell there.
  const minR = g.cell > CELL ? g.cell * 0.71 : 0;
  for (const w of walls) {
    const r = Math.max(w.t / 2 + 0.05, minR);
    const [ax, ay] = toCell(g, Math.min(w.x1, w.x2) - r, Math.min(w.y1, w.y2) - r);
    const [bx, by] = toCell(g, Math.max(w.x1, w.x2) + r, Math.max(w.y1, w.y2) + r);
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1, L2 = dx * dx + dy * dy || 1;
    for (let cy = Math.max(0, ay); cy <= Math.min(g.H - 1, by); cy++)
      for (let cx = Math.max(0, ax); cx <= Math.min(g.W - 1, bx); cx++) {
        const px = g.minX + (cx + 0.5) * g.cell, py = g.minY + (cy + 0.5) * g.cell;
        const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / L2));
        const qx = w.x1 + t * dx - px, qy = w.y1 + t * dy - py;
        if (qx * qx + qy * qy <= r * r) g.blocked[idx(g, cx, cy)] = 1;
      }
  }
}

function cutDoor(g, d, di) {
  // axis 'x': the door's width runs along x (it sits in a wall running along x)
  const hw = d.width / 2 - 0.05;
  const [hx, hy] = d.axis === 'x' ? [hw, DOOR_DEPTH] : [DOOR_DEPTH, hw];
  const [ax, ay] = toCell(g, d.x - hx, d.y - hy), [bx, by] = toCell(g, d.x + hx, d.y + hy);
  for (let cy = Math.max(0, ay); cy <= Math.min(g.H - 1, by); cy++)
    for (let cx = Math.max(0, ax); cx <= Math.min(g.W - 1, bx); cx++) {
      const i = idx(g, cx, cy);
      if (g.blocked[i]) { g.blocked[i] = 0; g.door[i] = di; }
    }
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function floodOutside(g) {
  const q = [];
  const push = i => { if (!g.outside[i] && !g.blocked[i] && g.door[i] < 0) { g.outside[i] = 1; q.push(i); } };
  for (let x = 0; x < g.W; x++) { push(idx(g, x, 0)); push(idx(g, x, g.H - 1)); }
  for (let y = 0; y < g.H; y++) { push(idx(g, 0, y)); push(idx(g, g.W - 1, y)); }
  while (q.length) {
    const i = q.pop(), cx = i % g.W, cy = (i / g.W) | 0;
    for (const [dx, dy] of N4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < g.W && ny < g.H) push(idx(g, nx, ny));
    }
  }
}

function markNearWall(g) {
  for (let cy = 1; cy < g.H - 1; cy++)
    for (let cx = 1; cx < g.W - 1; cx++) {
      const i = idx(g, cx, cy);
      if (g.blocked[i]) continue;
      for (let dy = -1; dy <= 1 && !g.nearWall[i]; dy++)
        for (let dx = -1; dx <= 1; dx++) if (g.blocked[i + dy * g.W + dx]) { g.nearWall[i] = 1; break; }
    }
}

// All rooms on a level grow outward from their room points at the same time
// (doors shut), so open-plan spaces split fairly between neighbouring rooms.
function assignRooms(levels, rooms) {
  for (const g of levels) {
    let frontier = [];
    rooms.forEach((r, ri) => {
      if (r.level !== g.code) return;
      const i = cellAt(g, r.x, r.y);
      if (walkable(g, i) && g.room[i] < 0 && !g.outside[i]) { g.room[i] = ri; frontier.push(i); }
    });
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        const cx = i % g.W, cy = (i / g.W) | 0;
        for (const [dx, dy] of N4) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
          const j = idx(g, nx, ny);
          if (g.room[j] >= 0 || g.blocked[j] || g.door[j] >= 0 || g.outside[j]) continue;
          g.room[j] = g.room[i]; next.push(j);
        }
      }
      frontier = next;
    }
    // door cells belong to whichever room touches them first (for colouring only)
  }
}

// ---------------------------------------------------------------------------
// Flow fields: Dijkstra from a set of source cells over the walkable grid.
// sources: Map(cellIndex -> starting cost in metres).  costFn(i) -> multiplier.
export function flowField(g, sources, costFn = null) {
  const n = g.W * g.H, dist = new Float32Array(n).fill(INF);
  const heap = new MinHeap(n);
  for (const [i, c] of sources) if (!g.blocked[i] && c < dist[i]) { dist[i] = c; heap.push(i, c); }
  const W = g.W, s = g.cell, d2 = s * Math.SQRT2;
  while (heap.size) {
    const [i, c] = heap.pop();
    if (c > dist[i]) continue;
    const cx = i % W, cy = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= g.H) continue;
      const j = ny * W + nx;
      if (g.blocked[j]) continue;
      if (dx && dy && (g.blocked[cy * W + nx] || g.blocked[ny * W + cx])) continue; // no corner cutting
      let step = (dx && dy ? d2 : s) * (g.nearWall[j] ? 1.6 : 1);
      if (costFn) step *= costFn(j);
      const nc = c + step;
      if (nc < dist[j]) { dist[j] = nc; heap.push(j, nc); }
    }
  }
  return dist;
}
flowField.INF = INF;

// Direction of steepest descent at (x, y): a weighted blend of the downhill neighbours.
export function downhill(g, field, x, y) {
  const i = cellAt(g, x, y);
  if (i < 0) return [0, 0];
  const f0 = field[i];
  const cx = i % g.W, cy = (i / g.W) | 0;
  let vx = 0, vy = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
    const j = ny * g.W + nx;
    if (g.blocked[j] || field[j] >= INF) continue;
    if (dx && dy && (g.blocked[cy * g.W + nx] || g.blocked[ny * g.W + cx])) continue;
    const len = Math.hypot(dx, dy), drop = (f0 - field[j]) / (len * g.cell);
    if (drop > 0) { vx += drop * dx / len; vy += drop * dy / len; }
  }
  const m = Math.hypot(vx, vy);
  return m > 1e-6 ? [vx / m, vy / m] : [0, 0];
}

class MinHeap {
  constructor(cap) { this.k = new Int32Array(cap * 2); this.v = new Float32Array(cap * 2); this.size = 0; }
  push(key, val) {
    if (this.size >= this.k.length) { const k = new Int32Array(this.k.length * 2); k.set(this.k); this.k = k; const v = new Float32Array(this.v.length * 2); v.set(this.v); this.v = v; }
    let i = this.size++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.v[p] <= val) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const rk = this.k[0], rv = this.v[0], k = this.k[--this.size], v = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.size) break;
      if (c + 1 < this.size && this.v[c + 1] < this.v[c]) c++;
      if (this.v[c] >= v) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = k; this.v[i] = v;
    return [rk, rv];
  }
}
