#!/usr/bin/env python3
"""Turn an IFC export of a building (from Revit, Archicad, ...) into a sim building file.

    pip install ifcopenshell shapely numpy
    python3 tools/ifc_to_building.py MyModel.ifc my.building.json

Then open the sim, press "Load your building..." and pick my.building.json.

What it reads, and how:
  levels   IfcBuildingStorey. The storey nearest 0.00 is the ground floor (the exit level);
           storeys below it are skipped, because people in the sim only go down stairs.
           Use --ground "Level 1" to choose another one.
  walls    every wall, curtain wall, panel, mullion, column and window is cut horizontally 1.2 m above
           each floor (doors left solid) and the cut is turned into wall centrelines.
  doors    IfcDoor: centre, width and direction, cut back through the walls by the sim.
  rooms    IfcSpace (Revit rooms, if "Export rooms" was on): a point inside, name, area.
           Occupancy is a rule of thumb from the room name and area (see OCCUPANCY).
  stairs   stair rooms on neighbouring floors that overlap are joined into one stair;
           IfcStair geometry fills in any stair that has no room.
  lifts    lift rooms joined the same way (they only matter with evacuation lifts on).

Everything here is an estimate for playing with ideas, not a fire engineering model.
"""
import argparse
import json
import math
import re
import sys
from collections import defaultdict

try:
    import numpy as np
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.element as ue
    import ifcopenshell.util.placement
    import ifcopenshell.util.unit as uu
    from shapely.geometry import LineString, MultiPoint, MultiPolygon
    from shapely.ops import polygonize, unary_union
except ImportError as e:
    sys.exit(f"Missing a library ({e.name}). Install them with:  pip install ifcopenshell shapely numpy")

CUT = 1.2              # metres above each floor where walls are cut
MIN_WALL_T = 0.12      # thinner cuts (glass, panels) are widened so people can't slip through

# Room kind from its name (English and a little German). First match wins.
KINDS = [
    ('stair', r'stair|treppe|escalier|trappa'),
    ('lift', r'\blift|elevator|aufzug|ascenseur'),
    ('corridor', r'corridor|hall ?way|passage|circulation|flur|gang\b|korridor|walkway'),
    ('entrance', r'entrance|entry|foyer|vestibule|windfang|eingang'),
    ('lobby', r'lobby|atrium|concourse'),
]

# People per room from its name: (pattern, m² per person, beds per m², dependency).
# The first matching rule wins; the last one is the default.
OCCUPANCY = [
    (r'wc|toilet|bath|shower|store|storage|plant|riser|shaft|cleaner|garage|parking|stellplatz|technik|lager|abstell|server|electrical|mechanical|janitor|duct', None, 0, ''),
    (r'ward|patient|\d-bed|bed bay|single bed|icu|critical care|isolation', 12, 1 / 10, 'dependent'),
    (r'class|lecture|seminar|meeting|conference|training|besprechung', 2.5, 0, ''),
    (r'restaurant|canteen|cafe|café|dining|bar\b|kantine', 1.5, 0, ''),
    (r'waiting|lounge|reception|wait\b|warte', 2, 0, ''),
    (r'shop|retail|sales|laden', 3, 0, ''),
    (r'gym|sport|hall\b|assembly|aula', 3, 0, ''),
    (r'living|kitchen|bed|wohnen|küche|schlaf|zimmer', 15, 0, ''),
    (r'.*', 10, 0, ''),                          # offices and everything else
]

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('ifc')
ap.add_argument('out')
ap.add_argument('--ground', help='name of the ground-floor storey (default: the one nearest 0.00)')
ap.add_argument('--name', help='project name shown in the sim (default: from the IFC)')
args = ap.parse_args()

print(f'Reading {args.ifc} ...')
f = ifcopenshell.open(args.ifc)
scale = uu.calculate_unit_scale(f)
settings = ifcopenshell.geom.settings()
settings.set('use-world-coords', True)
settings.set('disable-opening-subtractions', True)


def shapes(entities):
    """(entity, vertices Nx3, faces Mx3) for each entity that has a 3D body, in metres."""
    entities = [e for e in entities if getattr(e, 'Representation', None)]
    if not entities:
        return
    it = ifcopenshell.geom.iterator(settings, f, include=entities)
    if not it.initialize():
        return
    while True:
        s = it.get()
        v = np.array(s.geometry.verts, dtype=float).reshape(-1, 3)
        fa = np.array(s.geometry.faces, dtype=int).reshape(-1, 3)
        if len(fa):
            yield f.by_id(s.id), v, fa
        if not it.next():
            break


def section(v, fa, z):
    """Line segments where a mesh crosses the horizontal plane at height z."""
    tri = v[fa]                                  # (M, 3 corners, xyz)
    d = tri[:, :, 2] - z
    above = d > 0
    n_above = above.sum(1)
    tri, d = tri[(n_above == 1) | (n_above == 2)], d[(n_above == 1) | (n_above == 2)]
    segs = []
    for t, dd in zip(tri, d):
        pts = []
        for a, b in ((0, 1), (1, 2), (2, 0)):
            if (dd[a] > 0) != (dd[b] > 0):
                k = dd[a] / (dd[a] - dd[b])
                pts.append(t[a, :2] + k * (t[b, :2] - t[a, :2]))
        if len(pts) == 2:
            a, b = np.round(pts[0], 3), np.round(pts[1], 3)   # snap to 1 mm so pieces join up
            if (a != b).any():
                segs.append((a, b))
    return segs


def footprint(v, fa, z):
    """The outline of a mesh cut at height z, as one shapely polygon (or None)."""
    segs = section(v, fa, z)
    if not segs:
        return None
    polys = list(polygonize(unary_union([LineString(s) for s in segs])))
    if not polys:
        return None
    p = unary_union(polys)
    return max(p.geoms, key=lambda g: g.area) if isinstance(p, MultiPolygon) else p


def r3(x):
    return round(float(x), 3)

# ------------------------------------------------------------------ levels
storeys = sorted(f.by_type('IfcBuildingStorey'), key=lambda s: (s.Elevation or 0))
if not storeys:
    sys.exit('No storeys (IfcBuildingStorey) in this file.')
elev = {s.id(): (s.Elevation or 0) * scale for s in storeys}
if args.ground:
    ground = next((s for s in storeys if (s.Name or '').strip().lower() == args.ground.strip().lower()), None)
    if not ground:
        sys.exit(f'No storey called "{args.ground}". Storeys: ' + ', '.join(s.Name or '?' for s in storeys))
else:
    ground = min(storeys, key=lambda s: abs(elev[s.id()]))
g0 = elev[ground.id()]
skipped = [s.Name for s in storeys if elev[s.id()] < g0 - 0.01]
cand = [s for s in storeys if elev[s.id()] >= g0 - 0.01]

# ------------------------------------------------------------------ rooms (IfcSpace) per storey
def storey_of(e):
    """The storey an element belongs to: its spatial container, or what it is part of."""
    p = ue.get_container(e) or ue.get_aggregate(e)
    while p is not None and not p.is_a('IfcBuildingStorey'):
        p = ue.get_aggregate(p)
    return p


def kind_of(name):
    for k, pat in KINDS:
        if re.search(pat, name, re.I):
            return k
    return 'room'


raw_rooms = []
for sp, v, fa in shapes(f.by_type('IfcSpace')):
    st = storey_of(sp)
    zmin = v[:, 2].min()
    if st is None or st.id() not in elev:
        st = min(cand, key=lambda s: abs(elev[s.id()] - zmin))
    if elev[st.id()] < g0 - 0.01:
        continue
    poly = footprint(v, fa, zmin + min(0.5, (v[:, 2].max() - zmin) / 2))
    if poly is None or poly.area < 0.5:
        continue
    name = (sp.LongName or sp.Name or 'Room').strip()
    number = (sp.Name or '').strip() if sp.LongName else ''
    raw_rooms.append({'storey': st, 'name': name, 'number': number, 'poly': poly, 'kind': kind_of(name)})

# A storey is kept if it has rooms, or walls cut at its height (checked below).
levels = []
for s in cand:
    levels.append({'storey': s, 'z': elev[s.id()]})

# ------------------------------------------------------------------ walls: cut every blocking element at each level
wall_types = ['IfcWall', 'IfcCurtainWall', 'IfcPlate', 'IfcMember', 'IfcColumn', 'IfcWindow']
blockers = [e for t in wall_types for e in f.by_type(t)]
cuts = defaultdict(list)                                # level index -> shapely geometries
for e, v, fa in shapes(blockers):
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    for li, L in enumerate(levels):
        zc = L['z'] + CUT
        if z0 < zc < z1:
            segs = section(v, fa, zc)
            if segs:
                cuts[li].append(segs)


def walls_from(segs, level_code):
    """Wall centrelines from one element's cut: one wall per straight piece, outline edges otherwise."""
    out = []
    polys = list(polygonize(unary_union([LineString(s) for s in segs])))
    shape = unary_union(polys) if polys else unary_union([LineString(s) for s in segs]).buffer(MIN_WALL_T / 2)
    if not polys:                                      # open cut (a single sheet): use the segments
        for (a, b) in segs:
            out.append((a, b, MIN_WALL_T))
    for p in polys:
        if p.area < 0.002:
            continue
        rect = p.minimum_rotated_rectangle
        c = list(rect.exterior.coords)[:4]
        e1, e2 = np.subtract(c[1], c[0]), np.subtract(c[2], c[1])
        l1, l2 = np.hypot(*e1), np.hypot(*e2)
        if p.area / max(rect.area, 1e-9) > 0.8:          # a straight wall: one centreline
            if l1 < l2:
                e1, e2, l1, l2 = e2, e1, l2, l1
            mid = np.mean(c, axis=0)
            u = e1 / l1
            a, b = mid - u * l1 / 2, mid + u * l1 / 2
            out.append((a, b, max(l2, MIN_WALL_T)))
        else:                                          # L-shaped, curved...: trace the outline
            ring = list(p.exterior.coords)
            for a, b in zip(ring, ring[1:]):
                out.append((np.array(a), np.array(b), MIN_WALL_T))
    return [{'level': level_code, 'x1': r3(a[0]), 'y1': r3(a[1]), 'x2': r3(b[0]), 'y2': r3(b[1]), 't': r3(t)}
            for a, b, t in out if np.hypot(*(np.subtract(b, a))) > 0.02], shape


SEAL = 0.25    # close gaps narrower than 2 x SEAL between neighbouring elements (window frame to wall...)


def seal(shapes_, level_code):
    """Short walls that fill the small gaps left between elements, so the outside can't leak in."""
    u = unary_union(shapes_)
    closed = u.buffer(SEAL, join_style=2).buffer(-SEAL, join_style=2)
    gaps = closed.difference(u)
    out = []
    for g in getattr(gaps, 'geoms', [gaps]):
        if g.is_empty or g.area < 0.0005 or g.geom_type != 'Polygon':
            continue
        rect = g.minimum_rotated_rectangle
        if rect.geom_type != 'Polygon':
            continue
        c = list(rect.exterior.coords)[:4]
        e1, e2 = np.subtract(c[1], c[0]), np.subtract(c[2], c[1])
        l1, l2 = np.hypot(*e1), np.hypot(*e2)
        if l1 < l2:
            e1, e2, l1, l2 = e2, e1, l2, l1
        mid, u1 = np.mean(c, axis=0), e1 / max(l1, 1e-9)
        a, b = mid - u1 * l1 / 2, mid + u1 * l1 / 2
        out.append({'level': level_code, 'x1': r3(a[0]), 'y1': r3(a[1]), 'x2': r3(b[0]), 'y2': r3(b[1]), 't': r3(max(l2, MIN_WALL_T))})
    return out


# drop storeys with nothing on them (roof levels, top of parapet...), then name the rest
keep = [li for li, L in enumerate(levels) if cuts[li] and (any(r['storey'] == L['storey'] for r in raw_rooms) or li == 0)]
if not keep or levels[keep[0]]['storey'] != ground:
    sys.exit(f'The ground storey "{ground.Name}" has no walls or rooms at {CUT} m. Pick another with --ground.')
code_of = {}
out_levels = []
for n, li in enumerate(keep):
    L = levels[li]
    code = f'L{n:02d}'
    code_of[L['storey'].id()] = code
    L['code'] = code
    out_levels.append({'code': code, 'name': L['storey'].Name or code, 'elevation': r3(L['z'] - g0)})

walls, sealed = [], 0
for li in keep:
    shapes_ = []
    for segs in cuts[li]:
        w, shp = walls_from(segs, levels[li]['code'])
        walls += w
        shapes_.append(shp)
    extra = seal(shapes_, levels[li]['code'])
    sealed += len(extra)
    walls += extra

# ------------------------------------------------------------------ doors
def level_for_z(z):
    best = None
    for li in keep:
        if levels[li]['z'] - 0.5 <= z:
            best = li
    return best


doors = []
door_ents = f.by_type('IfcDoor')
geo = {e.id(): v for e, v, fa in shapes(door_ents)}
for d in door_ents:
    v = geo.get(d.id())
    if v is None:
        continue
    li = level_for_z(v[:, 2].min() + 0.05)
    if li is None:
        continue
    # the door's own x axis runs along its wall
    m = ifcopenshell.util.placement.get_local_placement(d.ObjectPlacement) if d.ObjectPlacement else np.eye(4)
    ux = np.array(m[:2, 0], dtype=float)
    ux = ux / (np.hypot(*ux) or 1)
    uy = np.array([-ux[1], ux[0]])
    xy = v[:, :2]
    px, py = xy @ ux, xy @ uy
    cx, cy = (px.min() + px.max()) / 2, (py.min() + py.max()) / 2
    centre = ux * cx + uy * cy
    width = (d.OverallWidth or 0) * scale or (px.max() - px.min())
    width = max(0.6, min(width, px.max() - px.min() + 0.05))
    ang = math.degrees(math.atan2(ux[1], ux[0])) % 180
    door = {'id': d.GlobalId, 'level': levels[li]['code'], 'x': r3(centre[0]), 'y': r3(centre[1]), 'width': r3(width),
            'fire': '', 'kind': 'double' if width > 1.3 else 'single'}
    if min(ang, 180 - ang) < 3:
        door['axis'] = 'x'
    elif abs(ang - 90) < 3:
        door['axis'] = 'y'
    else:
        door['axis'] = 'x' if (ang < 45 or ang > 135) else 'y'
        door['dir'] = [r3(ux[0]), r3(ux[1])]
    doors.append(door)

# Openings with no door in them (archways, cased openings) that reach the floor are doorways too,
# because the walls above were cut solid.
open_ents = [o for o in f.by_type('IfcOpeningElement') if not o.HasFillings]
for o, v, fa in shapes(open_ents):
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    li = level_for_z(z0 + 0.05)
    if li is None or z0 > levels[li]['z'] + 0.3 or z1 - z0 < 1.8:
        continue
    rect = MultiPoint([tuple(p) for p in v[:, :2]]).minimum_rotated_rectangle
    if rect.geom_type != 'Polygon':
        continue
    c = list(rect.exterior.coords)[:4]
    e1, e2 = np.subtract(c[1], c[0]), np.subtract(c[2], c[1])
    l1, l2 = np.hypot(*e1), np.hypot(*e2)
    if l1 < l2:
        e1, l1, l2 = e2, l2, l1
    if l1 < 0.6:
        continue
    ux = e1 / l1
    mid = np.mean(c, axis=0)
    ang = math.degrees(math.atan2(ux[1], ux[0])) % 180
    door = {'id': o.GlobalId, 'level': levels[li]['code'], 'x': r3(mid[0]), 'y': r3(mid[1]), 'width': r3(l1),
            'fire': '', 'kind': 'opening', 'axis': 'x' if (ang < 45 or ang > 135) else 'y'}
    if 3 < min(ang, 180 - ang) and abs(ang - 90) > 3:
        door['dir'] = [r3(ux[0]), r3(ux[1])]
    doors.append(door)

# Some exporters cut the door holes into the walls themselves. A short wall across every doorway
# closes those holes; the sim then cuts it back open as a proper door.
for d in doors:
    u = d.get('dir') or ([1, 0] if d['axis'] == 'x' else [0, 1])
    h = d['width'] / 2 + 0.1
    walls.append({'level': d['level'], 'x1': r3(d['x'] - u[0] * h), 'y1': r3(d['y'] - u[1] * h),
                  'x2': r3(d['x'] + u[0] * h), 'y2': r3(d['y'] + u[1] * h), 't': 0.2, 'type': 'door-frame'})

# ------------------------------------------------------------------ rooms
rooms = []
for k, r in enumerate(raw_rooms):
    code = code_of.get(r['storey'].id())
    if not code:
        continue
    poly = r['poly']
    pt = poly.representative_point()
    area = poly.area
    occ, beds, dep = 0, 0, 'independent'
    if r['kind'] == 'room':
        for pat, m2pp, bedsper, d in OCCUPANCY:
            if re.search(pat, r['name'], re.I):
                if m2pp:
                    beds = round(area * bedsper) if bedsper else 0
                    occ = max(1, round(area / m2pp)) + beds
                    dep = d or 'independent'
                break
    rooms.append({'id': f'{code}:{k:04d}', 'level': code, 'number': r['number'], 'name': r['name'], 'dept': '',
                  'kind': r['kind'], 'x': r3(pt.x), 'y': r3(pt.y), 'area': round(area, 1),
                  'occupancy': occ, 'beds': beds, 'dependency': dep, 'compartment': '', '_poly': poly})

# ------------------------------------------------------------------ stairs and lifts: join rooms across floors
order = {levels[li]['code']: n for n, li in enumerate(keep)}


def shafts(kind):
    rs = [r for r in rooms if r['kind'] == kind]
    parent = list(range(len(rs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(rs):
        for j, b in enumerate(rs):
            if j > i and abs(order[a['level']] - order[b['level']]) == 1 and a['_poly'].buffer(0.3).intersects(b['_poly']):
                parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i, r in enumerate(rs):
        groups[find(i)].append(r)
    out = []
    for g in groups.values():
        per = {}
        for r in sorted(g, key=lambda r: -r['area']):
            per.setdefault(r['level'], r['id'])
        if len(per) > 1:
            out.append(per)
    return out


# IfcStair geometry adds a stair room on any floor the stair reaches that has none,
# so a stair with a room only at the bottom (common in Revit) still joins the floors.
added = 0
for st, v, fa in shapes(f.by_type('IfcStair') + f.by_type('IfcStairFlight')):
    hull = MultiPoint([tuple(p) for p in v[:, :2]]).convex_hull
    if hull.area < 1:
        continue
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    for li in keep:
        z, code = levels[li]['z'], levels[li]['code']
        if not (z0 - 0.4 <= z <= z1 + 0.4):
            continue
        if any(r['level'] == code and r['kind'] == 'stair' and r['_poly'].intersects(hull) for r in rooms):
            continue
        pt = hull.representative_point()
        rooms.append({'id': f'{code}:S{added:03d}', 'level': code, 'number': '', 'name': 'Stair (from model)', 'dept': '',
                      'kind': 'stair', 'x': r3(pt.x), 'y': r3(pt.y), 'area': round(hull.area, 1), 'occupancy': 0, 'beds': 0,
                      'dependency': 'independent', 'compartment': '', '_poly': hull})
        added += 1

vertical = []
for n, per in enumerate(shafts('stair')):
    vertical.append({'kind': 'stair', 'name': f'Stair {n + 1}', 'rooms': per})
for n, per in enumerate(shafts('lift')):
    vertical.append({'kind': 'lift', 'name': f'Lift {n + 1}', 'rooms': per})

for r in rooms:
    r.pop('_poly', None)

project = f.by_type('IfcProject')[0] if f.by_type('IfcProject') else None
name = args.name or (project and (project.LongName or project.Name)) or 'Your building'
building = {
    'schema': 'sim.building.v1',
    'project': {'code': 'IFC', 'name': name, 'source': 'ifc'},
    'units': 'm',
    'levels': out_levels, 'walls': walls, 'doors': doors, 'rooms': rooms, 'vertical': vertical,
}
with open(args.out, 'w') as fh:
    json.dump(building, fh, separators=(',', ':'))

people = sum(r['occupancy'] for r in rooms)
print(f'Wrote {args.out}')
print(f'  {len(out_levels)} levels ({", ".join(l["name"] for l in out_levels)}), ground = "{ground.Name}"')
if skipped:
    print(f'  skipped below ground: {", ".join(skipped)} (people only go down stairs in this sim)')
print(f'  {len(walls)} wall pieces ({sealed} small gaps sealed), {len(doors)} doors and openings, {len(rooms)} rooms, about {people} people')
print(f'  {sum(v["kind"] == "stair" for v in vertical)} stairs, {sum(v["kind"] == "lift" for v in vertical)} lifts joining floors')
if not raw_rooms:
    print('  WARNING: no rooms (IfcSpace). In Revit, tick "Export rooms" in the IFC export options, or nobody spawns.')
if len(out_levels) > 1 and not any(v['kind'] == 'stair' for v in vertical):
    print('  WARNING: no stair joins two floors, so people upstairs cannot get out.')
