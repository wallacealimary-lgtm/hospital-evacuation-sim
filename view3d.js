// view3d.js — a three.js view of the same simulation.
// Nothing here changes the simulation; it only draws sim.agents each frame.
//
// Axes: building x → three X, building y (north) → three -Z, height → three Y.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cellAt } from './engine/grid.js';
import { KINDS } from './engine/furniture.js';

const PERSON_H = { staff: 1.75, visitor: 1.7, ambulant: 1.6, wheelchair: 1.25 };
const MAX_PEOPLE = 4000;

export class View3D {
  constructor(container, building, grid, { onPick, css }) {
    this.b = building; this.grid = grid; this.css = css; this.onPick = onPick;
    this.opts = { explode: 1.6, wallH: 1.2, upTo: grid.levels.length - 1 };
    const f = grid.frame;
    this.cx = f.minX + f.W * f.cell / 2; this.cy = f.minY + f.H * f.cell / 2;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);
    this.el = this.renderer.domElement;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
    this.camera.position.set(55, 75, 95);
    this.controls = new OrbitControls(this.camera, this.el);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 4, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(40, 80, 30); this.scene.add(sun);

    this.static = new THREE.Group(); this.scene.add(this.static);
    // people: cylinders for anyone standing or in a wheelchair, boxes for beds
    this.people = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0), new THREE.MeshLambertMaterial(), MAX_PEOPLE);
    this.beds = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial(), 400);
    for (const m of [this.people, this.beds]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; this.scene.add(m); }
    this.fire = new THREE.Group();
    this.fireBall = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.75 }));
    this.fireLight = new THREE.PointLight(0xff6a2a, 60, 25, 1.6);
    this.fire.add(this.fireBall, this.fireLight); this.scene.add(this.fire);

    this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
    let down = null;
    this.el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    this.el.addEventListener('pointerup', e => {           // a click, not a drag
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) { const h = this.pick(e); if (h) this.onPick(h); }
      down = null;
    });
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); this._c = new THREE.Color();
  }

  levelY(li) { return this.b.levels[li].elevation * this.opts.explode; }
  X(x) { return x - this.cx; }
  Z(y) { return -(y - this.cy); }

  resize(w, h) { this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  // Rebuild floors, walls and stair shafts (on reset, theme change, or option change).
  rebuild(sim, colourOf) {
    for (const c of [...this.static.children]) { this.static.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    this.renderer.setClearColor(new THREE.Color(this.css('--bg')));
    this.floors = [];
    const wallCol = new THREE.Color(this.css('--wall3d'));
    // ground plane
    const f = this.grid.frame;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(f.W * f.cell + 40, f.H * f.cell + 40).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: this.css('--outside') }));
    ground.position.y = -0.05; this.static.add(ground);

    this.grid.levels.forEach((g, li) => {
      const grp = new THREE.Group(); grp.userData.li = li; grp.visible = li <= this.opts.upTo;
      const floor = this.floorMesh(g, li, colourOf); floor.userData.li = li; grp.add(floor); this.floors.push(floor);
      grp.add(this.wallMesh(g, li, wallCol));
      grp.add(this.furnitureMesh(sim, li));
      this.static.add(grp);
    });
    // stair shafts: a faint column through every level
    const shaftMat = new THREE.MeshLambertMaterial({ color: this.css('--stair'), transparent: true, opacity: 0.28, depthWrite: false });
    for (const s of this.b.vertical) {
      const ris = Object.values(s.rooms).map(id => sim.roomIndex[id]);
      const lis = Object.keys(s.rooms).map(c => sim.levelOf[c]).filter(li => li <= this.opts.upTo);
      if (lis.length < 2) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const g = this.grid.levels[0];
      for (const i of sim.roomCells[ris[0]]) { const cx = i % g.W, cy = (i / g.W) | 0; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
      const w = (x1 - x0 + 1) * g.cell, d = (y1 - y0 + 1) * g.cell, top = this.levelY(Math.max(...lis)) + this.opts.wallH;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, top, d), shaftMat);
      box.position.set(this.X(g.minX + (x0 + x1 + 1) / 2 * g.cell), top / 2, this.Z(g.minY + (y0 + y1 + 1) / 2 * g.cell));
      this.static.add(box);
    }
    // lift cars: a box the size of the lift, riding up and down its shaft
    this.carMeshes = sim.cars.map(car => {
      const g = this.grid.levels[0], ri = sim.roomIndex[car.shaft.rooms[g.code]];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of sim.roomCells[ri]) { const cx = i % g.W, cy = (i / g.W) | 0; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
      const m = new THREE.Mesh(new THREE.BoxGeometry((x1 - x0 + 1) * g.cell * 0.9, 2.4, (y1 - y0 + 1) * g.cell * 0.9).translate(0, 1.2, 0),
        new THREE.MeshLambertMaterial({ color: this.css('--accent'), emissive: this.css('--accent'), emissiveIntensity: 0.7 }));
      m.position.set(this.X(g.minX + (x0 + x1 + 1) / 2 * g.cell), 0, this.Z(g.minY + (y0 + y1 + 1) / 2 * g.cell));
      m.userData.car = car;
      this.static.add(m);
      return m;
    });
    this.fitOnce();
  }

  // Furniture: one instanced box per item, coloured by kind. Beds a patient is lying in are hidden (the patient is drawn as the bed).
  furnitureMesh(sim, li) {
    const items = this.grid.furniture.filter(it => it.level === li && !sim.hiddenItems.has(it));
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial(), Math.max(1, items.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color(), base = this.levelY(li) + 0.01;
    items.forEach((it, k) => {
      const [h, col] = KINDS[it.kind];
      p.set(this.X((it.x0 + it.x1) / 2), base, this.Z((it.y0 + it.y1) / 2));
      sc.set(Math.max(0.05, it.x1 - it.x0 - 0.04), h, Math.max(0.05, it.y1 - it.y0 - 0.04));
      mesh.setMatrixAt(k, m.compose(p, q, sc)); mesh.setColorAt(k, c.set(col));
    });
    mesh.count = items.length;
    return mesh;
  }

  // Floor: merge cells of the same colour into rectangles, then one mesh with vertex colours.
  floorMesh(g, li, colourOf) {
    const pos = [], col = [], y = this.levelY(li) + 0.01, c = new THREE.Color();
    const key = i => g.outside[i] ? -2 : g.room[i];
    let open = new Map();                       // "x0,x1,key" -> rect {x0,x1,y0,y1,k}
    const rects = [];
    for (let cy = 0; cy < g.H; cy++) {
      const runs = [];
      for (let cx = 0; cx < g.W;) {
        const k = key(cy * g.W + cx);
        let e = cx; while (e + 1 < g.W && key(cy * g.W + e + 1) === k) e++;
        if (k !== -2 && !(k >= 0 && this.b.rooms[k].kind === 'lift')) runs.push([cx, e, k]);   // lift shafts are holes in the floor
        cx = e + 1;
      }
      const next = new Map();
      for (const [a, e, k] of runs) {
        const id = a + ',' + e + ',' + k, r = open.get(id);
        if (r) { r.y1 = cy; next.set(id, r); open.delete(id); } else { const nr = { x0: a, x1: e, y0: cy, y1: cy, k }; rects.push(nr); next.set(id, nr); }
      }
      open = next;
    }
    for (const r of rects) {
      c.set(colourOf(r.k, li));
      const xa = this.X(g.minX + r.x0 * g.cell), xb = this.X(g.minX + (r.x1 + 1) * g.cell);
      const za = this.Z(g.minY + r.y0 * g.cell), zb = this.Z(g.minY + (r.y1 + 1) * g.cell);
      pos.push(xa, y, za, xb, y, za, xb, y, zb, xa, y, za, xb, y, zb, xa, y, zb);
      for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  // Walls as boxes, split around door openings (with a lintel when walls are full height).
  wallMesh(g, li, colour) {
    const pieces = [], H = this.opts.wallH, base = this.levelY(li);
    const doors = this.b.doors.filter(d => d.level === g.code);
    for (const w of this.b.walls) {
      if (w.level !== g.code) continue;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1, L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const ux = dx / L, uy = dy / L, cuts = [];
      for (const d of doors) {
        if ((d.axis === 'x') !== (Math.abs(ux) > 0.7)) continue;
        const t = (d.x - w.x1) * ux + (d.y - w.y1) * uy, off = Math.abs(-(d.x - w.x1) * uy + (d.y - w.y1) * ux);
        if (off <= w.t / 2 + 0.25 && t > -d.width / 2 && t < L + d.width / 2) cuts.push([t - d.width / 2, t + d.width / 2]);
      }
      cuts.sort((a, b) => a[0] - b[0]);
      let s = 0;
      for (const [a, b] of cuts) {
        if (a > s) pieces.push([w, ux, uy, s, a, 0, H]);
        if (H > 2.2) pieces.push([w, ux, uy, Math.max(0, a), Math.min(L, b), 2.1, H]);
        s = Math.max(s, b);
      }
      if (s < L) pieces.push([w, ux, uy, s, L, 0, H]);
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: colour }), Math.max(1, pieces.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    pieces.forEach(([w, ux, uy, a, b, z0, z1], k) => {
      const mx = w.x1 + ux * (a + b) / 2, my = w.y1 + uy * (a + b) / 2;
      q.setFromAxisAngle(up, Math.atan2(uy, ux));          // building y is -Z, so +angle turns the right way
      p.set(this.X(mx), base + (z0 + z1) / 2, this.Z(my));
      sc.set(Math.max(0.02, b - a), z1 - z0, w.t);
      mesh.setMatrixAt(k, m.compose(p, q, sc));
    });
    mesh.count = pieces.length;
    return mesh;
  }

  fitOnce() {
    if (this.fitted) return; this.fitted = true;
    const f = this.grid.frame, span = Math.max(f.W, f.H) * f.cell;
    this.camera.position.set(span * 0.3, span * 0.78, span * 0.55);
    this.controls.target.set(0, this.levelY(1) * 0.6, 0); this.controls.update();
  }

  setLevels(upTo) {
    this.opts.upTo = upTo;
    for (const grp of this.static.children) if (grp.userData.li !== undefined) grp.visible = grp.userData.li <= upTo;
  }

  // ------------------------------------------------------------- per frame
  render(sim, t) {
    let n = 0, nb = 0;
    const m = this._m, q = this._q, s = this._s, p = this._p, c = this._c;
    for (const a of sim.agents) {
      if (a.hidden || a.state === 'onstair' || a.state === 'inlift' || a.level > this.opts.upTo) continue;
      if (a.state === 'safe' && sim.t - a.tSafe > 8) continue;
      const y = this.levelY(a.level) + 0.02;
      c.set(a.state === 'safe' ? this.css('--safe') : a.P.colour);
      if (a.state === 'hold') c.lerp(this._grey ||= new THREE.Color(0x8a8f96), 0.45);
      if (a.state === 'waiting') c.lerp(this._white ||= new THREE.Color(0xffffff), 0.35 + 0.35 * Math.sin(t / 180));
      if (a.profile === 'bed') {
        const sp = Math.hypot(a.vx, a.vy), ang = sp > 0.05 ? Math.atan2(a.vy, a.vx) : (a.heading ?? 0);
        a.heading = ang;
        q.setFromAxisAngle(this._up ||= new THREE.Vector3(0, 1, 0), ang);
        m.compose(p.set(this.X(a.x), y, this.Z(a.y)), q, s.set(2.1, 0.75, 0.95));
        this.beds.setMatrixAt(nb, m); this.beds.setColorAt(nb++, c);
      } else {
        const sitting = a.seated && (a.state === 'idle' || a.state === 'hold');   // still in their chair
        const h = sitting ? 1.25 : PERSON_H[a.profile] || 1.7, r = a.profile === 'wheelchair' ? 0.38 : a.radius * 0.9;
        m.compose(p.set(this.X(a.x), y, this.Z(a.y)), q.identity(), s.set(r, h, r));
        this.people.setMatrixAt(n, m); this.people.setColorAt(n++, c);
        if (n >= MAX_PEOPLE) break;
      }
    }
    this.people.count = n; this.beds.count = nb;
    for (const im of [this.people, this.beds]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }

    for (const m of this.carMeshes || []) {
      const car = m.userData.car, lo = Math.floor(car.pos), hi = Math.min(lo + 1, this.b.levels.length - 1), k = car.pos - lo;
      m.position.y = this.levelY(lo) * (1 - k) + this.levelY(hi) * k + 0.02;
    }
    this.fire.visible = !!sim.fire && sim.fire.levelIndex <= this.opts.upTo;
    if (this.fire.visible) {
      const r = this.b.rooms[sim.fire.room], k = 1 + 0.18 * Math.sin(t / 90) + 0.08 * Math.sin(t / 37);
      this.fire.position.set(this.X(r.x), this.levelY(sim.fire.levelIndex) + 1, this.Z(r.y));
      this.fireBall.scale.setScalar(0.9 * k); this.fireLight.intensity = 50 * k;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // Click on a floor -> { li, ri } (room index under the cursor)
  pick(e) {
    const r = this.el.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const hits = this.ray.intersectObjects(this.floors.filter(f => f.parent.visible), false);
    if (!hits.length) return null;
    const h = hits[0], li = h.object.userData.li, g = this.grid.levels[li];
    const x = h.point.x + this.cx, y = -h.point.z + this.cy, i = cellAt(g, x, y);
    return i >= 0 && g.room[i] >= 0 ? { li, ri: g.room[i] } : null;
  }
}
