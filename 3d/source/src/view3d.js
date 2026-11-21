// 3D viewport: three.js scene, CAD camera controls, picking, face groups, view cube, overlay canvas.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STD_PLANES, PALETTE } from './model.js';

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class View3D {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'gl';
    host.appendChild(this.renderer.domElement);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'ov';
    host.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d');

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 40000);
    this.H0 = 120;
    this.dist = 8000;
    this.target = new THREE.Vector3(0, 0, 0);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1, 0.8).normalize().multiplyScalar(this.dist);
    this.camera.lookAt(this.target);
    this.camera.zoom = 1;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.camera.add(this.key);
    this.key.position.set(0.5, 1, 1);
    this.scene.add(this.camera);

    this.gBodies = new THREE.Group(); this.scene.add(this.gBodies);
    this.gPlanes = new THREE.Group(); this.scene.add(this.gPlanes);
    this.gPreview = new THREE.Group(); this.scene.add(this.gPreview);
    this.gHi = new THREE.Group(); this.scene.add(this.gHi);
    this.gGrid = new THREE.Group(); this.scene.add(this.gGrid);
    this.gOrigin = new THREE.Group(); this.scene.add(this.gOrigin);
    this.buildOrigin();
    this.bodies = [];       // {body, mesh, edges, groups, geo}
    this.planeObjs = [];    // {key, mesh, plane, size, label}
    this.raycaster = new THREE.Raycaster();
    this.needs = true;
    this.overlayDraw = null;
    this.handlers = {};
    this.buildCube();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindControls();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.anim) this.stepAnim();
      if (this.needs) { this.needs = false; this.render(); }
    };
    loop();
  }

  request() { this.needs = true; }

  resize() {
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600;
    this.W = w; this.H = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.overlay.width = Math.round(w * dpr); this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = w + 'px'; this.overlay.style.height = h + 'px';
    this.updateCam();
    this.request();
  }
  updateCam() {
    const a = this.W / this.H, H = this.H0;
    Object.assign(this.camera, { left: -H * a, right: H * a, top: H, bottom: -H });
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.W, this.H);
    this.renderer.render(this.scene, this.camera);
    // view cube in the top right corner
    const s = 96;
    const q = this.camera.quaternion;
    this.cubeCam.position.set(0, 0, 6).applyQuaternion(q);
    this.cubeCam.up.set(0, 1, 0).applyQuaternion(q);
    this.cubeCam.lookAt(0, 0, 0);
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(this.W - s - 8, this.H - s - 8, s, s);
    this.renderer.setViewport(this.W - s - 8, this.H - s - 8, s, s);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.cubeScene, this.cubeCam);
    this.renderer.autoClear = true;
    this.renderer.setScissorTest(false);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    this.drawPlaneLabels(ctx);
    if (this.overlayDraw) this.overlayDraw(ctx);
  }

  // ---------- projection helpers ----------
  project(p) {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    return [(v.x + 1) / 2 * this.W, (1 - v.y) / 2 * this.H];
  }
  ray(sx, sy) {
    const ndc = new THREE.Vector2(sx / this.W * 2 - 1, -(sy / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }
  rayPlane(sx, sy, pl) {
    const r = this.ray(sx, sy);
    const n = v3(pl.n), o = v3(pl.o);
    const den = r.direction.dot(n);
    if (Math.abs(den) < 1e-9) return null;
    const t = o.clone().sub(r.origin).dot(n) / den;
    const p = r.origin.clone().addScaledVector(r.direction, t);
    return [p.x, p.y, p.z];
  }
  pxSize() { return (this.camera.top - this.camera.bottom) / this.camera.zoom / this.H; }
  viewDir() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); }

  // ---------- controls ----------
  bindControls() {
    const el = this.overlay;
    el.addEventListener('contextmenu', e => e.preventDefault());
    let drag = null;
    const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      // view cube
      if (x > this.W - 104 && y < 104) { const hit = this.cubePick(x - (this.W - 104), y); if (hit) { this.viewTo(hit.dir, hit.up); return; } }
      el.setPointerCapture(e.pointerId);
      if (e.button === 2 || e.button === 1) { drag = { mode: e.button === 2 ? 'rotate' : 'pan', x, y, moved: 0, btn: e.button }; return; }
      const consumed = this.handlers.down ? this.handlers.down(x, y, e) : false;
      if (consumed) drag = { mode: 'tool', x, y, moved: 0 };
      else if (e.shiftKey) drag = { mode: 'pan', x, y, moved: 0, btn: 0 };
      else drag = { mode: 'rotate', x, y, moved: 0, btn: e.button, click: true };
    });
    el.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (drag && (drag.mode === 'rotate' || drag.mode === 'pan')) {
        const dx = x - drag.x, dy = y - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = x; drag.y = y;
        if (drag.moved > 3) {
          this.anim = null;
          if (drag.mode === 'rotate') this.orbit(dx, dy); else this.pan(dx, dy);
          if (this.handlers.viewChanged) this.handlers.viewChanged();
        }
        return;
      }
      if (drag && drag.mode === 'tool') { drag.moved += 1; if (this.handlers.drag) this.handlers.drag(x, y, e); return; }
      if (this.handlers.move) this.handlers.move(x, y, e);
    });
    let lastUp = null;
    const dblCheck = (x, y, e) => {
      const now = performance.now();
      if (lastUp && now - lastUp.t < 420 && Math.hypot(x - lastUp.x, y - lastUp.y) < 6) { lastUp = null; if (this.handlers.dbl) this.handlers.dbl(x, y, e); }
      else lastUp = { t: now, x, y };
    };
    const up = (e) => {
      const [x, y] = pos(e);
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === 'tool') { if (this.handlers.up) this.handlers.up(x, y, e); if (d.moved <= 3) dblCheck(x, y, e); else lastUp = null; return; }
      if (d.moved <= 3) {
        if (d.btn === 2 && this.handlers.rclick) this.handlers.rclick(x, y, e);
        else if (d.click && this.handlers.click) { this.handlers.click(x, y, e); dblCheck(x, y, e); }
      } else lastUp = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', () => { drag = null; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(x, y, k);
      if (this.handlers.viewChanged) this.handlers.viewChanged();
    }, { passive: false });
    el.addEventListener('pointerleave', () => { if (this.handlers.leave) this.handlers.leave(); });
  }
  orbit(dx, dy) {
    const off = this.camera.position.clone().sub(this.target);
    const up = this.camera.up.clone();
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.008);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const qx = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008);
    const q = qz.multiply(qx);
    off.applyQuaternion(q); up.applyQuaternion(q);
    this.camera.position.copy(this.target).add(off);
    this.camera.up.copy(up);
    this.camera.lookAt(this.target);
    this.request();
  }
  pan(dx, dy) {
    const s = this.pxSize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const d = right.multiplyScalar(-dx * s).add(upv.multiplyScalar(dy * s));
    this.target.add(d); this.camera.position.add(d);
    this.request();
  }
  zoomAt(x, y, k) {
    const before = this.screenToViewPlane(x, y);
    this.camera.zoom = Math.min(400, Math.max(0.01, this.camera.zoom * k));
    this.camera.updateProjectionMatrix();
    const after = this.screenToViewPlane(x, y);
    const d = before.sub(after);
    this.target.add(d); this.camera.position.add(d);
    this.request();
  }
  screenToViewPlane(x, y) {
    const r = this.ray(x, y);
    const n = this.viewDir();
    const t = this.target.clone().sub(r.origin).dot(n) / r.direction.dot(n);
    return r.origin.clone().addScaledVector(r.direction, t);
  }
  // Animate camera to look along -dir (camera placed at target + dir) with up vector
  viewTo(dir, up, opts = {}) {
    const d = v3(dir).normalize(), u = v3(up).normalize();
    const m = new THREE.Matrix4().lookAt(d.clone().multiplyScalar(this.dist), new THREE.Vector3(0, 0, 0), u);
    const q1 = new THREE.Quaternion().setFromRotationMatrix(m);
    const target = opts.center ? v3(opts.center) : this.target.clone();
    this.anim = { t0: performance.now(), q0: this.camera.quaternion.clone(), q1, tg0: this.target.clone(), tg1: target, z0: this.camera.zoom, z1: opts.zoom || this.camera.zoom, dur: opts.instant ? 0 : 380 };
    if (opts.instant) this.stepAnim();
    this.request();
  }
  stepAnim() {
    const a = this.anim;
    let t = a.dur ? Math.min(1, (performance.now() - a.t0) / a.dur) : 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const q = a.q0.clone().slerp(a.q1, e);
    this.target.lerpVectors(a.tg0, a.tg1, e);
    this.camera.quaternion.copy(q);
    this.camera.position.copy(this.target).add(new THREE.Vector3(0, 0, this.dist).applyQuaternion(q));
    this.camera.up.set(0, 1, 0).applyQuaternion(q);
    this.camera.zoom = a.z0 * Math.pow(a.z1 / a.z0, e);
    this.camera.updateProjectionMatrix();
    if (t >= 1) this.anim = null;
    this.request();
    if (this.handlers.viewChanged) this.handlers.viewChanged();
  }
  fit(bb, opts = {}) {
    if (!bb) bb = { min: [-50, -50, -10], max: [50, 50, 10] };
    const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
    // project box corners onto camera axes to size
    const q = opts.q || (this.anim ? this.anim.q1 : this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), upv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]).sub(v3(c));
      w = Math.max(w, Math.abs(p.dot(right))); h = Math.max(h, Math.abs(p.dot(upv)));
    }
    const a = this.W / this.H;
    const need = Math.max(h, w / a, 5) * 1.35;
    const zoom = this.H0 / need;
    if (opts.instant) {
      this.target.copy(v3(c)); this.camera.position.copy(this.target).add(new THREE.Vector3(0, 0, this.dist).applyQuaternion(this.camera.quaternion));
      this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.request(); return;
    }
    this.anim = { t0: performance.now(), q0: this.camera.quaternion.clone(), q1: q.clone(), tg0: this.target.clone(), tg1: v3(c), z0: this.camera.zoom, z1: zoom, dur: 380 };
    this.request();
  }

  // ---------- origin, planes, grid ----------
  buildOrigin() {
    const g = this.gOrigin;
    const mk = (d, col) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), v3(d)]);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
      l.renderOrder = 5; g.add(l);
    };
    this.originLen = 12;
    mk([1, 0, 0], 0xd9443a); mk([0, 1, 0], 0x2f9e44); mk([0, 0, 1], 0x2b6cd4);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0x334155, depthTest: false }));
    dot.renderOrder = 6; g.add(dot);
  }
  scaleOrigin() {
    const s = this.pxSize() * 40;
    this.gOrigin.scale.setScalar(s);
  }
  setPlanes(list) {
    // list: [{key, plane, size, label, color, selected, hover}]
    for (const p of this.planeObjs) { this.gPlanes.remove(p.mesh); this.gPlanes.remove(p.line); p.mesh.geometry.dispose(); }
    this.planeObjs = [];
    for (const it of list) {
      const s = it.size / 2, pl = it.plane;
      const corners = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => v3(pl.o).addScaledVector(v3(pl.x), u + (it.cx || 0)).addScaledVector(v3(pl.y), v + (it.cy || 0)));
      const geo = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const col = it.selected ? 0xf28c28 : it.hover ? 0xf7b267 : (it.color ?? 0x7aa7d6);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: it.selected || it.hover ? 0.3 : 0.07, side: THREE.DoubleSide, depthWrite: false }));
      mesh.renderOrder = 2;
      const lg = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: it.selected || it.hover ? 0xd9730d : 0x5b84b1, transparent: true, opacity: 0.85 }));
      mesh.userData = { planeKey: it.key };
      this.gPlanes.add(mesh); this.gPlanes.add(line);
      this.planeObjs.push({ ...it, mesh, line, corner: [corners[3].x, corners[3].y, corners[3].z] });
    }
    this.request();
  }
  drawPlaneLabels(ctx) {
    ctx.font = '600 12px "Atkinson Hyperlegible", system-ui, sans-serif';
    for (const p of this.planeObjs) {
      if (!p.label) continue;
      const [x, y] = this.project(p.corner);
      ctx.fillStyle = p.selected || p.hover ? '#b45309' : '#3b5b80';
      ctx.fillText(p.label, x + 4, y + 14);
    }
  }
  setGrid(size, show) {
    this.gGrid.clear();
    if (!show) { this.request(); return; }
    const step = size > 400 ? 50 : size > 150 ? 10 : 5;
    const n = Math.ceil(size / step / 2) * 2;
    const half = n * step / 2;
    const pts = [], major = [];
    for (let i = 0; i <= n; i++) {
      const t = -half + i * step;
      const arr = Math.round(t / step) % 5 === 0 ? major : pts;
      arr.push(new THREE.Vector3(t, -half, 0), new THREE.Vector3(t, half, 0), new THREE.Vector3(-half, t, 0), new THREE.Vector3(half, t, 0));
    }
    const mk = (a, op) => { const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(a), new THREE.LineBasicMaterial({ color: 0x8a9bb0, transparent: true, opacity: op, depthWrite: false })); l.renderOrder = 1; this.gGrid.add(l); };
    mk(pts, 0.18); mk(major, 0.34);
    this.request();
  }

  // ---------- bodies ----------
  setBodies(list, opts = {}) {
    // list: [{body, mesh: {pos, idx}, color, opacity, hidden}]
    for (const b of this.bodies) { this.gBodies.remove(b.obj); b.geo.dispose(); b.edgeGeo.dispose(); }
    this.bodies = [];
    for (const it of list) {
      const geo0 = new THREE.BufferGeometry();
      geo0.setAttribute('position', new THREE.BufferAttribute(it.mesh.pos, 3));
      geo0.setIndex(new THREE.BufferAttribute(it.mesh.idx, 1));
      const geo = toCreasedNormals(geo0, Math.PI / 7);
      const mat = new THREE.MeshStandardMaterial({ color: it.color, roughness: 0.62, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: (it.opacity ?? 1) < 1, opacity: it.opacity ?? 1, depthWrite: (it.opacity ?? 1) >= 1 });
      const mesh = new THREE.Mesh(geo, mat);
      const edgeGeo = new THREE.EdgesGeometry(geo0, 24);
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x24303c, transparent: (it.opacity ?? 1) < 1, opacity: Math.min(1, (it.opacity ?? 1) + 0.2) }));
      const obj = new THREE.Group(); obj.add(mesh); obj.add(edges);
      obj.visible = !it.hidden;
      mesh.userData = { bodyIdx: this.bodies.length };
      this.gBodies.add(obj);
      geo0.dispose();
      this.bodies.push({ ...it, obj, mesh3: mesh, geo, edgeGeo, groups: faceGroups(it.mesh.pos, it.mesh.idx) });
    }
    this.request();
  }
  setPreview(meshes) {
    this.gPreview.clear();
    for (const m of meshes || []) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 3;
      const eg = new THREE.EdgesGeometry(geo, 24);
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: m.color, transparent: true, opacity: 0.9, depthTest: false }));
      edges.renderOrder = 4;
      this.gPreview.add(mesh); this.gPreview.add(edges);
    }
    this.request();
  }

  // pick a body face. returns {bodyIdx, tri, group, point, normal}
  pickFace(x, y, opts = {}) {
    const r = this.ray(x, y);
    this.raycaster.ray.copy(r);
    const meshes = this.bodies.filter(b => b.obj.visible && (opts.ghost || !b.ghost)).map(b => b.mesh3);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    const bi = h.object.userData.bodyIdx, B = this.bodies[bi];
    const tri = h.faceIndex;
    const g = B.groups.triGroup[tri];
    const grp = B.groups.list[g];
    return { bodyIdx: bi, tri, group: g, point: [h.point.x, h.point.y, h.point.z], normal: grp.n, planar: grp.tris.length > 0, grp };
  }
  pickPlane(x, y) {
    const r = this.ray(x, y);
    this.raycaster.ray.copy(r);
    const hits = this.raycaster.intersectObjects(this.planeObjs.map(p => p.mesh), false);
    return hits.length ? hits[0].object.userData.planeKey : null;
  }
  highlightGroup(bi, g, color = 0xf28c28, keep = false) {
    if (!keep) this.gHi.clear();
    if (bi == null || !this.bodies[bi]) { this.request(); return; }
    const B = this.bodies[bi], grp = B.groups.list[g];
    const idx = [];
    for (const t of grp.tris) idx.push(B.mesh.idx[t * 3], B.mesh.idx[t * 3 + 1], B.mesh.idx[t * 3 + 2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(B.mesh.pos, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.renderOrder = 3;
    this.gHi.add(m);
    this.request();
  }
  clearHighlight() { if (this.gHi.children.length) { this.gHi.clear(); this.request(); } }

  // ---------- view cube ----------
  buildCube() {
    this.cubeScene = new THREE.Scene();
    this.cubeCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
    // label orientation per face: canvas transform so text reads upright in the standard views (z-up)
    const faces = [['Right', [0, -1, 1, 0]], ['Left', [0, 1, -1, 0]], ['Back', [-1, 0, 0, -1]], ['Front', [1, 0, 0, 1]], ['Top', [1, 0, 0, 1]], ['Bottom', [-1, 0, 0, -1]]];
    const mats = faces.map(([name, T]) => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#f4f6f9'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#9fb0c4'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
      g.setTransform(T[0], T[1], T[2], T[3], 64, 64);
      g.fillStyle = '#2d3e50'; g.font = 'bold 27px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name.toUpperCase(), 0, 2);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: t });
    });
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
    this.cubeScene.add(box);
    this.cubeBox = box;
    const ax = (d, col) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.25, -1.25, -1.25), new THREE.Vector3(-1.25, -1.25, -1.25).add(v3(d).multiplyScalar(1.4))]), new THREE.LineBasicMaterial({ color: col })); this.cubeScene.add(l); };
    ax([1, 0, 0], 0xd9443a); ax([0, 1, 0], 0x2f9e44); ax([0, 0, 1], 0x2b6cd4);
  }
  cubePick(x, y) {
    const s = 96;
    const lx = x - 4, ly = y - 8;
    if (lx < 0 || ly < 0 || lx > s || ly > s) return null;
    const ndc = new THREE.Vector2(lx / s * 2 - 1, -(ly / s) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.cubeCam);
    const h = rc.intersectObject(this.cubeBox)[0];
    if (!h) return null;
    // snap to face, edge or corner by local point
    const p = h.point;
    const snap = (v) => Math.abs(v) > 0.55 ? Math.sign(v) : 0;
    let d = [snap(p.x), snap(p.y), snap(p.z)];
    if (!d[0] && !d[1] && !d[2]) d = [Math.round(h.face.normal.x), Math.round(h.face.normal.y), Math.round(h.face.normal.z)];
    let up = [0, 0, 1];
    if (!d[0] && !d[1]) up = [0, d[2] > 0 ? 1 : -1, 0];
    if (d[2] > 0 && !d[0] && !d[1]) up = [0, 1, 0];
    if (d[2] < 0 && !d[0] && !d[1]) up = [0, -1, 0];
    return { dir: d, up };
  }
}

// Group triangles into flat faces (connected + coplanar).
export function faceGroups(pos, idx) {
  const nt = idx.length / 3;
  const tn = new Float32Array(nt * 3), td = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
    td[t] = nx * pos[a] + ny * pos[a + 1] + nz * pos[a + 2];
  }
  const emap = new Map();
  const key = (i, j) => i < j ? i * 4194304 + j : j * 4194304 + i;
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const i = idx[t * 3 + k], j = idx[t * 3 + (k + 1) % 3];
    const kk = key(i, j);
    const arr = emap.get(kk); if (arr) arr.push(t); else emap.set(kk, [t]);
  }
  const triGroup = new Int32Array(nt).fill(-1);
  const list = [];
  for (let t = 0; t < nt; t++) {
    if (triGroup[t] >= 0) continue;
    const g = list.length;
    const n = [tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]], d = td[t];
    const tris = [t]; triGroup[t] = g;
    for (let q = 0; q < tris.length; q++) {
      const u = tris[q];
      for (let k = 0; k < 3; k++) {
        const i = idx[u * 3 + k], j = idx[u * 3 + (k + 1) % 3];
        for (const w of emap.get(key(i, j)) || []) {
          if (triGroup[w] >= 0) continue;
          if (tn[w * 3] * n[0] + tn[w * 3 + 1] * n[1] + tn[w * 3 + 2] * n[2] < 0.99995) continue;
          if (Math.abs(td[w] - d) > 1e-3) continue;
          triGroup[w] = g; tris.push(w);
        }
      }
    }
    let area = 0;
    for (const u of tris) {
      const a = idx[u * 3] * 3, b = idx[u * 3 + 1] * 3, c = idx[u * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    list.push({ n, d, tris, area });
  }
  return { triGroup, list, emap };
}

// Boundary loops of a face group (3D points), for outlines and exports
export function groupLoops(pos, idx, grp) {
  const inG = new Set(grp.tris);
  const cnt = new Map();
  const dirE = [];
  for (const t of grp.tris) for (let k = 0; k < 3; k++) {
    const i = idx[t * 3 + k], j = idx[t * 3 + (k + 1) % 3];
    const kk = i < j ? i + '_' + j : j + '_' + i;
    cnt.set(kk, (cnt.get(kk) || 0) + 1);
    dirE.push([i, j, kk]);
  }
  const next = new Map();
  for (const [i, j, kk] of dirE) if (cnt.get(kk) === 1) next.set(i, j);
  const loops = [], used = new Set();
  for (const [s] of next) {
    if (used.has(s)) continue;
    const loop = []; let v = s, g = 0;
    while (!used.has(v) && g++ < 100000) { used.add(v); loop.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]); v = next.get(v); if (v === undefined) break; }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}
