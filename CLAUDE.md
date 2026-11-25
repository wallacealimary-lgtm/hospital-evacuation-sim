# People Movement Sim (hospital evacuation)

A browser evacuation sim. Plain ES modules, no build step, no npm install; three.js is vendored in `vendor/`. Published with GitHub Pages from the repo root.

- `index.html` + `app.js` (UI, 2D canvas), `view3d.js` (three.js view).
- `engine/`: `grid.js` (25 cm grid, walls, doors, rooms, flow fields), `sim.js` (people, stairs, lifts), `people.js` (profiles, occupancy → people), `scenarios.js` (full / horizontal evacuation), `furniture.js` (furniture from room names).
- `buildings/RCH.building.json`: the demo hospital in the `sim.building.v1` format.
- `tools/ifc_to_building.py`: IFC (Revit, Archicad...) → building file. `tools/check.mjs`: headless check of any building file.

## Building file (`sim.building.v1`, metres)

- `levels[]`: `code` (L00, L01... — L00 must be the ground/exit level), `name`, `elevation`.
- `walls[]`: `level`, `x1 y1 x2 y2` centreline, `t` thickness.
- `doors[]`: `level`, `x y` centre, `width`, `axis` ('x' if the door sits in a wall running along x, else 'y'), optional `dir` [ux, uy] for walls at an angle, `kind`, `fire`.
- `rooms[]`: `id`, `level`, `x y` (a point inside), `name`, `kind` (room/corridor/stair/lift/lobby/entrance), `area`, `occupancy`, `beds`, `dependency` ('', independent, dependent, very high dependency), `compartment` (needed for horizontal evacuation).
- `vertical[]`: `{kind: 'stair'|'lift', name, rooms: {L00: roomId, L01: roomId...}}` joins stair/lift rooms between floors.

## Converting a user's model

1. `pip install -r tools/requirements.txt` (ifcopenshell, shapely, numpy).
2. `python3 tools/ifc_to_building.py Model.ifc out.building.json` (options `--ground "<storey name>"`, `--name`).
3. `node tools/check.mjs out.building.json` — every room should have floor, and the full evacuation should end with everyone safe.
4. If people are stuck: rooms with no floor usually mean a leak (the outside floods in through a gap) or a room point inside a wall; trapped people usually mean a missing door, a missing exit, or a stair not joined between floors (look at `vertical`). Fix in the converter if it is general, or patch the JSON for that one model.
5. The user loads the file with "Load your building…" on the page (kept in localStorage, never uploaded), or serve locally and open `?b=./path/to/file.json`.

Never commit users' IFC files or converted buildings (`*.ifc` and `tmp/` are git-ignored).

## Checks

`node test_headless.mjs` (RCH reference: full/day 9:16, full/night 18:03, night with bed lifts 15:37, horizontal 2:51). If an engine change moves these, say so and update the README.

The numbers are uncalibrated: a toy for exploring ideas, not fire engineering.
