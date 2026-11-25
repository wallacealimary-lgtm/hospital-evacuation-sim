// Check a building file before you load it: does every room get floor space,
// does the outside leak in, and does everyone get out?
//   node tools/check.mjs my.building.json
import { readFileSync } from 'node:fs';
import { buildGrids } from '../engine/grid.js';
import { Sim, fmt } from '../engine/sim.js';

const file = process.argv[2];
if (!file) { console.log('usage: node tools/check.mjs my.building.json'); process.exit(1); }
const b = JSON.parse(readFileSync(file));
const grid = buildGrids(b);
const sim = new Sim(b, grid);
const A = grid.frame.cell ** 2;
console.log(`${b.project?.name}: ${b.levels.length} levels, ${b.walls.length} walls, ${b.doors.length} doors, ${b.rooms.length} rooms, ${b.vertical.length} stairs/lifts`);
grid.levels.forEach((g, li) => {
  let inside = 0;
  for (let i = 0; i < g.blocked.length; i++) if (!g.blocked[i] && !g.outside[i]) inside++;
  const rs = b.rooms.map((r, ri) => [r, ri]).filter(([r]) => r.level === g.code);
  const empty = rs.filter(([, ri]) => !sim.roomCells[ri].length).map(([r]) => r.name);
  console.log(`  ${g.code} ${b.levels[li].name}: ${(inside * A).toFixed(0)} m² of floor inside, ${rs.length} rooms` +
    (empty.length ? `; ${empty.length} rooms have no floor (wall leak or point inside a wall): ${empty.slice(0, 5).join(', ')}` : ''));
});
sim.reset({ scenario: 'full', shift: 'day', seed: 7 });
while (!sim.done && sim.t < 1800) sim.step();
const st = {};
for (const a of sim.agents) st[a.state] = (st[a.state] || 0) + 1;
const allOut = sim.done && sim.agents.every(a => a.state === 'safe' || !a.mover);
console.log(`\nFull evacuation, day: ${sim.agents.length} people -> ${allOut ? `everyone out after ${fmt(sim.t)}` : `NOT everyone out (${fmt(sim.t)})`}`, st);
if (!allOut) {
  const stuck = {};
  for (const a of sim.agents) if (a.state !== 'safe') { const n = `${b.levels[a.level].code} ${b.rooms[a.room]?.name}`; stuck[n] = (stuck[n] || 0) + 1; }
  console.log('  still inside, by starting room:', stuck);
  console.log('  Usual causes: a room with no door into it, an exit door missing on the ground floor, or a stair room not joined between floors.');
}
