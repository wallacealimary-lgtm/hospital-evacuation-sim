# People Movement Sim: hospital evacuation

**Try it in your browser: https://wallacealimary-lgtm.github.io/hospital-evacuation-sim/**

BIM models are full of walls, doors, stairs and rooms, and completely empty of people. This puts them back in.

The demo building is Riverside Community Hospital, a fictional three-storey hospital. Staff, visitors, walking patients and dependent patients (who need staff to move them) evacuate it in 2D or 3D. You can:

- pick **full evacuation** or **progressive horizontal evacuation** (only the fire compartment moves, sideways into the next one)
- click any room to **move the fire**
- switch **day / night** shift and drag **staff on duty**
- turn on **evacuation lifts** for bed-bound or all dependent patients
- run a **staffing sweep**, which reruns the evacuation at many staffing levels and tells you where adding more staff stops helping
- change the speed (1× to 60×) and watch the "still to reach safety" count fall

Built with [Claude Code](https://claude.com/claude-code), just for fun. The numbers are uncalibrated: it is for exploring ideas, not fire engineering.

## Try it on your own Revit model

Coming shortly: a converter from a Revit IFC export, and step-by-step instructions. The **Load your building…** button on the page already accepts converted building files.

## Run it locally

No install needed, only Python 3 to serve the files:

```bash
python3 -m http.server 8777
```

Then open http://localhost:8777. Headless check (Node 18+): `node test_headless.mjs`.

## How it works

1. **Building file.** `buildings/*.building.json` holds only what movement needs: levels, walls (as centrelines with a thickness), doors, rooms (a point inside each, plus name, occupancy, beds, dependency and fire compartment) and which stair and lift rooms connect between floors.
2. **Grid.** Each floor is cut into 25 cm squares (`engine/grid.js`). Walls block squares, doors are cut through them, and each room claims the squares around its point.
3. **Flow fields.** For every square, the walking distance to safety: outside on the ground floor, or the nearest stair above it. A person just steps downhill.
4. **People.** `engine/people.js` turns each room's occupancy into staff, visitors and patients, each with a walking speed and reaction time. Crowds slow down (Weidmann's speed–density curve). Staff go and fetch dependent patients and move them together (`engine/sim.js`).
5. **Scenarios.** `engine/scenarios.js` says who moves and where safe is. Add a new one there.
