// Headless check: build the grids, run both scenarios, print the key numbers.
// node test_headless.mjs [buildings/RCH.building.json]
import { readFileSync } from 'node:fs';
import { buildGrids } from './engine/grid.js';
import { Sim, fmt } from './engine/sim.js';

const b = JSON.parse(readFileSync(process.argv[2] || new URL('./buildings/RCH.building.json', import.meta.url)));
let t0 = Date.now();
const grid = buildGrids(b);
console.log(`grids ${grid.frame.W}x${grid.frame.H} x ${grid.levels.length} levels in ${Date.now() - t0} ms`);
const sim = new Sim(b, grid);
const g0 = grid.levels[0];
let inside = 0, out = 0, rooms = 0;
for (let i = 0; i < g0.blocked.length; i++) if (!g0.blocked[i]) { if (g0.outside[i]) out++; else inside++; }
console.log(`L00 walkable inside ${(inside * 0.0625).toFixed(0)} m2, outside ${(out * 0.0625).toFixed(0)} m2`);
const empty = b.rooms.filter((r, i) => !sim.roomCells[i].length).map(r => r.id);
const big = b.rooms.map((r, i) => [r, sim.roomCells[i].length * 0.0625]).filter(([r, a]) => a > r.area * 1.5 + 5).map(([r, a]) => `${r.id} ${r.name} ${a.toFixed(0)}/${r.area}`);
console.log(`rooms without cells: ${empty.length} ${empty.slice(0, 8)}; oversized (leaky) rooms: ${big.length}`, big.slice(0, 8));

const fireRoom = b.rooms.findIndex(r => r.level === 'L01' && r.name.startsWith('Single bedroom') && r.compartment.endsWith('W1'));
console.log(`furniture: ${grid.furniture.length} items in ${new Set(grid.furniture.map(i => i.room)).size} rooms`);
for (const [scenario, shift, lifts] of [['full', 'day'], ['full', 'night'], ['full', 'night', { use: 'beds', inService: 2 }], ['horizontal', 'night']]) {
  t0 = Date.now();
  sim.reset({ scenario, shift, seed: 7, lifts, fire: scenario === 'horizontal' ? { room: fireRoom } : null });
  while (!sim.done && sim.t < 1800) sim.step();
  const st = {};
  for (const a of sim.agents) st[a.state] = (st[a.state] || 0) + 1;
  console.log(`\n${scenario}/${shift}${lifts ? '/lifts:' + lifts.use + 'x' + lifts.inService : ''}: ${sim.agents.length} people, ${sim.total} movers -> ${sim.done ? 'done' : 'NOT done'} at ${fmt(sim.t)} (${Date.now() - t0} ms)`, st);
  console.log('  exits:', [...sim.exitUse].map(([d, n]) => `${b.doors[d].id}:${n}`).join(' '));
  for (const e of sim.events.slice(0, 6)) console.log(`  ${fmt(e.t)} ${e.msg}`);
  if (sim.events.length > 6) console.log(`  ... ${sim.events.length} events; last: ${fmt(sim.events.at(-1).t)} ${sim.events.at(-1).msg}`);
}
