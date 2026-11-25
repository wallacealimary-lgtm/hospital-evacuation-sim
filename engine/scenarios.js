// scenarios.js — a scenario decides three things:
//   1. who moves when the alarm goes (everyone, or only the fire compartment)
//   2. where "safe" is (outside, or a neighbouring fire compartment)
//   3. the flow field on each level that leads there
// Add a new scenario by adding an object here with the same shape.

import { flowField } from './grid.js';

const STAIR_COST = 15;          // metres-equivalent added for going down one storey
const REFUGE_DEPTH = 6;         // metres people walk into the next compartment before they stop

export const SCENARIOS = {
  full: {
    label: 'Full evacuation (simultaneous)',
    describe: 'The alarm sounds everywhere. Everyone leaves the building by the stairs and final exits. Staff help dependent patients out first.',
    needsFire: false,
    setup(sim) {
      const { levels } = sim.grid;
      const safe = [], fields = [];
      levels.forEach((g, li) => {
        const m = new Uint8Array(g.W * g.H);
        if (li === 0) for (let i = 0; i < m.length; i++) m[i] = g.outside[i];
        safe.push(m);
      });
      // Ground floor: distance to the outside. Upper floors: distance to a stair,
      // where each stair "costs" what it takes to get out from the bottom of it.
      fields[0] = flowField(levels[0], cellsOf(safe[0], 0), sim.hazardCost(0));
      for (let li = 1; li < levels.length; li++) {
        const src = new Map();
        for (const shaft of sim.building.vertical) {
          if (shaft.kind !== 'stair') continue;
          const lo = sim.roomIndex[shaft.rooms[levels[li - 1].code]], hi = sim.roomIndex[shaft.rooms[levels[li].code]];
          if (lo == null || hi == null) continue;
          let best = flowField.INF;
          for (const i of sim.roomCells[lo]) best = Math.min(best, fields[li - 1][i]);
          for (const i of sim.roomCells[hi]) src.set(i, best + STAIR_COST);
        }
        fields[li] = flowField(levels[li], src, sim.hazardCost(li));
      }
      return { fields, safe, movers: () => true, useStairs: true, refuge: false };
    },
  },

  horizontal: {
    label: 'Progressive horizontal evacuation',
    describe: 'Hospital practice: only the fire compartment moves, sideways through the fire doors into the next compartment on the same floor. Everyone else stays put. Staff move the dependent patients.',
    needsFire: true,
    setup(sim) {
      const { levels } = sim.grid;
      const fire = sim.fire, fl = fire.levelIndex, g = levels[fl];
      const comp = sim.building.rooms[fire.room].compartment;
      const compOf = i => g.room[i] >= 0 ? sim.building.rooms[g.room[i]].compartment : '';
      // how far each cell is from the fire compartment
      const fromFire = flowField(g, cellsWhere(g, i => compOf(i) === comp));
      const safeMask = new Uint8Array(g.W * g.H);
      for (let i = 0; i < safeMask.length; i++) {
        const c = compOf(i);
        if (c && c !== comp && fromFire[i] >= REFUGE_DEPTH && fromFire[i] < flowField.INF) safeMask[i] = 1;
      }
      const fields = [], safe = [];
      levels.forEach((lv, li) => { fields.push(null); safe.push(new Uint8Array(lv.W * lv.H)); });
      fields[fl] = flowField(g, cellsOf(safeMask, 0), sim.hazardCost(fl));
      safe[fl] = safeMask;
      const moverRooms = new Set(sim.building.rooms.map((r, ri) => (r.level === g.code && r.compartment === comp) ? ri : -1));
      return {
        fields, safe, useStairs: false, refuge: true, fromFire,
        movers: a => a.level === fl && moverRooms.has(a.room),
        label: `Fire in ${sim.building.rooms[fire.room].name} (${comp})`,
      };
    },
  },
};

function cellsOf(mask, cost) {
  const m = new Map();
  for (let i = 0; i < mask.length; i++) if (mask[i]) m.set(i, cost);
  return m;
}
function cellsWhere(g, pred) {
  const m = new Map();
  for (let i = 0; i < g.W * g.H; i++) if (!g.blocked[i] && pred(i)) m.set(i, 0);
  return m;
}
