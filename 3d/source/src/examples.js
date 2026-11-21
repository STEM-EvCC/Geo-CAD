// Example parts, each fully defined and driven by variables.
import { newDoc, newSketch, newId } from './model.js';
import { SketchEditor } from './sketch.js';
import { evalVariables } from './expr.js';
import { solveSketch } from './solver.js';

export function builder(doc, plane, name) {
  const sk = newSketch(doc, plane);
  if (name) sk.name = name;
  doc.features.push(sk);
  const B = {
    sk,
    p(x, y, o = {}) { const id = 'p' + (sk.nid++); sk.pts[id] = { x, y, ...o }; return id; },
    line(a, b, o = {}) { const id = 'e' + (sk.nid++); sk.ents.push({ id, t: 'line', a, b, ...o }); return id; },
    circle(c, r, o = {}) { const id = 'e' + (sk.nid++); sk.ents.push({ id, t: 'circle', c, r, ...o }); return id; },
    con(c) { c.id = 'c' + (sk.nid++); sk.cons.push(c); return c.id; },
    poly(ids) { const L = []; for (let i = 0; i < ids.length; i++) L.push(B.line(ids[i], ids[(i + 1) % ids.length])); return L; },
    // centered rectangle with H/V edges and a construction diagonal whose midpoint is the origin
    centerRect(w, h, wExpr, hExpr) {
      const p = [B.p(-w / 2, -h / 2), B.p(w / 2, -h / 2), B.p(w / 2, h / 2), B.p(-w / 2, h / 2)];
      const L = B.poly(p);
      B.con({ t: 'h', e: L[0] }); B.con({ t: 'v', e: L[1] }); B.con({ t: 'h', e: L[2] }); B.con({ t: 'v', e: L[3] });
      const d = B.line(p[0], p[2], { cons: true });
      B.con({ t: 'mid', p: 'O', e: d });
      B.con({ t: 'dist', p: p[0], q: p[1], v: wExpr, lab: [0, -h / 2 - 8] });
      B.con({ t: 'dist', p: p[1], q: p[2], v: hExpr, lab: [w / 2 + 10, 0] });
      return { p, L };
    },
  };
  return B;
}
export function fillet(doc, sk, pid, r, expr) {
  const ed = Object.create(SketchEditor.prototype);
  ed.app = { doc, res: { values: evalVariables(doc.vars).values } };
  ed.id = sk.id;
  ed.consMode = false;
  return ed.filletCorner(pid, r, expr);
}
export function finish(doc) {
  const vals = evalVariables(doc.vars).values;
  for (const f of doc.features) if (f.t === 'sketch') solveSketch(f, vals);
  return doc;
}

export const EXAMPLES = [
  {
    name: 'Start here: plate with a hole', desc: 'Rectangle, rounded corners and a centered hole, all driven by variables.',
    build() {
      const doc = newDoc('Plate with a hole');
      doc.vars.push({ name: 'width', expr: '60' }, { name: 'height', expr: '40' }, { name: 'thick', expr: '4' }, { name: 'hole', expr: '8' }, { name: 'corner', expr: '5' });
      const B = builder(doc, { k: 'std', name: 'Top' }, 'Plate outline');
      const { p } = B.centerRect(60, 40, '#width', '#height');
      const h = B.circle('O', 4);
      B.con({ t: 'dia', e: h, v: '#hole', lab: [10, 8] });
      for (const id of p) fillet(doc, B.sk, id, 5, '#corner');
      // keep only one radius dimension; the others become equal constraints
      const arcs = B.sk.ents.filter(e => e.t === 'arc');
      const rads = B.sk.cons.filter(c => c.t === 'rad');
      rads.slice(1).forEach(c => { B.sk.cons.splice(B.sk.cons.indexOf(c), 1); });
      arcs.slice(1).forEach(a => B.con({ t: 'eq', e1: arcs[0].id, e2: a.id }));
      doc.features.push({ id: newId(doc), t: 'extrude', name: 'Extrude 1', sketch: B.sk.id, regions: { auto: true }, op: 'new', end: 'blind', depth: '#thick', flip: false });
      return finish(doc);
    },
  },
  {
    name: 'Roof truss gusset (Week 9)', desc: 'Pitch math in the variables: change #rise and the slope, rafter and angle all update.',
    build() {
      const doc = newDoc('Truss gusset');
      doc.vars.push({ name: 'half_span', expr: '40' }, { name: 'rise', expr: '6' }, { name: 'peak', expr: '#half_span * #rise / 12' }, { name: 'rafter', expr: 'sqrt(#half_span^2 + #peak^2)' }, { name: 'pitch', expr: 'atan(#rise / 12)' }, { name: 'thick', expr: '4' }, { name: 'hole', expr: '4' });
      const B = builder(doc, { k: 'std', name: 'Top' }, 'Gusset outline');
      const L = B.p(-40, 0), R = B.p(40, 0), T = B.p(0, 20);
      const [base, right, left] = B.poly([L, R, T]);
      B.con({ t: 'sym', p: L, q: R, e: 'YAX' });
      B.con({ t: 'on', p: T, e: 'YAX' });
      B.con({ t: 'on', p: L, e: 'XAX' });
      B.con({ t: 'dist', p: L, q: R, v: '2 * #half_span', lab: [0, -10] });
      B.con({ t: 'pldist', p: T, e: base, v: '#peak', s: 1, lab: [26, 0] });
      // reference (driven) dimensions: they only measure, to check the math
      B.con({ t: 'dist', p: T, q: L, v: '44.72', driven: true, lab: [-10, 8] });
      B.con({ t: 'ang', e1: base, e2: left, r1: false, r2: true, v: '26.57', driven: true, lab: [18, 4] });
      const c = B.p(0, 7);
      const h = B.circle(c, 2);
      B.con({ t: 'on', p: c, e: 'YAX' });
      B.con({ t: 'pldist', p: c, e: base, v: '#peak / 3', s: 1, lab: [-14, 0] });
      B.con({ t: 'dia', e: h, v: '#hole', lab: [-16, 4] });
      doc.features.push({ id: newId(doc), t: 'extrude', name: 'Extrude 1', sketch: B.sk.id, regions: { auto: true }, op: 'new', end: 'blind', depth: '#thick', flip: false });
      return finish(doc);
    },
  },
  {
    name: 'Tea light lantern (revolve)', desc: 'Half the outline spun around an axis, then window cuts copied around in a circle.',
    build() {
      const doc = newDoc('Tea light lantern');
      doc.vars.push({ name: 'tealight_d', expr: '39' }, { name: 'gap', expr: '1' }, { name: 'wall', expr: '2' }, { name: 'height', expr: '32' }, { name: 'base', expr: '3' }, { name: 'window_d', expr: '8' }, { name: 'windows', expr: '6' });
      const B = builder(doc, { k: 'std', name: 'Front' }, 'Cup profile');
      const Rin = 20.5, Rout = 22.5;
      const Bp = B.p(Rout, 0), C = B.p(Rout, 32), D = B.p(Rin, 32), E = B.p(Rin, 3), F = B.p(0, 3);
      const [ab, bc, cd, de, ef, fa] = B.poly(['O', Bp, C, D, E, F]);
      B.con({ t: 'h', e: ab }); B.con({ t: 'v', e: bc }); B.con({ t: 'h', e: cd }); B.con({ t: 'v', e: de }); B.con({ t: 'h', e: ef });
      B.con({ t: 'on', p: F, e: 'YAX' });
      B.con({ t: 'dist', p: 'O', q: Bp, dir: 'h', s: 1, v: '#tealight_d/2 + #gap + #wall', lab: [0, -8] });
      B.con({ t: 'dist', p: Bp, q: C, dir: 'v', s: 1, v: '#height', lab: [10, 0] });
      B.con({ t: 'dist', p: 'O', q: E, dir: 'h', s: 1, v: '#tealight_d/2 + #gap', lab: [0, 10] });
      B.con({ t: 'dist', p: 'O', q: F, dir: 'v', s: 1, v: '#base', lab: [-8, 0] });
      const rev = { id: newId(doc), t: 'revolve', name: 'Revolve 1', sketch: B.sk.id, regions: { auto: true }, axis: { e: 'YAX' }, full: true, angle: '360', sym: false, flip: false, op: 'new' };
      doc.features.push(rev);
      const W = builder(doc, { k: 'std', name: 'Front' }, 'Window');
      const wc = W.p(0, 17.5);
      const wcirc = W.circle(wc, 4);
      W.con({ t: 'on', p: wc, e: 'YAX' });
      W.con({ t: 'dist', p: 'O', q: wc, dir: 'v', s: 1, v: '(#height + #base) / 2', lab: [10, 0] });
      W.con({ t: 'dia', e: wcirc, v: '#window_d', lab: [8, 6] });
      const cut = { id: newId(doc), t: 'extrude', name: 'Window cut', sketch: W.sk.id, regions: { auto: true }, op: 'remove', end: 'sym', depth: '#tealight_d * 2', flip: false };
      doc.features.push(cut);
      doc.features.push({ id: newId(doc), t: 'cpattern', name: 'Window pattern', feats: [cut.id], axis: { k: 'axis', a: 'Z' }, count: '#windows / 2', angle: '360', flip: false });
      return finish(doc);
    },
  },
  {
    name: 'Permeable paver (Week 5)', desc: 'A block with a grid of drain holes from a two-way linear pattern. #open_pct does the area math.',
    build() {
      const doc = newDoc('Permeable paver');
      doc.vars.push({ name: 'size', expr: '60' }, { name: 'thick', expr: '15' }, { name: 'n', expr: '3' }, { name: 'gap', expr: '#size / #n' }, { name: 'hole', expr: '8' }, { name: 'open_pct', expr: '100 * #n^2 * pi * (#hole/2)^2 / #size^2' });
      const B = builder(doc, { k: 'std', name: 'Top' }, 'Paver outline');
      B.centerRect(60, 60, '#size', '#size');
      const blk = { id: newId(doc), t: 'extrude', name: 'Block', sketch: B.sk.id, regions: { auto: true }, op: 'new', end: 'blind', depth: '#thick', flip: false };
      doc.features.push(blk);
      const H = builder(doc, { k: 'face', f: blk.id, role: 'end' }, 'First hole');
      const c = H.p(-20, -20);
      const k = H.circle(c, 4);
      H.con({ t: 'dist', p: c, q: 'O', dir: 'h', s: 1, v: '#size/2 - #gap/2', lab: [0, -8] });
      H.con({ t: 'dist', p: c, q: 'O', dir: 'v', s: 1, v: '#size/2 - #gap/2', lab: [-8, 0] });
      H.con({ t: 'dia', e: k, v: '#hole', lab: [8, 6] });
      const cut = { id: newId(doc), t: 'extrude', name: 'Hole cut', sketch: H.sk.id, regions: { auto: true }, op: 'remove', end: 'through', depth: '10', flip: true };
      doc.features.push(cut);
      doc.features.push({ id: newId(doc), t: 'lpattern', name: 'Hole grid', feats: [cut.id], dir: { k: 'axis', a: 'X' }, count: '#n', spacing: '#gap', flip: false, dir2: { k: 'axis', a: 'Y' }, count2: '#n', spacing2: '#gap', flip2: false });
      return finish(doc);
    },
  },
  {
    name: 'Blank part', desc: 'Start from nothing.',
    build() { return newDoc('My part'); },
  },
];
