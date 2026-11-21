// Part document + regeneration (feature history -> solid bodies via Manifold).
import { evalVariables, evaluate } from './expr.js';
import { solveSketch, dofStatus, getPt } from './solver.js';
import { computeRegions, pickRegions, segCount } from './regions.js';

// ---------- vectors ----------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const STD_PLANES = {
  Top: { o: [0, 0, 0], n: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
  Front: { o: [0, 0, 0], n: [0, -1, 0], x: [1, 0, 0], y: [0, 0, 1] },
  Right: { o: [0, 0, 0], n: [1, 0, 0], x: [0, 1, 0], y: [0, 0, 1] },
};

// Plane through point p with normal n; origin is the world origin projected onto it.
export function planeFrom(p, n) {
  n = norm(n);
  const o = mul(n, dot(p, n));
  let x, y;
  if (Math.abs(n[2]) > 0.9999) { x = [1, 0, 0]; y = cross(n, x); }
  else {
    const up = [0, 0, 1];
    y = norm(sub(up, mul(n, dot(up, n))));
    x = norm(cross(y, n));
  }
  return { o, n, x, y };
}
export const toWorld = (pl, u, v) => [pl.o[0] + u * pl.x[0] + v * pl.y[0], pl.o[1] + u * pl.x[1] + v * pl.y[1], pl.o[2] + u * pl.x[2] + v * pl.y[2]];
export const toWorldVec = (pl, u, v) => [u * pl.x[0] + v * pl.y[0], u * pl.x[1] + v * pl.y[1], u * pl.x[2] + v * pl.y[2]];
export const toLocal = (pl, p) => { const d = sub(p, pl.o); return [dot(d, pl.x), dot(d, pl.y)]; };
export const frameMat = (x, y, z, o) => [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
export function matMul(A, B) { // column-major 4x4
  const C = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k]; C[c * 4 + r] = s; }
  return C;
}
export const matPt = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
export const matVec = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2], M[1] * p[0] + M[5] * p[1] + M[9] * p[2], M[2] * p[0] + M[6] * p[1] + M[10] * p[2]];
export function rotMat(axisPt, axisDir, deg) {
  const [x, y, z] = norm(axisDir), t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R = [c + x * x * C, y * x * C + z * s, z * x * C - y * s, 0, x * y * C - z * s, c + y * y * C, z * y * C + x * s, 0, x * z * C + y * s, y * z * C - x * s, c + z * z * C, 0, 0, 0, 0, 1];
  const p = axisPt, Rp = matVec(R, p);
  R[12] = p[0] - Rp[0]; R[13] = p[1] - Rp[1]; R[14] = p[2] - Rp[2];
  return R;
}
export function mirrorMat(pl) {
  const [a, b, c] = pl.n, d = dot(pl.n, pl.o);
  return [1 - 2 * a * a, -2 * a * b, -2 * a * c, 0, -2 * a * b, 1 - 2 * b * b, -2 * b * c, 0, -2 * a * c, -2 * b * c, 1 - 2 * c * c, 0, 2 * a * d, 2 * b * d, 2 * c * d, 1];
}

// ---------- document ----------
export const TYPE_NAMES = { sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', plane: 'Plane', lpattern: 'Linear pattern', cpattern: 'Circular pattern', mirror: 'Mirror' };
export function newDoc(name = 'My part') {
  return { app: 'geocad3d', version: 1, name, vars: [], features: [], rollback: null, nid: 1, material: 'PLA' };
}
export function newId(doc, prefix = 'f') { return prefix + (doc.nid++); }
export function nextName(doc, type) {
  const base = TYPE_NAMES[type] || type;
  let k = 1;
  const names = new Set(doc.features.map(f => f.name));
  while (names.has(base + ' ' + k)) k++;
  return base + ' ' + k;
}
export function newSketch(doc, plane) {
  return { id: newId(doc), t: 'sketch', name: nextName(doc, 'sketch'), plane, pts: {}, ents: [], cons: [], nid: 1 };
}

// Features that a feature depends on
export function depsOf(f) {
  const d = new Set();
  const ref = (r) => { if (r && (r.k === 'face' || r.k === 'plane')) d.add(r.f); };
  if (f.t === 'sketch') ref(f.plane);
  if (f.t === 'plane') ref(f.ref);
  if (f.t === 'extrude' || f.t === 'revolve') d.add(f.sketch);
  if (f.t === 'lpattern' || f.t === 'cpattern' || f.t === 'mirror') (f.feats || []).forEach(x => d.add(x));
  for (const r of [f.dir, f.dir2, f.axis]) if (r && r.s) d.add(r.s);
  if (f.t === 'mirror') ref(f.plane);
  return d;
}
export function dependents(doc, id) {
  const out = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of doc.features) if (!out.has(f.id)) for (const d of depsOf(f)) if (out.has(d)) { out.add(f.id); changed = true; break; }
  }
  out.delete(id);
  return [...out];
}

// ---------- regeneration ----------
const SOLIDS = new Set(['extrude', 'revolve', 'lpattern', 'cpattern', 'mirror']);
export const PALETTE = ['#c9d6e3', '#f2c48d', '#a8d5ba', '#e9a6a6', '#c3b1e1', '#f3e08a', '#9ccfd8', '#e6b8d0'];

export function regen(doc, M, opts = {}) {
  const res = { bodies: [], faces: [], planes: {}, sketches: {}, errors: {}, warn: {}, tools: {}, featFaces: {}, handles: {}, alloc: [], values: {}, varErrors: {} };
  const track = (m) => { res.alloc.push(m); return m; };
  const V = evalVariables(doc.vars);
  res.values = V.values; res.varErrors = V.errors;
  const values = V.values;
  const num = (src, what, f) => {
    try { return evaluate(src, values); } catch (e) { throw new Error(what + ': ' + e.message); }
  };
  const feats = doc.features;
  const end = opts.upTo ?? (doc.rollback == null ? feats.length : doc.rollback);
  let bodyCount = 0;

  const resolvePlane = (ref) => {
    if (!ref) throw new Error('No plane picked');
    if (ref.k === 'std') return STD_PLANES[ref.name];
    if (ref.k === 'plane') { const p = res.planes[ref.f]; if (!p) throw new Error('The plane it uses is missing'); return p; }
    if (ref.k === 'face') {
      const fc = res.faces.filter(x => x.f === ref.f && x.role === ref.role).pop();
      if (!fc) throw new Error('The face it was drawn on is gone');
      return planeFrom(fc.o, fc.n);
    }
    if (ref.k === 'fixed') return ref.plane;
    throw new Error('Unknown plane');
  };
  res.resolvePlane = resolvePlane;
  const regFace = (f, role, o, n, order) => { const e = { f, role, o, n: norm(n), order }; res.faces.push(e); (res.featFaces[f] ||= []).push(e); };

  const bbAll = () => {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of res.bodies) { const bb = b.man.boundingBox(); for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], bb.min[i]); mx[i] = Math.max(mx[i], bb.max[i]); } }
    return isFinite(mn[0]) ? { min: mn, max: mx } : null;
  };
  const bbOverlap = (a, b, e = 1e-4) => a.min[0] <= b.max[0] + e && b.min[0] <= a.max[0] + e && a.min[1] <= b.max[1] + e && b.min[1] <= a.max[1] + e && a.min[2] <= b.max[2] + e && b.min[2] <= a.max[2] + e;

  const applyOp = (tool, op, fid) => {
    const tb = tool.boundingBox();
    if (tool.isEmpty()) throw new Error('This makes no solid');
    if (op === 'new') { res.bodies.push({ id: 'B' + fid + '_' + res.bodies.length, man: tool, feat: fid, idx: bodyCount++ }); return; }
    if (op === 'add') {
      const hits = res.bodies.filter(b => bbOverlap(b.man.boundingBox(), tb));
      const merged = [];
      let cur = tool;
      for (const b of hits) {
        const u = track(cur.add(b.man));
        const parts = u.decompose(); const nu = parts.length; parts.forEach(p => p.delete());
        const pa = cur.decompose(), pb = b.man.decompose(); const ns = pa.length + pb.length; pa.forEach(p => p.delete()); pb.forEach(p => p.delete());
        if (nu < ns) { cur = u; merged.push(b); }
      }
      if (!merged.length) { res.bodies.push({ id: 'B' + fid + '_' + res.bodies.length, man: tool, feat: fid, idx: bodyCount++ }); return; }
      const keep = merged[0];
      keep.man = cur;
      res.bodies = res.bodies.filter(b => b === keep || !merged.includes(b));
      return;
    }
    let touched = 0;
    for (const b of res.bodies) {
      if (!bbOverlap(b.man.boundingBox(), tb)) continue;
      const before = b.man.volume();
      b.man = track(op === 'remove' ? b.man.subtract(tool) : b.man.intersect(tool));
      if (Math.abs(b.man.volume() - before) > 1e-6) touched++;
    }
    res.bodies = res.bodies.filter(b => !b.man.isEmpty());
    if (!touched) res.warn[fid] = op === 'remove' ? 'Remove did not cut into any part. Try Flip or Through all.' : 'Intersect did not overlap any part.';
  };

  const regionCS = (list) => {
    const pieces = list.map(r => track(new M.CrossSection([r.outer, ...r.holes], 'EvenOdd')));
    return pieces.length === 1 ? pieces[0] : track(M.CrossSection.union(pieces));
  };
  const sideFaces = (list, cb) => {
    const seen = {};
    for (const r of list) {
      const loops = [[r.outer, r.outerEnts], ...r.holes.map((h, i) => [h, r.holeEnts[i]])];
      for (const [pts, ents] of loops) for (let i = 0; i < pts.length; i++) {
        const eid = ents[i];
        const p = pts[i], q = pts[(i + 1) % pts.length];
        const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
        if (l < 1e-9) continue;
        const nx = dy / l, ny = -dx / l;
        const k = eid;
        if (seen[k] && (seen[k].nx * nx + seen[k].ny * ny) < -0.99) { seen[k].internal = true; continue; }
        if (!seen[k]) seen[k] = { nx, ny, p, q, eid, dx: dx / l, dy: dy / l };
      }
    }
    for (const k in seen) if (!seen[k].internal) cb(seen[k]);
  };

  const sketchFor = (id, fname) => {
    const s = res.sketches[id];
    if (!s) throw new Error('Pick a sketch');
    if (!s.ok) throw new Error('Its sketch has a problem');
    return s;
  };

  const getAxis = (ref, what) => {
    // returns {p: point, d: dir} in world
    if (!ref) throw new Error('Pick ' + what);
    if (ref.k === 'axis') { const d = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[ref.a]; return { p: [0, 0, 0], d }; }
    const s = res.sketches[ref.s];
    if (!s || !s.ok) throw new Error('The sketch for ' + what + ' is missing');
    const sk = feats.find(f => f.id === ref.s);
    if (ref.k === 'line') {
      const e = sk.ents.find(x => x.id === ref.e) || (ref.e === 'XAX' ? { a: 'O', b: 'XE' } : ref.e === 'YAX' ? { a: 'O', b: 'YE' } : null);
      if (!e) throw new Error('The line for ' + what + ' is gone');
      const a = getPt(sk, e.a), b = getPt(sk, e.b);
      const pa = toWorld(s.plane, a.x, a.y), pb = toWorld(s.plane, b.x, b.y);
      return { p: pa, d: norm(sub(pb, pa)) };
    }
    if (ref.k === 'point') {
      const a = getPt(sk, ref.p);
      if (!a) throw new Error('The point for ' + what + ' is gone');
      return { p: toWorld(s.plane, a.x, a.y), d: s.plane.n };
    }
    throw new Error('Pick ' + what);
  };
  res.getAxis = getAxis;

  for (let i = 0; i < end; i++) {
    const f = (opts.override && opts.override.id === feats[i].id) ? opts.override : feats[i];
    if (f.suppressed) continue;
    try {
      if (f.t === 'sketch') {
        const plane = resolvePlane(f.plane);
        const out = { plane, ok: true, regions: [], openPts: [] };
        res.sketches[f.id] = out;
        if (!opts.noSolve || !opts.noSolve.has(f.id)) {
          const r = solveSketch(f, values);
          if (!r.ok) {
            out.ok = false;
            if (r.reason === 'dim') { const k = Object.keys(r.errors)[0]; out.dimErrors = r.errors; throw new Error('A dimension has a problem: ' + r.errors[k]); }
            throw new Error('The sketch can\'t be solved with these sizes (constraints fight each other)');
          }
        }
        const rg = computeRegions(f);
        out.regions = rg.regions; out.openPts = rg.openPts;
        try { out.dof = dofStatus(f, values); } catch (e) { out.dof = null; }
      } else if (f.t === 'plane') {
        const base = resolvePlane(f.ref);
        const d = num(f.off || '0', 'Offset') * (f.flip ? -1 : 1);
        res.planes[f.id] = { o: add(base.o, mul(base.n, d)), n: base.n, x: base.x, y: base.y };
        res.handles[f.id] = [{ k: 'lin', key: 'off', mode: 'plane', o: base.o, d: base.n, v: d }];
      } else if (f.t === 'extrude') {
        const s = sketchFor(f.sketch);
        const picked = pickRegions(s.regions, f.regions);
        if (picked.missing) res.warn[f.id] = 'Some picked areas are gone; check the selection.';
        if (!picked.list.length) throw new Error('No closed area to extrude. Close the shape in the sketch.');
        const cs = regionCS(picked.list);
        let d, z0;
        const flip = f.flip ? -1 : 1;
        if (f.end === 'through') {
          const bb = bbAll();
          if (!bb) throw new Error('Through all needs a part to go through');
          const diag = len(sub(bb.max, bb.min));
          const c = mul(add(bb.min, bb.max), 0.5);
          const D = diag + Math.abs(dot(sub(c, s.plane.o), s.plane.n)) + 10;
          d = 2 * D; z0 = -D;   // through all goes both ways
        } else {
          d = num(f.depth, 'Depth');
          if (!(d > 0)) throw new Error('Depth must be more than 0');
          z0 = f.end === 'sym' ? -d / 2 : (flip > 0 ? 0 : -d);
        }
        const pl = s.plane;
        let tool = track(cs.extrude(d));
        if (z0) tool = track(tool.translate([0, 0, z0]));
        tool = track(tool.transform(frameMat(pl.x, pl.y, pl.n, pl.o)));
        const sgn = f.op === 'remove' ? -1 : 1;
        const zl = z0, zh = z0 + d;
        const lowRole = (f.end === 'sym' || flip > 0) ? 'start' : 'end';
        const highRole = lowRole === 'start' ? 'end' : 'start';
        if (f.end !== 'through') {
          regFace(f.id, lowRole, add(pl.o, mul(pl.n, zl)), mul(pl.n, -sgn), i);
          regFace(f.id, highRole, add(pl.o, mul(pl.n, zh)), mul(pl.n, sgn), i);
        }
        sideFaces(picked.list, (sf) => {
          const ent = feats.find(x => x.id === f.sketch).ents.find(e => e.id === sf.eid);
          if (!ent || ent.t !== 'line') return;
          regFace(f.id, 'side:' + sf.eid, toWorld(pl, sf.p[0], sf.p[1]), mul(toWorldVec(pl, sf.nx, sf.ny), sgn), i);
        });
        res.tools[f.id] = [{ tool, op: f.op }];
        if (f.end !== 'through') {
          let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
          for (const r of picked.list) for (const q of r.outer) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }
          const C0 = toWorld(pl, (u0 + u1) / 2, (v0 + v1) / 2);
          res.handles[f.id] = [f.end === 'sym' ? { k: 'lin', key: 'depth', mode: 'sym', o: C0, d: pl.n, v: d / 2 } : { k: 'lin', key: 'depth', mode: 'blind', o: C0, d: pl.n, v: flip * d }];
        }
        applyOp(tool, f.op, f.id);
      } else if (f.t === 'revolve') {
        const s = sketchFor(f.sketch);
        const sk = feats.find(x => x.id === f.sketch);
        const picked = pickRegions(s.regions, f.regions);
        if (!picked.list.length) throw new Error('No closed area to revolve. Close the shape in the sketch.');
        if (!f.axis || !f.axis.e) throw new Error('Pick a line to spin around (the axis)');
        const ae = f.axis.e === 'XAX' ? { a: 'O', b: 'XE' } : f.axis.e === 'YAX' ? { a: 'O', b: 'YE' } : sk.ents.find(e => e.id === f.axis.e);
        if (!ae || (ae.t && ae.t !== 'line')) throw new Error('The axis must be a straight line');
        const A = getPt(sk, ae.a), B = getPt(sk, ae.b);
        let dx = B.x - A.x, dy = B.y - A.y; const dl = Math.hypot(dx, dy); dx /= dl; dy /= dl;
        const xf = (p, sx) => [sx * (dy * (p[0] - A.x) - dx * (p[1] - A.y)), sx * (dx * (p[0] - A.x) + dy * (p[1] - A.y))];
        let lo = Infinity, hi = -Infinity, rmax = 0;
        for (const r of picked.list) for (const p of r.outer) { const q = xf(p, 1); lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); }
        const tol = 1e-6 * Math.max(1, hi - lo);
        if (lo < -tol && hi > tol) throw new Error('The shape crosses the axis. Keep the whole shape on one side of the line.');
        const sx = hi > tol ? 1 : -1;  // mirror so profile is on +x
        if (sx < 0) { dx = -dx; dy = -dy; }
        const T = (p) => [dy * (p[0] - A.x) - dx * (p[1] - A.y), dx * (p[0] - A.x) + dy * (p[1] - A.y)];
        const polys = [];
        for (const r of picked.list) { polys.push(r.outer.map(T)); r.holes.forEach(h => polys.push(h.map(T))); }
        for (const P of polys) for (const p of P) rmax = Math.max(rmax, p[0]);
        const full = f.full !== false;
        const ang = full ? 360 : num(f.angle, 'Angle');
        if (!(ang > 0 && ang <= 360)) throw new Error('Angle must be between 0 and 360');
        const segs = Math.min(160, Math.max(48, segCount(rmax, Math.PI * 2)));
        const cs = track(new M.CrossSection(polys, 'EvenOdd'));
        let tool = track(cs.revolve(segs, ang));
        let a0 = 0;
        if (!full && f.sym) a0 = -ang / 2;
        else if (!full && f.flip) a0 = -ang;
        if (a0) tool = track(tool.rotate([0, 0, a0]));
        const pl = s.plane;
        const ex = toWorldVec(pl, dy, -dx), ez = toWorldVec(pl, dx, dy), ey = cross(ez, ex);
        const org = toWorld(pl, A.x, A.y);
        tool = track(tool.transform(frameMat(ex, ey, ez, org)));
        if (!full) {
          let z0 = Infinity, z1 = -Infinity;
          for (const P of polys) for (const q of P) { z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
          const mode = f.sym ? 'sym' : f.flip ? 'flip' : 'norm';
          res.handles[f.id] = [{ k: 'ang', key: 'angle', mode, org, ex, ey, ez, R: rmax * 1.15 + 3, z: (z0 + z1) / 2, a0, ang, th: mode === 'sym' ? ang / 2 : mode === 'flip' ? -ang : ang }];
        }
        const sgn = f.op === 'remove' ? -1 : 1;
        if (!full) {
          const rot = (v, deg) => matVec(rotMat([0, 0, 0], ez, deg), v);
          regFace(f.id, 'start', org, mul(rot(ey, a0), -sgn), i);
          regFace(f.id, 'end', org, mul(rot(ey, a0 + ang), sgn), i);
        }
        sideFaces(picked.list, (sf) => {
          const ent = sk.ents.find(e => e.id === sf.eid);
          if (!ent || ent.t !== 'line') return;
          const p = T(sf.p), q = T(sf.q);
          if (Math.abs(q[1] - p[1]) > 1e-6 * Math.max(1, Math.abs(q[0] - p[0]))) return;
          // outward normal in transformed coords: (dy,-dx) of travel direction
          const ny = -(q[0] - p[0]);
          if (Math.abs(ny) < 1e-12) return;
          regFace(f.id, 'cap:' + sf.eid, add(org, mul(ez, p[1])), mul(ez, Math.sign(ny) * sgn), i);
        });
        res.tools[f.id] = [{ tool, op: f.op }];
        applyOp(tool, f.op, f.id);
      } else if (f.t === 'lpattern' || f.t === 'cpattern' || f.t === 'mirror') {
        if (!f.feats || !f.feats.length) throw new Error('Pick the features to copy');
        const mats = [];
        let lph = null;
        if (f.t === 'lpattern') {
          const n1 = Math.round(num(f.count, 'Count')), s1 = num(f.spacing, 'Spacing');
          if (!(n1 >= 1 && n1 <= 200)) throw new Error('Count must be 1 to 200');
          const a1 = getAxis(f.dir, 'a direction');
          const d1 = mul(a1.d, f.flip ? -1 : 1);
          let n2 = 1, s2 = 0, d2 = [0, 0, 0];
          if (f.dir2) {
            n2 = Math.round(num(f.count2 || '1', 'Count 2')); s2 = num(f.spacing2 || '0', 'Spacing 2');
            if (!(n2 >= 1 && n2 <= 200)) throw new Error('Count 2 must be 1 to 200');
            d2 = mul(getAxis(f.dir2, 'a second direction').d, f.flip2 ? -1 : 1);
          }
          if (n1 * n2 > 400) throw new Error('That is too many copies (keep it under 400)');
          lph = [{ key: 'spacing', d: d1, v: s1, n: n1 }];
          if (f.dir2) lph.push({ key: 'spacing2', d: d2, v: s2, n: n2 });
          for (let a = 0; a < n1; a++) for (let b = 0; b < n2; b++) {
            if (!a && !b) continue;
            const t = add(mul(d1, a * s1), mul(d2, b * s2));
            mats.push([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]);
          }
        } else if (f.t === 'cpattern') {
          const n = Math.round(num(f.count, 'Count')), tot = num(f.angle || '360', 'Angle');
          if (!(n >= 1 && n <= 200)) throw new Error('Count must be 1 to 200');
          const ax = getAxis(f.axis, 'an axis');
          const full = Math.abs(Math.abs(tot) - 360) < 1e-9;
          const step = (full ? tot / n : tot / Math.max(1, n - 1)) * (f.flip ? -1 : 1);
          for (let k = 1; k < n; k++) mats.push(rotMat(ax.p, ax.d, step * k));
        } else {
          const pl = resolvePlane(f.plane);
          mats.push(mirrorMat(pl));
        }
        const entries = [];
        for (const fid of f.feats) {
          const src = res.tools[fid];
          if (!src) { if (res.errors[fid]) throw new Error('A copied feature has a problem'); continue; }
          src.forEach(s => entries.push({ ...s, fid }));
        }
        if (!entries.length) throw new Error('Those features make no solid to copy');
        if (lph) {
          const tb = entries[0].tool.boundingBox();
          const c = mul(add(tb.min, tb.max), 0.5);
          res.handles[f.id] = lph.filter(h => h.n >= 2).map(h => ({ k: 'lin', key: h.key, mode: 'spacing', o: c, d: h.d, v: h.v }));
        }
        const out = [];
        mats.forEach((Mx, k) => {
          for (const e of entries) {
            const t = track(e.tool.transform(Mx));
            const op = e.op === 'new' ? 'add' : e.op;
            out.push({ tool: t, op });
            applyOp(t, op, f.id);
            for (const fc of (res.featFaces[e.fid] || [])) {
              if (fc.role.startsWith('copy')) continue;
              regFace(f.id, (k + 1) + ':' + e.fid + ':' + fc.role, matPt(Mx, fc.o), matVec(Mx, fc.n), i);
            }
          }
        });
        res.tools[f.id] = out;
      }
    } catch (e) {
      res.errors[f.id] = e.message || String(e);
      if (f.t === 'sketch' && res.sketches[f.id]) res.sketches[f.id].ok = false;
    }
  }
  return res;
}

export function freeResult(res) {
  if (!res) return;
  for (const m of res.alloc) { try { m.delete(); } catch (e) { /* already freed */ } }
  res.alloc = [];
}

// Find the registered planar face for a hit point + normal
export function matchFace(res, p, n, maxOrder = Infinity) {
  let best = null;
  for (const fc of res.faces) {
    if (fc.order > maxOrder) continue;
    if (dot(fc.n, n) < 0.9999) continue;
    if (Math.abs(dot(sub(p, fc.o), fc.n)) > 1e-3) continue;
    if (!best || fc.order >= best.order) best = fc;
  }
  return best;
}
