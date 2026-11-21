// Sketch regions: planar arrangement of the sketch curves -> closed areas (faces) you can extrude.
import { getPt } from './solver.js';

export function arcAngles(sk, e) {
  const c = getPt(sk, e.c), a = getPt(sk, e.a), b = getPt(sk, e.b);
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let a1 = Math.atan2(b.y - c.y, b.x - c.x);
  let sw = a1 - a0;
  while (sw <= 1e-9) sw += Math.PI * 2;
  while (sw > Math.PI * 2 + 1e-9) sw -= Math.PI * 2;
  return { cx: c.x, cy: c.y, r: Math.hypot(a.x - c.x, a.y - c.y), a0, sw };
}

export function segCount(r, sweep, fine = 1) {
  const tol = 0.01 / fine;
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
  const full = Math.min(256, Math.max(36, Math.ceil(2 * Math.PI / step)));
  return Math.max(2, Math.ceil(full * sweep / (2 * Math.PI)));
}

// Polyline for an entity in sketch coordinates (exact endpoints).
export function entPolyline(sk, e, fine = 1) {
  if (e.t === 'line') { const a = getPt(sk, e.a), b = getPt(sk, e.b); return [[a.x, a.y], [b.x, b.y]]; }
  if (e.t === 'circle') {
    const c = getPt(sk, e.c), n = segCount(e.r, Math.PI * 2, fine), out = [];
    for (let i = 0; i <= n; i++) { const t = (i % n) / n * Math.PI * 2; out.push([c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)]); }
    return out;
  }
  if (e.t === 'arc') {
    const { cx, cy, r, a0, sw } = arcAngles(sk, e);
    const n = segCount(r, sw, fine), out = [];
    const a = getPt(sk, e.a), b = getPt(sk, e.b);
    out.push([a.x, a.y]);
    for (let i = 1; i < n; i++) { const t = a0 + sw * i / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    out.push([b.x, b.y]);
    return out;
  }
  return [];
}

function segInt(p, p2, q, q2) {
  const rx = p2[0] - p[0], ry = p2[1] - p[1], sx = q2[0] - q[0], sy = q2[1] - q[1];
  const den = rx * sy - ry * sx;
  const qpx = q[0] - p[0], qpy = q[1] - p[1];
  const rr = rx * rx + ry * ry, ss = sx * sx + sy * sy;
  const out = [];
  if (Math.abs(den) < 1e-12 * Math.sqrt(rr * ss)) {
    // parallel: collinear overlap?
    if (Math.abs(qpx * ry - qpy * rx) > 1e-9 * Math.sqrt(rr)) return out;
    const t0 = (qpx * rx + qpy * ry) / rr, t1 = ((q2[0] - p[0]) * rx + (q2[1] - p[1]) * ry) / rr;
    const u0 = (-qpx * sx - qpy * sy) / ss, u1 = ((p2[0] - q[0]) * sx + (p2[1] - q[1]) * sy) / ss;
    if (t0 > 0 && t0 < 1) out.push([t0, 0]);
    if (t1 > 0 && t1 < 1) out.push([t1, 1]);
    if (u0 > 0 && u0 < 1) out.push([0, u0]);
    if (u1 > 0 && u1 < 1) out.push([1, u1]);
    return out;
  }
  const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
  const e = 1e-9;
  if (t >= -e && t <= 1 + e && u >= -e && u <= 1 + e) out.push([Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))]);
  return out;
}

export function polyArea(P) {
  let a = 0;
  for (let i = 0, n = P.length; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export function pointInPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const xi = P[i][0], yi = P[i][1], xj = P[j][0], yj = P[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function samplePoint(outer, holes) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of outer) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const loops = [outer, ...holes];
  let best = null, bw = -1;
  for (const f of [0.5, 0.31, 0.69, 0.17, 0.83, 0.43, 0.57]) {
    const y = minY + (maxY - minY) * f;
    const xs = [];
    for (const L of loops) for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bw) { bw = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  return best || outer[0];
}

// Main: compute regions of a sketch. Returns {regions:[...], openPts:[[x,y]...]}
export function computeRegions(sk) {
  const segs = [];
  for (const e of sk.ents) {
    if (e.cons) continue;
    const pl = entPolyline(sk, e);
    for (let i = 0; i + 1 < pl.length; i++) segs.push({ a: pl[i], b: pl[i + 1], ent: e.id });
  }
  let openPts = [];
  if (!segs.length) return { regions: [], openPts };

  // scale for tolerances
  let ext = 1;
  for (const s of segs) ext = Math.max(ext, Math.abs(s.a[0]), Math.abs(s.a[1]), Math.abs(s.b[0]), Math.abs(s.b[1]));
  const eps = ext * 1e-9;

  // intersections
  const splits = segs.map(() => [0, 1]);
  const bb = segs.map(s => [Math.min(s.a[0], s.b[0]) - eps, Math.max(s.a[0], s.b[0]) + eps, Math.min(s.a[1], s.b[1]) - eps, Math.max(s.a[1], s.b[1]) + eps]);
  const order = segs.map((_, i) => i).sort((i, j) => bb[i][0] - bb[j][0]);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (bb[j][0] > bb[i][1]) break;
      if (bb[j][2] > bb[i][3] || bb[j][3] < bb[i][2]) continue;
      const hits = segInt(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      for (const [t, u] of hits) { splits[i].push(t); splits[j].push(u); }
    }
  }
  // vertices with merge
  const q = 1 / (ext * 1e-7);
  const vmap = new Map(), verts = [];
  const vid = (x, y) => {
    const k = Math.round(x * q) + ',' + Math.round(y * q);
    let v = vmap.get(k);
    if (v === undefined) { v = verts.length; verts.push([x, y]); vmap.set(k, v); }
    return v;
  };
  const edgeSet = new Map();
  const edges = [];
  segs.forEach((s, i) => {
    const ts = [...new Set(splits[i])].sort((a, b) => a - b);
    let prev = vid(s.a[0], s.a[1]);
    for (let k = 1; k < ts.length; k++) {
      const t = ts[k];
      const v = k === ts.length - 1 ? vid(s.b[0], s.b[1]) : vid(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t);
      if (v !== prev) {
        const key = prev < v ? prev + '_' + v : v + '_' + prev;
        if (!edgeSet.has(key)) { edgeSet.set(key, edges.length); edges.push({ u: prev, v, ent: s.ent }); }
        prev = v;
      }
    }
  });
  // adjacency
  const adj = verts.map(() => []);
  edges.forEach((e, i) => { adj[e.u].push(i); adj[e.v].push(i); });
  const alive = edges.map(() => true);
  const deg = adj.map(a => a.length);
  deg.forEach((d, v) => { if (d === 1) openPts.push([verts[v][0], verts[v][1]]); });
  const stack = [];
  deg.forEach((d, v) => { if (d === 1) stack.push(v); });
  while (stack.length) {
    const v = stack.pop();
    for (const ei of adj[v]) if (alive[ei]) {
      alive[ei] = false;
      const e = edges[ei], w = e.u === v ? e.v : e.u;
      deg[v]--; deg[w]--;
      if (deg[w] === 1) stack.push(w);
    }
  }
  // half-edges sorted by angle
  const out = verts.map(() => []);
  const hes = [];
  edges.forEach((e, i) => {
    if (!alive[i]) return;
    const h1 = { from: e.u, to: e.v, ent: e.ent, edge: i }, h2 = { from: e.v, to: e.u, ent: e.ent, edge: i };
    h1.twin = hes.length + 1; h2.twin = hes.length;
    hes.push(h1, h2);
  });
  hes.forEach((h, i) => {
    const a = verts[h.from], b = verts[h.to];
    h.ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    out[h.from].push(i);
  });
  out.forEach(list => list.sort((i, j) => hes[i].ang - hes[j].ang));
  const pos = new Map();
  out.forEach(list => list.forEach((h, k) => pos.set(h, k)));
  // walk faces
  const visited = new Uint8Array(hes.length);
  const cycles = [];
  for (let i = 0; i < hes.length; i++) {
    if (visited[i]) continue;
    const cyc = [];
    let h = i, guard = 0;
    while (!visited[h] && guard++ < 100000) {
      visited[h] = 1; cyc.push(h);
      const tw = hes[h].twin, v = hes[h].to;
      const list = out[v];
      const k = pos.get(tw);
      h = list[(k - 1 + list.length) % list.length];
    }
    const pts = cyc.map(h => verts[hes[h].from]);
    cycles.push({ hes: cyc, pts, edgeEnts: cyc.map(h => hes[h].ent), area: polyArea(pts), ents: new Set(cyc.map(h => hes[h].ent)), verts: cyc.map(h => hes[h].from) });
  }
  // components (union-find on vertices)
  const par = verts.map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  edges.forEach((e, i) => { if (alive[i]) par[find(e.u)] = find(e.v); });
  cycles.forEach(c => c.comp = find(c.verts[0]));
  const faces = cycles.filter(c => c.area > eps * eps * 1e3);
  const outers = cycles.filter(c => c.area <= 0);
  // hole assignment and component depth
  const compContainer = {};
  for (const n of outers) {
    let best = null;
    const [x, y] = n.pts[0];
    for (const f of faces) {
      if (f.comp === n.comp) continue;
      if (best && f.area >= best.area) continue;
      if (pointInPoly(x, y, f.pts)) best = f;
    }
    n.container = best;
    compContainer[n.comp] = best;
  }
  for (const f of faces) f.holes = [];
  for (const n of outers) if (n.container) n.container.holes.push(n);
  const depthMemo = {};
  const depth = (comp, g = 0) => {
    if (depthMemo[comp] !== undefined) return depthMemo[comp];
    const c = compContainer[comp];
    const d = c && g < 50 ? depth(c.comp, g + 1) + 1 : 0;
    return (depthMemo[comp] = d);
  };
  const regions = faces.map((f, i) => {
    const entsOuter = [...f.ents].sort();
    const entsHoles = [...new Set(f.holes.flatMap(h => [...h.ents]))].sort();
    const outerPts = f.pts;
    const holePts = f.holes.map(h => h.pts);   // CW already (negative area)
    const sp = samplePoint(outerPts, holePts);
    return {
      id: i, outer: outerPts, holes: holePts, outerEnts: f.edgeEnts, holeEnts: f.holes.map(h => h.edgeEnts),
      key: entsOuter.join(',') + '|' + entsHoles.join(','),
      ents: entsOuter, depth: depth(f.comp),
      area: f.area + f.holes.reduce((s, h) => s + h.area, 0),
      sample: sp,
    };
  });
  return { regions, openPts };
}

export function regionContains(r, x, y) {
  if (!pointInPoly(x, y, r.outer)) return false;
  for (const h of r.holes) if (pointInPoly(x, y, h)) return false;
  return true;
}

// Resolve a feature's region selection {auto:true} | {keys:[{key,pt}]} -> region list
export function pickRegions(regs, sel) {
  if (!sel || sel.auto || !sel.keys || !sel.keys.length) return { list: regs.filter(r => r.depth % 2 === 0), auto: true };
  const list = [];
  let missing = 0;
  for (const k of sel.keys) {
    const cands = regs.filter(r => r.key === k.key);
    let r = null;
    if (cands.length === 1) r = cands[0];
    else if (cands.length > 1) r = cands.find(c => regionContains(c, k.pt[0], k.pt[1])) || cands[0];
    else r = regs.find(c => regionContains(c, k.pt[0], k.pt[1]));
    if (r && !list.includes(r)) list.push(r); else if (!r) missing++;
  }
  return { list, missing };
}
