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

Your model never leaves your computer: you convert it locally, and the web page reads the converted file in your own browser.

**1. Export an IFC from Revit.** Use File → Export → IFC with any of the standard setups (IFC2x3 Coordination View 2.0 works well). Rooms come through as IFC spaces when you export the whole model. If you export from a 3D view, also tick the option to export rooms in 3D views (on the Additional Content tab).

**2. Convert it.** You need Python 3.9 or newer. In this folder:

```bash
pip install -r tools/requirements.txt
```

```bash
python3 tools/ifc_to_building.py MyModel.ifc my.building.json
```

It prints what it found: levels, walls, doors, rooms, how many people, and which stairs join the floors. A small model takes a few seconds.

**3. Check it (optional, needs Node 18+).** This runs a full evacuation without a browser and tells you which rooms, if any, can't get out:

```bash
node tools/check.mjs my.building.json
```

**4. Run it.** Open the [live sim](https://wallacealimary-lgtm.github.io/hospital-evacuation-sim/), press **Load your building…** and choose `my.building.json`. "Back to the hospital" returns to the demo.

**Or let Claude Code do it.** Clone this repo, open [Claude Code](https://claude.com/claude-code) in the folder and ask: *"Convert MyModel.ifc into a building file and check that everyone can get out."* `CLAUDE.md` tells it how the pieces fit, so it can also fix up room names, occupancy or stairs for your model.

### What makes a model work well

- **Rooms placed and named.** Names set the number of people: offices get 1 person per 10 m², meeting rooms 1 per 2.5 m², wards or bed bays get dependent patients, and WCs, stores and plant rooms are empty. The rules are the `OCCUPANCY` table at the top of `tools/ifc_to_building.py`.
- **Doors modelled**, including the exit doors on the ground floor. Openings with no door in them count as doorways.
- **Stairs**, either as stair rooms on every floor or as Revit stairs. A stair room on one floor plus the stair itself is enough to join the floors.
- **Ground floor at 0.00.** The storey nearest 0.00 is where people get out; use `--ground "Level 1"` to pick another. Basements are skipped, because people in the sim only go down stairs.

The sideways, compartment-by-compartment evacuation needs fire compartments, which a plain model doesn't have. Converted buildings get the full evacuation only, unless you add a `compartment` to each room in the JSON (Claude Code can do this from a compartment plan or a room schedule).

The converter has been tested on a Revit house and a six-storey Archicad apartment building. Every model has its quirks, so if yours doesn't come through cleanly, open an issue or ask Claude Code to look at it.

## Run it locally

No install needed, only Python 3 to serve the files:

```bash
python3 -m http.server 8777
```

Then open http://localhost:8777. Headless check of the hospital (Node 18+): `node test_headless.mjs`.

## How it works

1. **Building file.** `buildings/*.building.json` holds only what movement needs: levels, walls (as centrelines with a thickness), doors, rooms (a point inside each, plus name, occupancy, beds, dependency and fire compartment) and which stair and lift rooms connect between floors.
2. **Grid.** Each floor is cut into 25 cm squares (`engine/grid.js`). Walls block squares, doors are cut through them, and each room claims the squares around its point.
3. **Flow fields.** For every square, the walking distance to safety: outside on the ground floor, or the nearest stair above it. A person just steps downhill.
4. **People.** `engine/people.js` turns each room's occupancy into staff, visitors and patients, each with a walking speed and reaction time. Crowds slow down (Weidmann's speed–density curve). Staff go and fetch dependent patients and move them together (`engine/sim.js`).
5. **Scenarios.** `engine/scenarios.js` says who moves and where safe is. Add a new one there.
