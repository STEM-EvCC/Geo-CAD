// Sketch editor: tools, snapping, auto-constraints, dimensions, constraint tools, drawing.
import { solveSketch, dofStatus, testAdd, buildSystem, solveRows, measureDim, getPt, getEnt, isDim, radiusOf, dimValuesOf } from './solver.js';
import { computeRegions, entPolyline, arcAngles, regionContains } from './regions.js';
import { toWorld, toLocal } from './model.js';
import { evaluate, isPlainNumber, fmt, VAR_NAME_RE } from './expr.js';

const COL = { free: '#1f6fd1', def: '#141a21', sel: '#f28c28', hov: '#f59e0b', bad: '#d63b3b', dim: '#334e68', drv: '#7b8794', ref: '#4b5563' };
const D2R = Math.PI / 180;
const hyp = Math.hypot;

export class SketchEditor {
  constructor(app) {
    this.app = app;
    this.view = app.view;
    this.tool = 'select';
    this.sel = new Set();
    this.hover = null;
    this.op = null;        // in-progress drawing operation
    this.pick = null;      // constraint pick mode
    this.consMode = false;
    this.polySides = 6;
    this.filletR = '3';
    this.status = null;
    this.regions = null;
    this.mouse = null;
  }
  get sk() { return this.app.doc.features.find(f => f.id === this.id); }
  get values() { return this.app.res ? this.app.res.values : {}; }
  get plane() { return this.planeCache; }

  start(id, plane) {
    this.id = id; this.planeCache = plane;
    this.tool = 'select'; this.sel.clear(); this.op = null; this.pick = null; this.hover = null;
    this.refresh();
  }
  refresh() {
    const sk = this.sk;
    if (!sk) return;
    try { this.status = dofStatus(sk, this.values); } catch (e) { this.status = null; }
    try { this.regions = computeRegions(sk); } catch (e) { this.regions = { regions: [], openPts: [] }; }
    this.app.onSketchStatus(this.status);
    this.view.request();
  }

  // ---------- coordinates ----------
  scr(u, v) { return this.view.project(toWorld(this.plane, u, v)); }
  loc(x, y) { const p = this.view.rayPlane(x, y, this.plane); return p ? toLocal(this.plane, p) : null; }
  px() { const n = this.plane.n, vd = this.view.viewDir(); const c = Math.abs(n[0] * vd.x + n[1] * vd.y + n[2] * vd.z); return this.view.pxSize() / Math.max(0.25, c); }
  gridStep() {
    const px = this.px();
    const cands = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    return cands.find(s => s / px >= 9) || 200;
  }
  newPid() { return 'p' + (this.sk.nid++); }
  newEid() { return 'e' + (this.sk.nid++); }
  newCid() { return 'c' + (this.sk.nid++); }

  setTool(t) {
    this.cancelOp();
    this.pick = null;
    this.tool = t;
    if (t !== 'select' && t !== 'smirror') this.sel.clear();
    if (t === 'smirror') {
      if (!this.selEnts().length) { this.app.toast('Select the lines or circles to copy first, then click Sketch mirror.'); this.tool = 'select'; }
      else this.op = { kind: 'smirror' };
    }
    this.app.onToolChange(this.tool);
    this.hint();
    this.view.request();
  }
  cancelOp() { this.op = null; this.hideInput(); this.view.request(); }

  hint() {
    const H = {
      select: 'Click geometry to select it. Drag blue geometry to see how it can move. Double-click a dimension to change it.',
      line: this.op ? 'Click the next point. Click the first point to close. Esc stops.' : 'Click where the line starts.',
      rect: this.op ? 'Click the opposite corner.' : 'Click the first corner.',
      rectc: this.op ? 'Click a corner.' : 'Click the center (try the origin).',
      circle: this.op ? 'Click to set the size.' : 'Click the center.',
      arc3: !this.op ? 'Click the start of the arc.' : this.op.step === 1 ? 'Click the end of the arc.' : 'Move to bend the arc, then click.',
      arcc: !this.op ? 'Click the center.' : this.op.step === 1 ? 'Click the start point.' : 'Move around the center and click the end.',
      arct: this.op ? 'Click where the arc ends.' : 'Click the open end of a line or arc.',
      polygon: this.op ? 'Click a corner.' : 'Click the center. Change the number of sides in the bar above.',
      slot: !this.op ? 'Click the center of one end.' : this.op.step === 1 ? 'Click the center of the other end.' : 'Move to set the width, then click.',
      point: 'Click to place a point.',
      fillet: 'Click a corner where two lines meet.',
      trim: 'Click the piece of a line or curve to cut off. The red piece goes away.',
      smirror: 'Click the mirror line (it can be an axis).',
      dimension: !this.op ? 'Click a line, circle or point (or two things).' : this.op.place ? 'Click to place the number. Or click a second item to measure between them.' : 'Click a second point or line.',
      use: 'Click a flat face of the part to copy its outline.',
    };
    let h = H[this.tool] || '';
    if (this.pick) h = this.pickHint();
    this.app.setHint(h);
  }

  // ---------- selection helpers ----------
  selEnts() { return [...this.sel].filter(k => k[0] === 'e').map(k => k.slice(2)); }
  selPts() { return [...this.sel].filter(k => k[0] === 'p').map(k => k.slice(2)); }
  selCons() { return [...this.sel].filter(k => k[0] === 'c').map(k => k.slice(2)); }

  // ---------- hit testing ----------
  ptsList() {
    const sk = this.sk, out = [['O', 0, 0]];
    for (const id in sk.pts) {
      const p = sk.pts[id];
      if (p.virt) continue;
      out.push([id, p.x, p.y]);
    }
    return out;
  }
  nearestOnEnt(e, u, v) {
    const sk = this.sk;
    if (e.t === 'line') {
      const a = getPt(sk, e.a), b = getPt(sk, e.b);
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12;
      let t = ((u - a.x) * dx + (v - a.y) * dy) / L2;
      const inf = e.virt;
      if (!inf) t = Math.max(0, Math.min(1, t));
      const x = a.x + dx * t, y = a.y + dy * t;
      return { x, y, d: hyp(u - x, v - y), t };
    }
    if (e.t === 'circle') {
      const c = getPt(sk, e.c), ang = Math.atan2(v - c.y, u - c.x);
      const x = c.x + e.r * Math.cos(ang), y = c.y + e.r * Math.sin(ang);
      return { x, y, d: hyp(u - x, v - y), t: ang };
    }
    if (e.t === 'arc') {
      const A = arcAngles(sk, e);
      let ang = Math.atan2(v - A.cy, u - A.cx), rel = ang - A.a0;
      while (rel < 0) rel += 2 * Math.PI; while (rel >= 2 * Math.PI) rel -= 2 * Math.PI;
      if (rel > A.sw) {
        const a = getPt(sk, e.a), b = getPt(sk, e.b);
        const da = hyp(u - a.x, v - a.y), db = hyp(u - b.x, v - b.y);
        return da < db ? { x: a.x, y: a.y, d: da, t: 0 } : { x: b.x, y: b.y, d: db, t: 1 };
      }
      const x = A.cx + A.r * Math.cos(ang), y = A.cy + A.r * Math.sin(ang);
      return { x, y, d: hyp(u - x, v - y), t: rel / A.sw };
    }
    return { d: Infinity };
  }
  allEnts(withAxes = true) {
    const l = this.sk.ents.slice();
    if (withAxes) l.push(getEnt(this.sk, 'XAX'), getEnt(this.sk, 'YAX'));
    return l;
  }
  hitTest(x, y, opt = {}) {
    const P = this.loc(x, y);
    if (!P) return null;
    const [u, v] = P, px = this.px();
    // dimension labels
    if (opt.dims !== false) {
      for (const c of this.sk.cons) {
        if (!isDim(c) || !c._lab) continue;
        const [lx, ly] = this.scr(c._lab[0], c._lab[1]);
        if (Math.abs(x - lx) < (c._w || 20) / 2 + 3 && Math.abs(y - ly) < 10) return { kind: 'c', id: c.id, dim: true };
      }
    }
    if (opt.glyphs !== false && this.glyphs) {
      for (const g of this.glyphs) if (Math.abs(x - g.x) < 8 && Math.abs(y - g.y) < 8) return { kind: 'c', id: g.id };
    }
    if (opt.points !== false) {
      let best = null, bd = 9;
      for (const [id, pu, pv] of this.ptsList()) {
        if (opt.exclude && opt.exclude.includes(id)) continue;
        const [sx, sy] = this.scr(pu, pv);
        const d = hyp(sx - x, sy - y);
        if (d < bd) { bd = d; best = { kind: 'p', id }; }
      }
      if (best) return best;
    }
    if (opt.ents !== false) {
      let best = null, bd = 7 * px;
      for (const e of this.allEnts(opt.axes !== false)) {
        if (opt.only && !opt.only(e)) continue;
        const r = this.nearestOnEnt(e, u, v);
        const d = e.virt ? r.d + 2.5 * px : r.d;   // real geometry wins over the axes
        if (d < bd) { bd = d; best = { kind: 'e', id: e.id }; }
      }
      if (best) return best;
    }
    return null;
  }

  // snapping for new points
  snap(x, y, opt = {}) {
    const P = this.loc(x, y);
    if (!P) return null;
    let [u, v] = P;
    const px = this.px();
    const sk = this.sk;
    // existing points
    let best = null, bd = 10;
    for (const [id, pu, pv] of this.ptsList()) {
      if (opt.exclude && opt.exclude.includes(id)) continue;
      const [sx, sy] = this.scr(pu, pv);
      const d = hyp(sx - x, sy - y);
      if (d < bd) { bd = d; best = { kind: 'pt', id, u: pu, v: pv }; }
    }
    if (best) return best;
    // midpoints
    for (const e of sk.ents) {
      if (e.t !== 'line') continue;
      const a = getPt(sk, e.a), b = getPt(sk, e.b);
      const mu = (a.x + b.x) / 2, mv = (a.y + b.y) / 2;
      const [sx, sy] = this.scr(mu, mv);
      if (hyp(sx - x, sy - y) < 8) return { kind: 'mid', e: e.id, u: mu, v: mv };
    }
    // horizontal / vertical inference from the previous point
    let hv = null;
    if (opt.from) {
      const f = opt.from;
      const [fx, fy] = this.scr(f[0], f[1]);
      const ang = Math.abs(Math.atan2(y - fy, x - fx)) / D2R;
      const far = hyp(x - fx, y - fy) > 14;
      if (far && (ang < 3 || ang > 177)) { hv = 'h'; v = f[1]; }
      else if (far && Math.abs(ang - 90) < 3) { hv = 'v'; u = f[0]; }
    }
    // on curve
    let on = null, od = 7 * px;
    for (const e of this.allEnts(true)) {
      if (opt.excludeEnt && opt.excludeEnt.includes(e.id)) continue;
      const r = this.nearestOnEnt(e, u, v);
      const d = e.virt ? r.d + 2.5 * px : r.d;
      if (d < od) { od = d; on = { kind: 'on', e: e.id, u: r.x, v: r.y }; }
    }
    if (on && !hv) return on;
    if (!hv && this.app.snapGrid) {
      const s = this.gridStep();
      u = Math.round(u / s) * s; v = Math.round(v / s) * s;
    } else if (hv && this.app.snapGrid) {
      const s = this.gridStep();
      if (hv === 'h') u = Math.round(u / s) * s; else v = Math.round(v / s) * s;
    }
    return { kind: 'free', u, v, hv };
  }

  // create (or reuse) a point for a snap; returns [id, pendingConstraints]
  mkPt(s, cons = false) {
    if (s.kind === 'pt') return [s.id, []];
    const id = this.newPid();
    this.sk.pts[id] = { x: s.u, y: s.v };
    if (cons) this.sk.pts[id].cons = true;
    const pend = [];
    if (s.kind === 'mid') pend.push({ t: 'mid', p: id, e: s.e });
    if (s.kind === 'on') pend.push({ t: 'on', p: id, e: s.e });
    return [id, pend];
  }

  begin() { this.before = JSON.stringify(this.sk); }
  revert() {
    if (!this.before) return;
    const i = this.app.doc.features.findIndex(f => f.id === this.id);
    this.app.doc.features[i] = JSON.parse(this.before);
  }
  // add constraints, skipping redundant ones, then solve; returns false if solve failed
  addCons(list, opts = {}) {
    const sk = this.sk, added = [];
    for (const c of list) {
      c.id = c.id || this.newCid();
      let red = false;
      try { red = testAdd(sk, this.values, c).redundant; } catch (e) { red = true; }
      if (red) {
        if (isDim(c) && opts.dimDriven !== false) { c.driven = true; sk.cons.push(c); added.push(c); }
        continue;
      }
      sk.cons.push(c); added.push(c);
    }
    let r = solveSketch(sk, this.values);
    while (!r.ok && opts.auto && added.length) {
      const c = added.pop();
      sk.cons.splice(sk.cons.indexOf(c), 1);
      r = solveSketch(sk, this.values);
    }
    return r.ok ? added : null;
  }
  commit() {
    const r = solveSketch(this.sk, this.values);
    if (!r.ok) { this.revert(); this.app.toast('That doesn\'t fit with the other rules, so I undid it.', 'bad'); }
    this.cleanup();
    this.app.pushUndo();
    this.refresh();
  }
  cleanup() {
    const sk = this.sk;
    // remove degenerate entities and orphan points
    sk.ents = sk.ents.filter(e => !(e.t === 'line' && e.a === e.b));
    const used = new Set();
    for (const e of sk.ents) [e.a, e.b, e.c].forEach(p => p && used.add(p));
    for (const c of sk.cons) [c.p, c.q, c.p1, c.q1, c.p2, c.q2, c.at].forEach(p => p && used.add(p));
    for (const id in sk.pts) if (!used.has(id) && !sk.pts[id].std) delete sk.pts[id];
    const entIds = new Set(sk.ents.map(e => e.id).concat(['XAX', 'YAX']));
    const ptOk = (p) => !p || p === 'O' || sk.pts[p];
    sk.cons = sk.cons.filter(c => [c.e, c.e1, c.e2].every(e => !e || entIds.has(e)) && [c.p, c.q, c.p1, c.q1, c.p2, c.q2, c.at].every(ptOk));
    // remove now-dangling 'on' / point constraints referencing removed points handled above
    for (const s of [...this.sel]) {
      const id = s.slice(2);
      if ((s[0] === 'e' && !entIds.has(id)) || (s[0] === 'p' && !sk.pts[id]) || (s[0] === 'c' && !sk.cons.find(c => c.id === id))) this.sel.delete(s);
    }
  }

  // ---------- pointer events ----------
  down(x, y, e) {
    if (e.button !== 0) return false;
    this.mouse = [x, y];
    if (this.inputEl && document.activeElement === this.inputEl) this.applyInput();
    if (this.tool === 'select' && !this.pick) {
      const h = this.hitTest(x, y);
      if (h) {
        const fixed = (h.kind === 'p' && (h.id === 'O' || this.sk.pts[h.id]?.fixed)) || (h.kind === 'e' && this.isFixedEnt(h.id)) || h.kind === 'c' && !h.dim;
        this.dragStart = { h, x, y, moved: false, P: this.loc(x, y), dim: !!h.dim, nodrag: fixed || e.shiftKey || e.ctrlKey || e.metaKey };
        return true;
      }
      if (!e.shiftKey) { this.box = { x0: x, y0: y, x1: x, y1: y }; return true; }
      return false;
    }
    return true; // tools consume left clicks
  }
  isFixedEnt(id) {
    const e = getEnt(this.sk, id);
    if (!e || e.virt) return true;
    return [e.a, e.b, e.c].filter(Boolean).every(p => p === 'O' || this.sk.pts[p]?.fixed) && e.t !== 'circle';
  }
  drag(x, y, e) {
    if (this.box) { this.box.x1 = x; this.box.y1 = y; this.view.request(); return; }
    const d = this.dragStart;
    if (d && d.nodrag && !d.told && hyp(x - d.x, y - d.y) > 8 && !(d.h.kind === 'c')) { d.told = true; this.app.toast(d.h.id === 'O' ? 'That is the origin (0, 0). It never moves.' : 'That is fixed in place, so it can\'t be dragged.'); }
    if (!d || d.nodrag) return;
    if (!d.moved && hyp(x - d.x, y - d.y) < 4) return;
    if (!d.moved) { d.moved = true; this.begin(); }
    const P = this.loc(x, y);
    if (!P) return;
    if (d.dim) {
      const c = this.sk.cons.find(k => k.id === d.h.id);
      const anchor = this.dimAnchor(c);
      c.lab = [P[0] - anchor[0], P[1] - anchor[1]];
      this.view.request();
      return;
    }
    this.dragSolve(d, P);
  }
  dragSolve(d, P) {
    const sk = this.sk;
    const targets = [];
    const dx = P[0] - d.P[0], dy = P[1] - d.P[1];
    if (!d.orig) { d.orig = JSON.parse(JSON.stringify({ pts: sk.pts, ents: sk.ents })); }
    const op = d.orig.pts;
    let radiusTarget = null;
    if (d.h.kind === 'p') targets.push([d.h.id, P[0], P[1]]);
    else {
      const en = sk.ents.find(k => k.id === d.h.id);
      if (en.t === 'circle') {
        const c = getPt(sk, en.c);
        radiusTarget = [en.id, hyp(P[0] - c.x, P[1] - c.y)];
      } else for (const pid of [en.a, en.b, en.c]) if (pid && op[pid] && !op[pid].fixed) targets.push([pid, op[pid].x + dx, op[pid].y + dy]);
    }
    const soft = (sys) => {
      const rows = [];
      for (const [pid, tx, ty] of targets) {
        const ix = sys.vi[pid + '.x'], iy = sys.vi[pid + '.y'];
        if (ix === undefined) continue;
        rows.push({ vars: [ix, iy], n: 2, w: 1, f: (X) => [X[ix] - tx, X[iy] - ty] });
      }
      if (radiusTarget) { const ri = sys.vi[radiusTarget[0] + '.r']; rows.push({ vars: [ri], n: 1, w: 1, f: (X) => [X[ri] - radiusTarget[1]] }); }
      return rows;
    };
    const r = solveSketch(sk, this.values, { soft, maxIt: 25 });
    if (r.ok) { try { this.regions = computeRegions(sk); } catch (e) { /* ignore */ } }
    this.view.request();
  }
  up(x, y, e) {
    if (this.box) {
      const b = this.box; this.box = null;
      if (Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 6) this.boxSelect(b, e.shiftKey);
      else { this.sel.clear(); this.app.onSelChange(); }
      this.view.request();
      return;
    }
    const d = this.dragStart; this.dragStart = null;
    if (d && d.moved) { this.commit(); return; }
    this.click(x, y, e);
  }
  boxSelect(b, add) {
    if (!add) this.sel.clear();
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    const inside = (u, v) => { const [x, y] = this.scr(u, v); return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
    for (const e of this.sk.ents) if (entPolyline(this.sk, e, 0.2).every(p => inside(p[0], p[1]))) this.sel.add('e:' + e.id);
    for (const id in this.sk.pts) { const p = this.sk.pts[id]; if (p.std && inside(p.x, p.y)) this.sel.add('p:' + id); }
    this.app.onSelChange();
  }
  move(x, y, e) {
    this.mouse = [x, y];
    if (this.tool === 'select' || this.pick) {
      const h = this.hitTest(x, y);
      const k = h ? h.kind + ':' + h.id : null;
      if (k !== this.hover) { this.hover = k; this.view.request(); }
      this.view.overlay.style.cursor = h ? 'pointer' : 'default';
      return;
    }
    this.view.overlay.style.cursor = 'crosshair';
    if (this.tool === 'trim' || this.tool === 'fillet' || this.tool === 'smirror' || (this.tool === 'dimension' && !(this.op && this.op.place))) {
      const h = this.hitTest(x, y, { dims: false, glyphs: false, points: this.tool !== 'trim' && this.tool !== 'smirror', axes: this.tool !== 'trim' });
      this.hover = h ? h.kind + ':' + h.id : null;
      if (this.tool === 'trim') this.trimPreview = h && h.kind === 'e' ? this.trimPlan(h.id, this.loc(x, y)) : null;
    }
    if (this.tool === 'use') { this.app.hoverFace(x, y); }
    this.view.request();
  }
  leave() { this.hover = null; this.trimPreview = null; this.view.request(); }

  click(x, y, e) {
    const sk = this.sk;
    if (this.pick) { this.pickClick(x, y, e); return; }
    if (this.tool === 'select') {
      const h = this.hitTest(x, y);
      if (!h) { if (!e.shiftKey) this.sel.clear(); this.app.onSelChange(); this.view.request(); return; }
      const k = h.kind + ':' + h.id;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k); }
      else { this.sel.clear(); this.sel.add(k); }
      this.app.onSelChange();
      this.view.request();
      return;
    }
    const fn = this['click_' + this.tool];
    if (fn) fn.call(this, x, y, e);
    this.hint();
    this.view.request();
  }
  dbl(x, y) {
    const h = this.hitTest(x, y, { glyphs: false });
    if (h && h.dim) { this.editDim(h.id); return; }
    if (this.op && this.tool === 'line') { this.op = null; this.hint(); this.view.request(); }
  }
  rclick() {
    if (this.op) { this.op = null; this.hint(); this.view.request(); return; }
    if (this.tool !== 'select') this.setTool('select');
  }

  // ---------- drawing tools ----------
  newEnt(t, props) { const e = { id: this.newEid(), t, ...props }; if (this.consMode) e.cons = true; this.sk.ents.push(e); return e; }

  click_line(x, y) {
    const s = this.snap(x, y, { from: this.op ? this.op.p : null, exclude: this.op ? [this.op.pid] : [] });
    if (!s) return;
    if (!this.op) {
      this.begin();
      const [pid, pend] = this.mkPt(s);
      this.op = { pid, p: [s.u, s.v], pend, first: pid, created: s.kind !== 'pt' };
      return;
    }
    if (hyp(s.u - this.op.p[0], s.v - this.op.p[1]) < this.px() * 3) return;
    if (!this.op.started) { this.op.started = true; } else this.begin();
    const [pid, pend] = this.mkPt(s);
    const e = this.newEnt('line', { a: this.op.pid, b: pid });
    const cons = [...this.op.pend, ...pend];
    if (s.hv) cons.push({ t: s.hv, e: e.id });
    this.op.pend = [];
    if (!this.addCons(cons, { auto: true })) { this.revert(); this.op = null; this.app.toast('Couldn\'t add that line.', 'bad'); return; }
    this.commit();
    const closed = s.kind === 'pt' && (pid === this.op.first || this.sk.ents.filter(k => k.a === pid || k.b === pid || k.c === pid).length > 1);
    if (closed) { this.op = null; return; }
    const P = getPt(this.sk, pid);
    this.op = { ...this.op, pid, p: [P.x, P.y], pend: [] };
  }
  click_rect(x, y) { this.rectTool(x, y, false); }
  click_rectc(x, y) { this.rectTool(x, y, true); }
  rectTool(x, y, center) {
    const s = this.snap(x, y);
    if (!s) return;
    if (!this.op) { this.op = { s0: s }; return; }
    const s0 = this.op.s0;
    let x0, y0, x1, y1;
    if (center) { const dx = Math.abs(s.u - s0.u), dy = Math.abs(s.v - s0.v); x0 = s0.u - dx; x1 = s0.u + dx; y0 = s0.v - dy; y1 = s0.v + dy; }
    else { x0 = s0.u; y0 = s0.v; x1 = s.u; y1 = s.v; }
    if (Math.abs(x1 - x0) < this.px() * 3 || Math.abs(y1 - y0) < this.px() * 3) return;
    this.begin();
    const sk = this.sk, cons = [];
    const ids = [];
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    if (center) {
      for (const c of corners) { const id = this.newPid(); sk.pts[id] = { x: c[0], y: c[1] }; ids.push(id); }
    } else {
      // corner 0 from s0, corner 2 from s
      for (let i = 0; i < 4; i++) {
        if (i === 0) { const [id, p] = this.mkPt({ ...s0, u: x0, v: y0 }); ids.push(id); cons.push(...p); }
        else if (i === 2) { const [id, p] = this.mkPt({ ...s, u: x1, v: y1 }); ids.push(id); cons.push(...p); }
        else { const id = this.newPid(); sk.pts[id] = { x: corners[i][0], y: corners[i][1] }; ids.push(id); }
      }
    }
    const L = [];
    for (let i = 0; i < 4; i++) L.push(this.newEnt('line', { a: ids[i], b: ids[(i + 1) % 4] }));
    const base = [{ t: 'h', e: L[0].id }, { t: 'v', e: L[1].id }, { t: 'h', e: L[2].id }, { t: 'v', e: L[3].id }];
    if (center) {
      const d1 = { id: this.newEid(), t: 'line', a: ids[0], b: ids[2], cons: true };
      const d2 = { id: this.newEid(), t: 'line', a: ids[1], b: ids[3], cons: true };
      sk.ents.push(d1, d2);
      const [cid, p] = this.mkPt(s0);
      if (!sk.pts[cid] && cid !== 'O') { /* reused */ }
      if (sk.pts[cid] && s0.kind !== 'pt') sk.pts[cid].cons = true;
      cons.push(...p, { t: 'mid', p: cid, e: d1.id });
    }
    this.op = null;
    if (!this.addCons([...base, ...cons], { auto: true })) { this.revert(); this.app.toast('Couldn\'t add that rectangle.', 'bad'); return; }
    this.commit();
  }
  click_circle(x, y) {
    const s = this.snap(x, y, this.op ? { exclude: [this.op.cid] } : {});
    if (!s) return;
    if (!this.op) { this.begin(); const [cid, pend] = this.mkPt(s); this.op = { cid, pend, c: [s.u, s.v] }; return; }
    const r = hyp(s.u - this.op.c[0], s.v - this.op.c[1]);
    if (r < this.px() * 3) return;
    const e = this.newEnt('circle', { c: this.op.cid, r });
    const cons = [...this.op.pend];
    if (s.kind === 'pt' && s.id !== this.op.cid) cons.push({ t: 'on', p: s.id, e: e.id });
    this.op = null;
    if (!this.addCons(cons, { auto: true })) { this.revert(); return; }
    this.commit();
  }
  arcFrom3(a, b, m) {
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = m[0], cy = m[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    // is m on the CCW path from a to b?
    const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return { c: [ux, uy], ccw: cr > 0 };
  }
  click_arc3(x, y) {
    const s = this.snap(x, y);
    if (!s) return;
    if (!this.op) { this.op = { step: 1, s0: s }; return; }
    if (this.op.step === 1) { if (hyp(s.u - this.op.s0.u, s.v - this.op.s0.v) < this.px() * 3) return; this.op = { ...this.op, step: 2, s1: s }; return; }
    const a = [this.op.s0.u, this.op.s0.v], b = [this.op.s1.u, this.op.s1.v];
    const P = this.loc(x, y);
    const g = this.arcFrom3(a, b, P);
    if (!g) return;
    this.begin();
    const [ia, pa] = this.mkPt(this.op.s0), [ib, pb] = this.mkPt(this.op.s1);
    const cid = this.newPid(); this.sk.pts[cid] = { x: g.c[0], y: g.c[1] };
    this.newEnt('arc', g.ccw ? { c: cid, a: ib, b: ia } : { c: cid, a: ia, b: ib });
    this.op = null;
    if (!this.addCons([...pa, ...pb], { auto: true })) { this.revert(); return; }
    this.commit();
  }
  click_arcc(x, y) {
    const s = this.snap(x, y);
    if (!s) return;
    if (!this.op) { this.op = { step: 1, sc: s }; return; }
    const c = [this.op.sc.u, this.op.sc.v];
    if (this.op.step === 1) {
      const r = hyp(s.u - c[0], s.v - c[1]);
      if (r < this.px() * 3) return;
      this.op = { ...this.op, step: 2, s0: s, r, sweep: 0, lastAng: Math.atan2(s.v - c[1], s.u - c[0]) };
      return;
    }
    const P = this.loc(x, y);
    const ang = Math.atan2(P[1] - c[1], P[0] - c[0]);
    const r = this.op.r;
    this.begin();
    const [icc, pc] = this.mkPt(this.op.sc);
    const [ia, pa] = this.mkPt(this.op.s0);
    const endS = s.kind === 'pt' ? s : { kind: 'free', u: c[0] + r * Math.cos(ang), v: c[1] + r * Math.sin(ang) };
    const [ib, pb] = this.mkPt(endS);
    this.newEnt('arc', this.op.sweep >= 0 ? { c: icc, a: ia, b: ib } : { c: icc, a: ib, b: ia });
    this.op = null;
    if (!this.addCons([...pc, ...pa, ...pb], { auto: true })) { this.revert(); return; }
    this.commit();
  }
  tangentAt(pid) {
    // entity ending at pid -> tangent direction leaving pid
    const sk = this.sk;
    const es = sk.ents.filter(e => !e.cons && (e.a === pid || e.b === pid) && (e.t === 'line' || e.t === 'arc'));
    if (es.length !== 1) return null;
    const e = es[0], P = getPt(sk, pid);
    if (e.t === 'line') { const o = getPt(sk, e.a === pid ? e.b : e.a); const l = hyp(P.x - o.x, P.y - o.y); return { e, d: [(P.x - o.x) / l, (P.y - o.y) / l] }; }
    const c = getPt(sk, e.c); const rx = P.x - c.x, ry = P.y - c.y, l = hyp(rx, ry);
    // arc CCW from a to b: tangent at b is CCW direction, at a it's CW direction (leaving)
    return e.b === pid ? { e, d: [-ry / l, rx / l] } : { e, d: [ry / l, -rx / l] };
  }
  tanArcGeom(P0, d, P1) {
    const nx = -d[1], ny = d[0];
    const wx = P1[0] - P0[0], wy = P1[1] - P0[1];
    const den = 2 * (wx * nx + wy * ny);
    if (Math.abs(den) < 1e-9) return null;
    const r = (wx * wx + wy * wy) / den;
    return { c: [P0[0] + nx * r, P0[1] + ny * r], ccw: r > 0 };
  }
  click_arct(x, y) {
    if (!this.op) {
      const h = this.hitTest(x, y, { ents: false, dims: false, glyphs: false });
      if (!h || h.kind !== 'p') { this.app.toast('Click the open end of a line or arc.'); return; }
      const t = this.tangentAt(h.id);
      if (!t) { this.app.toast('Pick an end point that belongs to just one line or arc.'); return; }
      const P = getPt(this.sk, h.id);
      this.op = { pid: h.id, p: [P.x, P.y], d: t.d, e: t.e.id };
      return;
    }
    const s = this.snap(x, y, { exclude: [this.op.pid] });
    const g = this.tanArcGeom(this.op.p, this.op.d, [s.u, s.v]);
    if (!g) return;
    this.begin();
    const [ib, pb] = this.mkPt(s);
    const cid = this.newPid(); this.sk.pts[cid] = { x: g.c[0], y: g.c[1] };
    const arc = this.newEnt('arc', g.ccw ? { c: cid, a: this.op.pid, b: ib } : { c: cid, a: ib, b: this.op.pid });
    const cons = [...pb, { t: 'tan', e1: this.op.e, e2: arc.id, at: this.op.pid }];
    this.op = null;
    if (!this.addCons(cons, { auto: true })) { this.revert(); return; }
    this.commit();
  }
  click_polygon(x, y) {
    const s = this.snap(x, y);
    if (!s) return;
    if (!this.op) { this.op = { sc: s }; return; }
    const c = [this.op.sc.u, this.op.sc.v];
    const r = hyp(s.u - c[0], s.v - c[1]);
    if (r < this.px() * 4) return;
    const n = Math.max(3, Math.min(24, this.polySides | 0));
    this.begin();
    const sk = this.sk;
    const [cid, pc] = this.mkPt(this.op.sc);
    if (sk.pts[cid] && this.op.sc.kind !== 'pt') sk.pts[cid].cons = true;
    const circ = { id: this.newEid(), t: 'circle', c: cid, r, cons: true };
    sk.ents.push(circ);
    const a0 = Math.atan2(s.v - c[1], s.u - c[0]);
    const ids = [];
    for (let i = 0; i < n; i++) { const id = this.newPid(); sk.pts[id] = { x: c[0] + r * Math.cos(a0 + i * 2 * Math.PI / n), y: c[1] + r * Math.sin(a0 + i * 2 * Math.PI / n) }; ids.push(id); }
    const L = [];
    for (let i = 0; i < n; i++) L.push(this.newEnt('line', { a: ids[i], b: ids[(i + 1) % n] }));
    const cons = [...pc];
    ids.forEach(id => cons.push({ t: 'on', p: id, e: circ.id }));
    for (let i = 1; i < n; i++) cons.push({ t: 'eq', e1: L[0].id, e2: L[i].id });
    this.op = null;
    if (!this.addCons(cons, { auto: true })) { this.revert(); return; }
    this.commit();
  }
  click_slot(x, y) {
    const s = this.snap(x, y);
    if (!s) return;
    if (!this.op) { this.op = { step: 1, s0: s }; return; }
    if (this.op.step === 1) { if (hyp(s.u - this.op.s0.u, s.v - this.op.s0.v) < this.px() * 4) return; this.op = { ...this.op, step: 2, s1: s }; return; }
    const P = this.loc(x, y);
    const g = this.slotGeom(this.op.s0, this.op.s1, P);
    if (!g) return;
    this.begin();
    const sk = this.sk;
    const [c1, p1] = this.mkPt(this.op.s0), [c2, p2] = this.mkPt(this.op.s1);
    const ids = g.pts.map(p => { const id = this.newPid(); sk.pts[id] = { x: p[0], y: p[1] }; return id; });
    // pts: 0 = c1 + n*r, 1 = c1 - n*r, 2 = c2 - n*r, 3 = c2 + n*r ; arcs CCW
    const cl = { id: this.newEid(), t: 'line', a: c1, b: c2, cons: true }; sk.ents.push(cl);
    const A1 = this.newEnt('arc', { c: c1, a: ids[0], b: ids[1] });
    const Lb = this.newEnt('line', { a: ids[1], b: ids[2] });
    const A2 = this.newEnt('arc', { c: c2, a: ids[2], b: ids[3] });
    const Lt = this.newEnt('line', { a: ids[3], b: ids[0] });
    const cons = [...p1, ...p2, { t: 'tan', e1: Lb.id, e2: A1.id, at: ids[1] }, { t: 'tan', e1: Lb.id, e2: A2.id, at: ids[2] }, { t: 'tan', e1: Lt.id, e2: A2.id, at: ids[3] }, { t: 'tan', e1: Lt.id, e2: A1.id, at: ids[0] }, { t: 'eq', e1: A1.id, e2: A2.id }];
    this.op = null;
    if (!this.addCons(cons, { auto: true })) { this.revert(); return; }
    this.commit();
  }
  slotGeom(s0, s1, P) {
    const dx = s1.u - s0.u, dy = s1.v - s0.v, l = hyp(dx, dy);
    if (l < 1e-9) return null;
    const nx = -dy / l, ny = dx / l;
    const r = Math.max(this.px() * 3, Math.abs((P[0] - s0.u) * nx + (P[1] - s0.v) * ny));
    return { r, pts: [[s0.u + nx * r, s0.v + ny * r], [s0.u - nx * r, s0.v - ny * r], [s1.u - nx * r, s1.v - ny * r], [s1.u + nx * r, s1.v + ny * r]] };
  }
  click_point(x, y) {
    const s = this.snap(x, y);
    if (!s || s.kind === 'pt') return;
    this.begin();
    const [id, pend] = this.mkPt(s);
    this.sk.pts[id].std = true;
    if (!this.addCons(pend, { auto: true })) { this.revert(); return; }
    this.commit();
  }

  click_use(x, y) { this.app.useFaceAt(x, y); }

  // ---------- fillet ----------
  click_fillet(x, y) {
    const h = this.hitTest(x, y, { ents: false, dims: false, glyphs: false });
    if (!h || h.kind !== 'p') { this.app.toast('Click right on a corner point.'); return; }
    let r;
    try { r = evaluate(this.filletR, this.values); } catch (e) { this.app.toast('Fillet radius: ' + e.message, 'bad'); return; }
    if (!(r > 0)) { this.app.toast('The radius must be more than 0.', 'bad'); return; }
    this.begin();
    const res = this.filletCorner(h.id, r, this.filletR);
    if (res !== true) { this.revert(); this.app.toast(res, 'bad'); return; }
    this.commit();
  }
  filletCorner(pid, r, rExpr) {
    const sk = this.sk;
    const ls = sk.ents.filter(e => e.t === 'line' && !e.cons && (e.a === pid || e.b === pid));
    if (ls.length !== 2 || sk.ents.some(e => e.t !== 'line' && !e.cons && (e.a === pid || e.b === pid))) return 'A fillet needs a corner where exactly two lines meet.';
    const P = getPt(sk, pid);
    const [L1, L2] = ls;
    const o1 = getPt(sk, L1.a === pid ? L1.b : L1.a), o2 = getPt(sk, L2.a === pid ? L2.b : L2.a);
    const l1 = hyp(o1.x - P.x, o1.y - P.y), l2 = hyp(o2.x - P.x, o2.y - P.y);
    const u1 = [(o1.x - P.x) / l1, (o1.y - P.y) / l1], u2 = [(o2.x - P.x) / l2, (o2.y - P.y) / l2];
    const cosA = u1[0] * u2[0] + u1[1] * u2[1];
    const A = Math.acos(Math.max(-1, Math.min(1, cosA)));
    if (A < 1e-3 || A > Math.PI - 1e-3) return 'Those lines are straight in a row, so there is no corner to round.';
    const t = r / Math.tan(A / 2);
    if (t >= l1 - 1e-6 || t >= l2 - 1e-6) return 'That radius is too big for these lines.';
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = hyp(bis[0], bis[1]);
    const dc = r / Math.sin(A / 2);
    const C = [P.x + bis[0] / bl * dc, P.y + bis[1] / bl * dc];
    const T1 = [P.x + u1[0] * t, P.y + u1[1] * t], T2 = [P.x + u2[0] * t, P.y + u2[1] * t];
    const it1 = this.newPid(), it2 = this.newPid(), ic = this.newPid();
    sk.pts[it1] = { x: T1[0], y: T1[1] }; sk.pts[it2] = { x: T2[0], y: T2[1] }; sk.pts[ic] = { x: C[0], y: C[1] };
    // equal-length constraints on these lines become point-pair constraints using the sharp corner
    for (const c of sk.cons) {
      if (c.t === 'eq' && [L1.id, L2.id].some(id => id === c.e1 || id === c.e2)) {
        const pair = (eid) => { const e = sk.ents.find(k => k.id === eid); return [e.a, e.b]; };
        const [a1, b1] = pair(c.e1), [a2, b2] = pair(c.e2);
        Object.assign(c, { t: 'eqd', p1: a1, q1: b1, p2: a2, q2: b2 }); delete c.e1; delete c.e2;
      }
    }
    if (L1.a === pid) L1.a = it1; else L1.b = it1;
    if (L2.a === pid) L2.a = it2; else L2.b = it2;
    sk.pts[pid].cons = true; sk.pts[pid].sharp = true;
    const cr = (T1[0] - C[0]) * (T2[1] - C[1]) - (T1[1] - C[1]) * (T2[0] - C[0]);
    const arc = { id: this.newEid(), t: 'arc', c: ic, a: cr > 0 ? it1 : it2, b: cr > 0 ? it2 : it1 };
    sk.ents.push(arc);
    const mid = [C[0] - bis[0] / bl * r, C[1] - bis[1] / bl * r];
    const lab = [(mid[0] - C[0]) * 0.8 - bis[0] / bl * 8, (mid[1] - C[1]) * 0.8 - bis[1] / bl * 8];
    const cons = [{ t: 'on', p: pid, e: L1.id }, { t: 'on', p: pid, e: L2.id }, { t: 'tan', e1: L1.id, e2: arc.id, at: it1 }, { t: 'tan', e1: L2.id, e2: arc.id, at: it2 }, { t: 'rad', e: arc.id, v: String(rExpr ?? fmt(r, 3)), lab }];
    for (const c of cons) { c.id = this.newCid(); sk.cons.push(c); }
    const rr = solveSketch(sk, this.values);
    if (!rr.ok) return 'That fillet doesn\'t fit with the other rules.';
    return true;
  }

  // ---------- trim ----------
  paramPoint(e, t) {
    const sk = this.sk;
    if (e.t === 'line') { const a = getPt(sk, e.a), b = getPt(sk, e.b); return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]; }
    if (e.t === 'circle') { const c = getPt(sk, e.c); return [c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)]; }
    const A = arcAngles(sk, e); const ang = A.a0 + A.sw * t; return [A.cx + A.r * Math.cos(ang), A.cy + A.r * Math.sin(ang)];
  }
  // intersections of entity e with all others: [{t, by}]
  cuts(e) {
    const sk = this.sk, out = [];
    const geomOf = (k) => {
      if (k.t === 'line') { const a = getPt(sk, k.a), b = getPt(sk, k.b); return { L: [a.x, a.y, b.x, b.y] }; }
      const c = getPt(sk, k.c); return { C: [c.x, c.y, radiusOf(sk, k)] };
    };
    const ptsOf = (g1, g2) => {
      const res = [];
      if (g1.L && g2.L) {
        const [x1, y1, x2, y2] = g1.L, [x3, y3, x4, y4] = g2.L;
        const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(d) < 1e-12) return res;
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
        res.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
      } else if (g1.L || g2.L) {
        const [x1, y1, x2, y2] = (g1.L || g2.L), [cx, cy, r] = (g1.C || g2.C);
        const dx = x2 - x1, dy = y2 - y1, A = dx * dx + dy * dy, B = 2 * (dx * (x1 - cx) + dy * (y1 - cy)), Cc = (x1 - cx) ** 2 + (y1 - cy) ** 2 - r * r;
        const disc = B * B - 4 * A * Cc;
        if (disc < -1e-9) return res;
        const sq = Math.sqrt(Math.max(0, disc));
        for (const s of disc < 1e-12 ? [0] : [-1, 1]) { const t = (-B + s * sq) / (2 * A); res.push([x1 + t * dx, y1 + t * dy]); }
      } else {
        const [x1, y1, r1] = g1.C, [x2, y2, r2] = g2.C;
        const d = hyp(x2 - x1, y2 - y1);
        if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return res;
        const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
        const mx = x1 + a * (x2 - x1) / d, my = y1 + a * (y2 - y1) / d;
        res.push([mx + h * (y2 - y1) / d, my - h * (x2 - x1) / d]);
        if (h > 1e-9) res.push([mx - h * (y2 - y1) / d, my + h * (x2 - x1) / d]);
      }
      return res;
    };
    const g = geomOf(e);
    for (const k of this.allEnts(false)) {
      if (k.id === e.id) continue;
      for (const p of ptsOf(g, geomOf(k))) {
        // both must actually contain p
        const onE = this.nearestOnEnt(e, p[0], p[1]), onK = this.nearestOnEnt(k, p[0], p[1]);
        const tol = 1e-6 * Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
        if (onE.d > tol || onK.d > tol) continue;
        out.push({ t: onE.t, by: k.id, p });
      }
    }
    return out;
  }
  trimPlan(eid, P) {
    if (!P) return null;
    const e = getEnt(this.sk, eid);
    if (!e || e.virt) return null;
    const tc = this.nearestOnEnt(e, P[0], P[1]).t;
    const cuts = this.cuts(e);
    const eps = 1e-6;
    if (e.t === 'circle') {
      const angs = cuts.map(c => ({ ...c, t: ((c.t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) }));
      const uniq = [];
      for (const c of angs.sort((a, b) => a.t - b.t)) if (!uniq.length || c.t - uniq[uniq.length - 1].t > eps) uniq.push(c);
      if (uniq.length > 1 && 2 * Math.PI - uniq[uniq.length - 1].t + uniq[0].t < eps) uniq.pop();
      if (uniq.length < 2) return { e, del: true };
      const t = ((tc % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let i = uniq.findIndex(c => c.t > t);
      const hi = i < 0 ? uniq[0] : uniq[i], lo = i <= 0 ? uniq[uniq.length - 1] : uniq[i - 1];
      return { e, lo, hi };
    }
    const inner = cuts.filter(c => c.t > eps && c.t < 1 - eps).sort((a, b) => a.t - b.t);
    let lo = null, hi = null;
    for (const c of inner) { if (c.t <= tc) lo = c; else if (!hi) hi = c; }
    if (!lo && !hi) return { e, del: true };
    return { e, lo, hi };
  }
  click_trim(x, y) {
    const h = this.hitTest(x, y, { dims: false, glyphs: false, points: false, axes: false });
    if (!h || h.kind !== 'e') return;
    const plan = this.trimPlan(h.id, this.loc(x, y));
    if (!plan) return;
    this.begin();
    this.doTrim(plan);
    this.trimPreview = null;
    this.commit();
  }
  doTrim(plan) {
    const sk = this.sk, e = sk.ents.find(k => k.id === plan.e.id);
    const del = () => { sk.ents = sk.ents.filter(k => k.id !== e.id); };
    if (plan.del) { del(); return; }
    const mk = (c) => { const id = this.newPid(); sk.pts[id] = { x: c.p[0], y: c.p[1] }; sk.cons.push({ id: this.newCid(), t: 'on', p: id, e: c.by }); return id; };
    if (e.t === 'line') {
      if (plan.lo && plan.hi) {
        const pLo = mk(plan.lo), pHi = mk(plan.hi);
        const e2 = { id: this.newEid(), t: 'line', a: pHi, b: e.b }; if (e.cons) e2.cons = true;
        e.b = pLo; sk.ents.push(e2);
        sk.cons.push({ id: this.newCid(), t: 'col', e1: e.id, e2: e2.id });
      } else if (plan.lo) { e.b = mk(plan.lo); }
      else { e.a = mk(plan.hi); }
      return;
    }
    if (e.t === 'circle') {
      const pLo = mk(plan.lo), pHi = mk(plan.hi);
      e.t = 'arc'; e.a = pHi; e.b = pLo; delete e.r;
      return;
    }
    // arc
    if (plan.lo && plan.hi) {
      const pLo = mk(plan.lo), pHi = mk(plan.hi);
      const e2 = { id: this.newEid(), t: 'arc', c: e.c, a: pHi, b: e.b }; if (e.cons) e2.cons = true;
      e.b = pLo; sk.ents.push(e2);
      sk.cons.push({ id: this.newCid(), t: 'eq', e1: e.id, e2: e2.id });
    } else if (plan.lo) e.b = mk(plan.lo);
    else e.a = mk(plan.hi);
  }

  // ---------- sketch mirror ----------
  click_smirror(x, y) {
    const h = this.hitTest(x, y, { dims: false, glyphs: false, points: false, only: (e) => e.t === 'line' });
    if (!h) { this.app.toast('Click a straight line to mirror across.'); return; }
    const ents = this.selEnts().filter(id => id !== h.id);
    if (!ents.length) { this.setTool('select'); return; }
    this.begin();
    const res = this.mirrorEnts(ents, h.id);
    if (res !== true) { this.revert(); this.app.toast(res, 'bad'); this.setTool('select'); return; }
    this.commit();
    this.setTool('select');
  }
  mirrorEnts(ids, lineId) {
    const sk = this.sk, L = getEnt(sk, lineId);
    const A = getPt(sk, L.a), B = getPt(sk, L.b);
    const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
    const refl = (p) => { const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / l2; const fx = A.x + t * dx, fy = A.y + t * dy; return [2 * fx - p.x, 2 * fy - p.y]; };
    const onLine = (p) => Math.abs((p.x - A.x) * dy - (p.y - A.y) * dx) / Math.sqrt(l2) < 1e-6;
    const map = {}, cons = [];
    const mp = (pid) => {
      if (map[pid]) return map[pid];
      const p = getPt(sk, pid);
      if (pid === 'O' || onLine(p)) { map[pid] = pid; if (pid !== 'O' && !p.fixed && lineId !== 'XAX' && lineId !== 'YAX' && !sk.cons.some(c => c.t === 'on' && c.p === pid && c.e === lineId)) cons.push({ t: 'on', p: pid, e: lineId }); return pid; }
      const id = this.newPid(); const [x, y] = refl(p);
      sk.pts[id] = { x, y }; if (p.cons) sk.pts[id].cons = true;
      map[pid] = id;
      cons.push({ t: 'sym', p: pid, q: id, e: lineId });
      return id;
    };
    for (const id of ids) {
      const e = sk.ents.find(k => k.id === id);
      if (!e) continue;
      if (e.t === 'line') this.newEntRaw({ t: 'line', a: mp(e.a), b: mp(e.b), cons: e.cons });
      else if (e.t === 'circle') { const n = this.newEntRaw({ t: 'circle', c: mp(e.c), r: e.r, cons: e.cons }); cons.push({ t: 'eq', e1: e.id, e2: n.id }); }
      else { this.newEntRaw({ t: 'arc', c: mp(e.c), a: mp(e.b), b: mp(e.a), cons: e.cons, noR: true }); }
    }
    if (!this.addCons(cons, { auto: true })) return 'Couldn\'t mirror that.';
    return true;
  }
  newEntRaw(props) { const e = { id: this.newEid(), ...props }; if (!e.cons) delete e.cons; this.sk.ents.push(e); return e; }

  // ---------- construction toggle ----------
  toggleConstruction() {
    const ids = this.selEnts();
    if (!ids.length) { this.consMode = !this.consMode; this.app.toast(this.consMode ? 'Construction is on: new lines will be dashed helper lines.' : 'Construction is off.'); this.app.onToolChange(this.tool); return; }
    this.begin();
    const sk = this.sk;
    const anyNormal = ids.some(id => !sk.ents.find(e => e.id === id).cons);
    for (const id of ids) { const e = sk.ents.find(k => k.id === id); if (anyNormal) e.cons = true; else delete e.cons; }
    this.commit();
  }

  // ---------- use edges ----------
  useFace(loops, plane) {
    this.begin();
    const sk = this.sk;
    let made = 0;
    for (const loop of loops) {
      let pts = loop.map(p => toLocal(plane, p));
      // remove collinear points
      const clean = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const sc = hyp(b[0] - a[0], b[1] - a[1]) * hyp(c[0] - b[0], c[1] - b[1]);
        if (Math.abs(cr) > 1e-7 * Math.max(sc, 1e-12)) clean.push(b);
      }
      if (clean.length < 3) continue;
      const ids = clean.map(p => { const id = this.newPid(); sk.pts[id] = { x: p[0], y: p[1], fixed: true, ref: true }; return id; });
      for (let i = 0; i < ids.length; i++) { sk.ents.push({ id: this.newEid(), t: 'line', a: ids[i], b: ids[(i + 1) % ids.length], ref: true }); made++; }
    }
    if (!made) { this.revert(); this.app.toast('No outline found on that face.'); return; }
    this.commit();
    this.app.toast('Copied the outline as fixed reference lines. They won\'t move if the part changes later.');
    this.setTool('select');
  }

  // ---------- dimensions ----------
  click_dimension(x, y) {
    const h = this.hitTest(x, y, { dims: false, glyphs: false });
    const op = this.op;
    if (op && op.place && (!h || (op.picks.length >= 2))) { this.placeDim(); return; }
    if (!h) return;
    const sk = this.sk;
    const item = h.kind === 'p' ? { k: 'p', id: h.id } : { k: 'e', id: h.id, t: getEnt(sk, h.id).t };
    if (!op) {
      this.op = { picks: [item], place: item.k === 'e' };
      this.hint();
      return;
    }
    if (op.picks.some(p => p.id === item.id)) return;
    op.picks.push(item);
    op.place = true;
    if (!this.dimSpec()) { this.app.toast('I can\'t dimension those two together. Try two points, a point and a line, or two lines.'); op.picks.pop(); }
  }
  // Work out the dimension constraint from picks and mouse position
  dimSpec() {
    const op = this.op;
    if (!op) return null;
    const sk = this.sk;
    const P = this.mouse ? this.loc(this.mouse[0], this.mouse[1]) : null;
    if (!P) return null;
    const pk = op.picks;
    const ent = (id) => getEnt(sk, id);
    const ctr = (it) => it.k === 'p' ? it.id : ent(it.id).c;
    if (pk.length === 1) {
      const it = pk[0];
      if (it.k !== 'e') return null;
      const e = ent(it.id);
      if (e.t === 'line') { if (e.virt) return null; return this.distSpec(e.a, e.b, P, true); }
      if (e.t === 'circle') return { t: 'dia', e: e.id };
      return { t: 'rad', e: e.id };
    }
    const [a, b] = pk;
    const isLine = (it) => it.k === 'e' && ent(it.id).t === 'line';
    const isCirc = (it) => it.k === 'e' && ent(it.id).t !== 'line';
    if (a.k === 'p' && b.k === 'p') return this.distSpec(a.id, b.id, P);
    if ((a.k === 'p' && isLine(b)) || (isLine(a) && b.k === 'p')) {
      const p = a.k === 'p' ? a : b, l = ent(a.k === 'p' ? b.id : a.id);
      if (l.a === p.id || l.b === p.id) return this.distSpec(l.a, l.b, P, true);
      return this.plSpec(p.id, l);
    }
    if (isLine(a) && isLine(b)) {
      const l1 = ent(a.id), l2 = ent(b.id);
      const d1 = this.dirOf(l1), d2 = this.dirOf(l2);
      if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) < 0.02) {
        if (l1.virt && l2.virt) return null;
        return l1.virt ? this.plSpec(l2.a, l1) : this.plSpec(l1.a, l2);
      }
      return this.angSpec(l1, l2, P);
    }
    if ((isCirc(a) && b.k === 'p') || (a.k === 'p' && isCirc(b)) || (isCirc(a) && isCirc(b))) return this.distSpec(ctr(a), ctr(b), P);
    if ((isCirc(a) && isLine(b)) || (isLine(a) && isCirc(b))) {
      const c = isCirc(a) ? a : b, l = ent(isLine(a) ? a.id : b.id);
      return this.plSpec(ent(c.id).c, l);
    }
    return null;
  }
  dirOf(l) { const a = getPt(this.sk, l.a), b = getPt(this.sk, l.b); const len = hyp(b.x - a.x, b.y - a.y) || 1; return [(b.x - a.x) / len, (b.y - a.y) / len]; }
  distSpec(p, q, P, lineMode) {
    if (p === q) return null;
    const A = getPt(this.sk, p), B = getPt(this.sk, q);
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const hw = Math.abs(B.x - A.x) / 2, hh = Math.abs(B.y - A.y) / 2;
    const ox = Math.abs(P[0] - mx) - hw, oy = Math.abs(P[1] - my) - hh;
    let dir = null;
    if (!lineMode || (hw > 1e-9 && hh > 1e-9)) {
      if (ox > 0 || oy > 0) dir = oy > ox ? 'h' : 'v';
    }
    if (lineMode && !(hw > 1e-9 && hh > 1e-9)) dir = null;
    if (dir === 'h' && hw < 1e-9) dir = null;
    if (dir === 'v' && hh < 1e-9) dir = null;
    const c = { t: 'dist', p, q };
    if (dir) { c.dir = dir; c.s = dir === 'h' ? Math.sign(B.x - A.x) || 1 : Math.sign(B.y - A.y) || 1; }
    return c;
  }
  plSpec(p, l) {
    const c = { t: 'pldist', p, e: l.id, s: 1 };
    const v = measureDim(this.sk, c);
    if (Math.abs(v) < 1e-9) return null;
    c.s = v < 0 ? -1 : 1;
    return c;
  }
  angSpec(l1, l2, P) {
    const V = this.lineX(l1, l2);
    if (!V) return null;
    const d1 = this.dirOf(l1), d2 = this.dirOf(l2), w = [P[0] - V[0], P[1] - V[1]];
    const cr = (a, b) => a[0] * b[1] - a[1] * b[0];
    for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = [d1[0] * s1, d1[1] * s1], b = [d2[0] * s2, d2[1] * s2];
      const k = cr(a, b);
      if (Math.abs(k) < 1e-9) continue;
      if (Math.sign(cr(a, w)) === Math.sign(k) && Math.sign(cr(w, b)) === Math.sign(k)) return { t: 'ang', e1: l1.id, e2: l2.id, r1: s1 < 0, r2: s2 < 0 };
    }
    return { t: 'ang', e1: l1.id, e2: l2.id, r1: false, r2: false };
  }
  lineX(l1, l2) {
    const sk = this.sk;
    const a = getPt(sk, l1.a), b = getPt(sk, l1.b), c = getPt(sk, l2.a), d = getPt(sk, l2.b);
    const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(den) < 1e-12) return null;
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
    return [a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)];
  }
  dimAnchor(c) {
    const sk = this.sk;
    if (c.t === 'dist') { const A = getPt(sk, c.p), B = getPt(sk, c.q); return [(A.x + B.x) / 2, (A.y + B.y) / 2]; }
    if (c.t === 'pldist') { const A = getPt(sk, c.p), l = getEnt(sk, c.e); const f = this.foot(A, l); return [(A.x + f[0]) / 2, (A.y + f[1]) / 2]; }
    if (c.t === 'rad' || c.t === 'dia') { const e = getEnt(sk, c.e); const C = getPt(sk, e.c); return [C.x, C.y]; }
    if (c.t === 'ang') { const V = this.lineX(getEnt(sk, c.e1), getEnt(sk, c.e2)); return V || [0, 0]; }
    return [0, 0];
  }
  foot(A, l) {
    const a = getPt(this.sk, l.a), b = getPt(this.sk, l.b);
    const dx = b.x - a.x, dy = b.y - a.y, t = ((A.x - a.x) * dx + (A.y - a.y) * dy) / (dx * dx + dy * dy || 1);
    return [a.x + t * dx, a.y + t * dy];
  }
  placeDim() {
    const spec = this.dimSpec();
    if (!spec) { this.op = null; return; }
    const P = this.loc(this.mouse[0], this.mouse[1]);
    const anchor = this.dimAnchorFor(spec);
    spec.lab = [P[0] - anchor[0], P[1] - anchor[1]];
    const val = measureDim(this.sk, spec);
    spec.v = fmt(val, 3);
    this.op = null;
    this.begin();
    const added = this.addCons([spec], { dimDriven: true });
    if (!added || !added.length) { this.revert(); this.app.toast('Couldn\'t add that dimension.', 'bad'); return; }
    const c = added[0];
    this.commit();
    if (c.driven) { this.app.toast('Other rules already decide that size, so this dimension only measures it (in parentheses).'); return; }
    this.editDim(c.id, true);
  }
  dimAnchorFor(spec) { return this.dimAnchor(spec); }

  editDim(id, isNew) {
    const c = this.sk.cons.find(k => k.id === id);
    if (!c) return;
    if (c.driven) {
      this.app.toast('This is a reference dimension: it only measures. Delete it, or delete another rule, to make it drive.');
      return;
    }
    this.showInput(c, isNew);
  }
  showInput(c, isNew) {
    this.hideInput();
    const el = document.createElement('div');
    el.className = 'dimbox';
    el.innerHTML = `<input type="text" spellcheck="false" autocomplete="off" aria-label="Dimension value"><div class="dimmsg">Enter a number or a formula like #width/2. Press Enter.</div>`;
    this.view.host.appendChild(el);
    const inp = el.querySelector('input');
    inp.value = c.v;
    this.inputEl = inp; this.inputBox = el; this.inputCon = c.id;
    const pos = () => { const L = c._lab || this.dimAnchor(c); const [x, y] = this.scr(L[0], L[1]); el.style.left = Math.round(x - 60) + 'px'; el.style.top = Math.round(y - 16) + 'px'; };
    pos();
    this.inputPos = pos;
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.applyInput(); }
      if (e.key === 'Escape') { e.preventDefault(); this.hideInput(); }
    });
    inp.addEventListener('input', () => {
      const m = el.querySelector('.dimmsg');
      const t = inp.value.trim();
      const asg = /^#?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(t);
      try {
        const v = evaluate(asg ? asg[2] : t, this.values);
        m.textContent = asg ? `Makes #${asg[1]} = ${fmt(v, 3)} and uses it here` : `= ${fmt(v, 3)}${c.t === 'ang' ? '°' : ' mm'}`;
        m.classList.remove('bad');
      } catch (er) { m.textContent = er.message; m.classList.add('bad'); }
    });
  }
  hideInput() { if (this.inputBox) { this.inputBox.remove(); this.inputBox = null; this.inputEl = null; this.inputCon = null; this.inputPos = null; } }
  applyInput() {
    const id = this.inputCon, inp = this.inputEl;
    if (!id || !inp) return;
    const t = inp.value.trim();
    const msg = this.inputBox.querySelector('.dimmsg');
    const sk = this.sk;
    const c = sk.cons.find(k => k.id === id);
    if (!c) { this.hideInput(); return; }
    let expr = t;
    const asg = /^#?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(t);
    const docBefore = JSON.stringify(this.app.doc.vars);
    if (asg) {
      if (!VAR_NAME_RE.test(asg[1])) { msg.textContent = 'Names use letters, numbers and _'; msg.classList.add('bad'); return; }
      const ex = this.app.doc.vars.find(v => v.name === asg[1]);
      if (ex) ex.expr = asg[2]; else this.app.doc.vars.push({ name: asg[1], expr: asg[2] });
      this.app.reevalVars();
      expr = '#' + asg[1];
    }
    try {
      const v = evaluate(expr, this.values);
      if ((c.t !== 'ang' && c.t !== 'pldist' && !(c.t === 'dist' && c.dir)) && v <= 0) throw new Error('Must be more than 0');
      if (c.t === 'ang' && (v <= 0 || v >= 180)) throw new Error('Angles must be between 0 and 180');
    } catch (er) {
      msg.textContent = er.message; msg.classList.add('bad');
      if (asg) { this.app.doc.vars = JSON.parse(docBefore); this.app.reevalVars(); }
      return;
    }
    this.begin();
    const old = c.v;
    c.v = expr;
    const r = solveSketch(sk, this.values);
    if (!r.ok) {
      c.v = old;
      solveSketch(sk, this.values);
      if (asg) { this.app.doc.vars = JSON.parse(docBefore); this.app.reevalVars(); }
      msg.textContent = 'Can\'t make it that size: other rules hold the shape. Try a different number.'; msg.classList.add('bad');
      return;
    }
    this.hideInput();
    this.commit();
    if (asg) this.app.renderVars();
  }

  // ---------- constraint tools ----------
  applyConstraint(type) {
    this.cancelOp();
    if (this.tool !== 'select') { this.tool = 'select'; this.app.onToolChange('select'); }
    const items = [...this.sel].filter(k => k[0] !== 'c').map(k => ({ k: k[0], id: k.slice(2) }));
    const res = this.tryConstraint(type, items);
    if (res === 'need') { this.pick = { type, items }; this.hint(); this.view.request(); return; }
    this.pick = null;
    this.hint();
  }
  pickHint() {
    const H = { coin: 'Pick two points, or a point and a line or circle.', h: 'Pick a line, or two points.', v: 'Pick a line, or two points.', par: 'Pick two lines.', perp: 'Pick two lines.', tan: 'Pick a line or arc, and a circle or arc.', eq: 'Pick two lines, or two circles or arcs.', mid: 'Pick a point and a line.', conc: 'Pick two circles or arcs.', sym: 'Pick two points, then the line to mirror across.', fix: 'Pick the points to pin.' };
    return (H[this.pick.type] || '') + ' (' + this.pick.items.length + ' picked; Esc to stop)';
  }
  pickClick(x, y, e) {
    const h = this.hitTest(x, y, { dims: false, glyphs: false });
    if (!h) return;
    const p = this.pick;
    if (!p.items.some(i => i.id === h.id)) p.items.push({ k: h.kind, id: h.id });
    this.sel.add(h.kind + ':' + h.id);
    const res = this.tryConstraint(p.type, p.items);
    if (res !== 'need') { this.pick = null; }
    this.hint();
    this.view.request();
  }
  // returns 'need' if more picks are needed
  tryConstraint(type, items) {
    const sk = this.sk;
    const E = (id) => getEnt(sk, id);
    const pts = items.filter(i => i.k === 'p').map(i => i.id);
    const ents = items.filter(i => i.k === 'e').map(i => E(i.id)).filter(Boolean);
    const lines = ents.filter(e => e.t === 'line'), circs = ents.filter(e => e.t !== 'line');
    const list = [];
    let special = null;
    switch (type) {
      case 'h': case 'v':
        if (lines.length) lines.filter(l => !l.virt).forEach(l => list.push({ t: type, e: l.id }));
        else if (pts.length >= 2) list.push({ t: type, p: pts[0], q: pts[1] });
        else return 'need';
        break;
      case 'par': case 'perp':
        if (lines.length < 2) return 'need';
        for (let i = 1; i < lines.length; i++) list.push({ t: type, e1: lines[0].id, e2: lines[i].id });
        break;
      case 'eq':
        if (lines.length >= 2) for (let i = 1; i < lines.length; i++) list.push({ t: 'eq', e1: lines[0].id, e2: lines[i].id });
        else if (circs.length >= 2) for (let i = 1; i < circs.length; i++) list.push({ t: 'eq', e1: circs[0].id, e2: circs[i].id });
        else return 'need';
        break;
      case 'tan': {
        if (ents.length < 2) return 'need';
        const [a, b] = ents;
        if (a.t === 'line' && b.t === 'line') { this.app.toast('Tangent needs at least one circle or arc.'); return 'fail'; }
        const shared = [a.a, a.b].filter(p => p && (p === b.a || p === b.b))[0];
        const c = { t: 'tan', e1: a.id, e2: b.id };
        if (shared) c.at = shared;
        else if (a.t === 'line' || b.t === 'line') {
          const l = a.t === 'line' ? a : b, k = a.t === 'line' ? b : a;
          const C = getPt(sk, k.c), A = getPt(sk, l.a), B = getPt(sk, l.b);
          const sd = ((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x));
          c.s = sd >= 0 ? 1 : -1;
        } else {
          const c1 = getPt(sk, a.c), c2 = getPt(sk, b.c);
          const d = hyp(c2.x - c1.x, c2.y - c1.y), r1 = radiusOf(sk, a), r2 = radiusOf(sk, b);
          c.s = Math.abs(d - (r1 + r2)) <= Math.abs(d - Math.abs(r1 - r2)) ? 1 : -1;
        }
        list.push(c);
        break;
      }
      case 'mid':
        if (!pts.length || !lines.filter(l => !l.virt).length) return 'need';
        list.push({ t: 'mid', p: pts[0], e: lines.filter(l => !l.virt)[0].id });
        break;
      case 'sym':
        if (pts.length < 2 || !lines.length) return 'need';
        list.push({ t: 'sym', p: pts[0], q: pts[1], e: lines[0].id });
        break;
      case 'coin':
        if (pts.length >= 2) special = () => this.mergePts(pts[0], pts[1]);
        else if (pts.length === 1 && ents.length) {
          const e = ents[0];
          if ([e.a, e.b, e.c].includes(pts[0])) { this.app.toast('That point already belongs to that line.'); return 'fail'; }
          list.push({ t: 'on', p: pts[0], e: e.id });
        } else return 'need';
        break;
      case 'conc':
        if (circs.length < 2) return 'need';
        special = () => this.mergePts(circs[0].c, circs[1].c);
        break;
      case 'fix': {
        const ids = new Set(pts);
        ents.forEach(e => [e.a, e.b, e.c].forEach(p => p && ids.add(p)));
        if (!ids.size) return 'need';
        special = () => { ids.forEach(id => { if (sk.pts[id]) sk.pts[id].fixed = true; }); return true; };
        break;
      }
    }
    this.begin();
    if (special) {
      const r = special();
      if (r !== true) { this.revert(); this.app.toast(r || 'Couldn\'t do that.', 'bad'); return 'fail'; }
      this.commit(); this.sel.clear(); this.app.onSelChange();
      return 'done';
    }
    // redundancy check
    const usable = [];
    for (const c of list) {
      c.id = this.newCid();
      let red;
      try { red = testAdd(sk, this.values, c).redundant; } catch (e) { red = true; }
      if (!red) { sk.cons.push(c); usable.push(c); }
    }
    if (!usable.length) { this.revert(); this.app.toast('That is already decided by the other rules (it would over-define the sketch).'); return 'fail'; }
    const r = solveSketch(sk, this.values);
    if (!r.ok) { this.revert(); this.app.toast('That rule fights the other rules, so I undid it.', 'bad'); return 'fail'; }
    this.commit();
    this.sel.clear(); this.app.onSelChange();
    return 'done';
  }
  mergePts(keep, drop) {
    const sk = this.sk;
    if (keep === drop) return 'Those are the same point.';
    if (drop === 'O' || (sk.pts[drop] && sk.pts[drop].fixed && !(sk.pts[keep] && sk.pts[keep].fixed))) [keep, drop] = [drop, keep];
    if (drop === 'O') return 'Can\'t move the origin.';
    if (sk.pts[drop] && sk.pts[drop].fixed && (keep === 'O' || sk.pts[keep]?.fixed)) return 'Both points are fixed.';
    for (const e of sk.ents) for (const k of ['a', 'b', 'c']) if (e[k] === drop) e[k] = keep;
    for (const c of sk.cons) for (const k of ['p', 'q', 'p1', 'q1', 'p2', 'q2', 'at']) if (c[k] === drop) c[k] = keep;
    if (sk.pts[keep] && sk.pts[drop]?.std) sk.pts[keep].std = true;
    if (sk.pts[keep] && sk.pts[drop] && !sk.pts[drop].cons) delete sk.pts[keep].cons;
    delete sk.pts[drop];
    // drop degenerate constraints
    sk.cons = sk.cons.filter(c => !(c.t === 'dist' && c.p === c.q) && !(c.t === 'h' && c.p && c.p === c.q) && !(c.t === 'v' && c.p && c.p === c.q));
    this.cleanup();
    // duplicate on-constraints become redundant; remove any that are redundant now
    const r = solveSketch(sk, this.values);
    if (!r.ok) return 'Joining those points fights the other rules.';
    this.pruneRedundant();
    return true;
  }
  pruneRedundant() {
    const sk = this.sk;
    const st = dofStatus(sk, this.values);
    if (st.redundant <= 0) return;
    // remove constraints one at a time (latest first) while redundancy remains
    for (let i = sk.cons.length - 1; i >= 0 && st.redundant > 0; i--) {
      const c = sk.cons[i];
      if (c.driven) continue;
      sk.cons.splice(i, 1);
      const s2 = dofStatus(sk, this.values);
      if (s2.redundant < st.redundant && s2.dof === st.dof) { st.redundant = s2.redundant; }
      else sk.cons.splice(i, 0, c);
    }
  }

  deleteSel() {
    const sk = this.sk;
    if (!this.sel.size) return;
    this.begin();
    const ents = new Set(this.selEnts()), cons = new Set(this.selCons()), pts = this.selPts();
    for (const id of cons) {
      const c = sk.cons.find(k => k.id === id);
      if (c && c.t === 'fixpt') { if (sk.pts[c.p]) delete sk.pts[c.p].fixed; }
    }
    sk.cons = sk.cons.filter(c => !cons.has(c.id));
    for (const id of [...cons]) if (id.startsWith('fix:')) { const p = id.slice(4); if (sk.pts[p]) delete sk.pts[p].fixed; }
    sk.ents = sk.ents.filter(e => !ents.has(e.id));
    for (const p of pts) {
      const used = sk.ents.some(e => e.a === p || e.b === p || e.c === p);
      if (!used && sk.pts[p]) delete sk.pts[p];
    }
    this.sel.clear();
    this.cleanup();
    this.commit();
    this.app.onSelChange();
  }

  key(e) {
    const k = e.key;
    if (k === 'Escape') {
      if (this.pick) { this.pick = null; this.sel.clear(); this.hint(); this.view.request(); return true; }
      if (this.op) { this.op = null; this.hint(); this.view.request(); return true; }
      if (this.tool !== 'select') { this.setTool('select'); return true; }
      this.sel.clear(); this.app.onSelChange(); this.view.request(); return true;
    }
    if (k === 'Delete' || k === 'Backspace') { this.deleteSel(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const map = { l: 'line', r: 'rect', R: 'rectc', c: 'circle', a: 'arc3', t: 'arct', d: 'dimension', f: 'fillet', x: 'trim', u: 'use' };
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'q' || k === 'Q') { this.toggleConstruction(); return true; }
    const cmap = { h: 'h', v: 'v', i: 'coin', b: 'par', e: 'eq' };
    if (cmap[k]) { this.applyConstraint(cmap[k]); return true; }
    return false;
  }

  // ---------- drawing ----------
  draw(ctx) {
    const sk = this.sk;
    if (!sk || !this.plane) return;
    const st = this.status;
    const px = this.px();
    // grid
    this.drawGrid(ctx);
    // axes
    const W = this.view.W, H = this.view.H;
    const axisLine = (dx, dy, col) => {
      const big = 1e5;
      const [x1, y1] = this.scr(-dx * big, -dy * big), [x2, y2] = this.scr(dx * big, dy * big);
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    };
    const hovAxis = (id) => this.hover === 'e:' + id || this.sel.has('e:' + id);
    axisLine(1, 0, hovAxis('XAX') ? COL.sel : 'rgba(217,68,58,.55)');
    axisLine(0, 1, hovAxis('YAX') ? COL.sel : 'rgba(47,158,68,.55)');
    // regions (light fill for closed shapes that will become solid)
    if (this.regions) {
      ctx.fillStyle = 'rgba(31,111,209,0.07)';
      for (const r of this.regions.regions) {
        if (r.depth % 2) continue;
        ctx.beginPath();
        for (const loop of [r.outer, ...r.holes]) loop.forEach((p, i) => { const [x, y] = this.scr(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.fill('evenodd');
      }
    }
    // entities
    const entColor = (e) => {
      const k = 'e:' + e.id;
      if (this.sel.has(k)) return COL.sel;
      if (this.hover === k) return COL.hov;
      if (e.ref) return COL.ref;
      if (st && st.entDef && st.entDef[e.id]) return COL.def;
      return COL.free;
    };
    for (const e of sk.ents) {
      const pl = entPolyline(sk, e, 0.3);
      ctx.strokeStyle = entColor(e);
      const isSel = this.sel.has('e:' + e.id) || this.hover === 'e:' + e.id;
      ctx.lineWidth = isSel ? 3 : e.cons ? 1.3 : 2;
      ctx.setLineDash(e.cons ? [7, 5] : []);
      ctx.beginPath();
      pl.forEach((p, i) => { const [x, y] = this.scr(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // trim preview
    if (this.tool === 'trim' && this.trimPreview) this.drawTrimPreview(ctx, this.trimPreview);
    // open ends
    if (this.regions) {
      for (const p of this.regions.openPts) {
        const [x, y] = this.scr(p[0], p[1]);
        ctx.strokeStyle = COL.bad; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // points
    const used = new Set();
    for (const e of sk.ents) [e.a, e.b, e.c].forEach(p => p && used.add(p));
    for (const id in sk.pts) {
      const p = sk.pts[id];
      const [x, y] = this.scr(p.x, p.y);
      const k = 'p:' + id;
      const def = st && st.ptDef ? st.ptDef[id] : false;
      let col = this.sel.has(k) ? COL.sel : this.hover === k ? COL.hov : p.ref ? COL.ref : def ? COL.def : COL.free;
      const r = this.sel.has(k) || this.hover === k ? 4.5 : 3;
      if (p.sharp) { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke(); continue; }
      ctx.fillStyle = col;
      if (p.cons && !p.std) { ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
      if (p.fixed && !p.ref) this.drawPin(ctx, x, y);
    }
    // origin
    {
      const [x, y] = this.scr(0, 0);
      const hov = this.hover === 'p:O' || this.sel.has('p:O');
      ctx.fillStyle = hov ? COL.sel : '#1e293b'; ctx.beginPath(); ctx.arc(x, y, hov ? 5 : 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, hov ? 5 : 4, 0, Math.PI * 2); ctx.stroke();
    }
    this.drawDims(ctx);
    this.drawGlyphs(ctx);
    this.drawPreview(ctx);
    if (this.box) {
      const b = this.box;
      ctx.fillStyle = 'rgba(242,140,40,.08)'; ctx.strokeStyle = COL.sel; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.setLineDash([]);
    }
    if (this.inputPos) this.inputPos();
  }
  drawPin(ctx, x, y) {
    ctx.save(); ctx.strokeStyle = '#7c2d12'; ctx.fillStyle = '#ea580c'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x + 9, y - 13); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + 10, y - 14, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  drawGrid(ctx) {
    const s = this.gridStep();
    const W = this.view.W, H = this.view.H;
    const c0 = this.loc(0, 0), c1 = this.loc(W, H), c2 = this.loc(W, 0), c3 = this.loc(0, H);
    if (!c0 || !c1 || !c2 || !c3) return;
    const us = [c0[0], c1[0], c2[0], c3[0]], vs = [c0[1], c1[1], c2[1], c3[1]];
    const u0 = Math.floor(Math.min(...us) / s), u1 = Math.ceil(Math.max(...us) / s), v0 = Math.floor(Math.min(...vs) / s), v1 = Math.ceil(Math.max(...vs) / s);
    if ((u1 - u0) * (v1 - v0) > 40000 || u1 - u0 > 600 || v1 - v0 > 600) return;
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? 'rgba(80,100,130,.16)' : 'rgba(80,100,130,.07)';
      ctx.beginPath();
      for (let i = u0; i <= u1; i++) { if ((i % 5 === 0) !== !!pass) continue; const [x1, y1] = this.scr(i * s, v0 * s), [x2, y2] = this.scr(i * s, v1 * s); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      for (let j = v0; j <= v1; j++) { if ((j % 5 === 0) !== !!pass) continue; const [x1, y1] = this.scr(u0 * s, j * s), [x2, y2] = this.scr(u1 * s, j * s); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      ctx.stroke();
    }
  }
  drawTrimPreview(ctx, plan) {
    const e = plan.e;
    let pts;
    if (plan.del) pts = entPolyline(this.sk, e, 0.3);
    else if (e.t === 'line') {
      const t0 = plan.lo ? plan.lo.t : 0, t1 = plan.hi ? plan.hi.t : 1;
      pts = [this.paramPoint(e, t0), this.paramPoint(e, t1)];
    } else if (e.t === 'circle') {
      let a0 = plan.lo.t, a1 = plan.hi.t; if (a1 < a0) a1 += 2 * Math.PI;
      pts = []; for (let i = 0; i <= 40; i++) pts.push(this.paramPoint(e, a0 + (a1 - a0) * i / 40));
    } else {
      const t0 = plan.lo ? plan.lo.t : 0, t1 = plan.hi ? plan.hi.t : 1;
      pts = []; for (let i = 0; i <= 40; i++) pts.push(this.paramPoint(e, t0 + (t1 - t0) * i / 40));
    }
    ctx.strokeStyle = COL.bad; ctx.lineWidth = 4; ctx.globalAlpha = 0.75;
    ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = this.scr(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  arrow(ctx, x, y, dx, dy) {
    const l = hyp(dx, dy) || 1; dx /= l; dy /= l;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * 9 - dy * 3.5, y - dy * 9 + dx * 3.5); ctx.lineTo(x - dx * 9 + dy * 3.5, y - dy * 9 - dx * 3.5); ctx.closePath(); ctx.fill();
  }
  dimText(c) {
    const v = measureDim(this.sk, c);
    let s = c.t === 'ang' ? fmt(v) + '°' : c.t === 'dia' ? 'Ø' + fmt(v) : c.t === 'rad' ? 'R' + fmt(v) : fmt(Math.abs(v));
    if (c.driven) return '(' + s + ')';
    if (!isPlainNumber(c.v)) s = s + ' = ' + c.v;
    return s;
  }
  drawDims(ctx) {
    const sk = this.sk;
    ctx.font = '600 12.5px "Atkinson Hyperlegible", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const dimsList = sk.cons.filter(isDim);
    if (this.op && this.tool === 'dimension' && this.op.place) {
      const spec = this.dimSpec();
      if (spec) {
        const P = this.loc(this.mouse[0], this.mouse[1]);
        const a = this.dimAnchor(spec);
        dimsList.push({ ...spec, id: '_preview', lab: [P[0] - a[0], P[1] - a[1]], v: '0', _preview: true });
      }
    }
    for (const c of dimsList) {
      try { this.drawDim(ctx, c); } catch (e) { /* skip broken */ }
    }
  }
  drawDim(ctx, c) {
    const sk = this.sk;
    const sel = this.sel.has('c:' + c.id) || this.hover === 'c:' + c.id;
    const col = c._preview ? COL.sel : sel ? COL.sel : c.driven ? COL.drv : COL.dim;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    const anchor = this.dimAnchor(c);
    const lab = c.lab || [0, 10];
    const L = [anchor[0] + lab[0], anchor[1] + lab[1]];
    const S = (p) => this.scr(p[0], p[1]);
    const line = (p, q) => { const [x1, y1] = S(p), [x2, y2] = S(q); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    const arrowAt = (p, toward) => { const [x, y] = S(p), [tx, ty] = S(toward); this.arrow(ctx, x, y, x - tx, y - ty); };
    if (c.t === 'dist' || c.t === 'pldist') {
      let A, B;
      if (c.t === 'dist') { const a = getPt(sk, c.p), b = getPt(sk, c.q); A = [a.x, a.y]; B = [b.x, b.y]; }
      else { const a = getPt(sk, c.p); A = [a.x, a.y]; B = this.foot(a, getEnt(sk, c.e)); }
      let d;
      if (c.dir === 'h') d = [1, 0]; else if (c.dir === 'v') d = [0, 1];
      else { const l = hyp(B[0] - A[0], B[1] - A[1]) || 1; d = [(B[0] - A[0]) / l, (B[1] - A[1]) / l]; }
      const n = [-d[1], d[0]];
      const hA = (L[0] - A[0]) * n[0] + (L[1] - A[1]) * n[1], hB = (L[0] - B[0]) * n[0] + (L[1] - B[1]) * n[1];
      const A2 = [A[0] + n[0] * hA, A[1] + n[1] * hA], B2 = [B[0] + n[0] * hB, B[1] + n[1] * hB];
      const ext = this.px() * 4;
      line(A, [A2[0] + n[0] * Math.sign(hA) * ext, A2[1] + n[1] * Math.sign(hA) * ext]);
      line(B, [B2[0] + n[0] * Math.sign(hB) * ext, B2[1] + n[1] * Math.sign(hB) * ext]);
      line(A2, B2);
      const len = hyp(B2[0] - A2[0], B2[1] - A2[1]);
      if (len > this.px() * 24) { arrowAt(A2, B2); arrowAt(B2, A2); }
      // label along the dimension line, slid to the label point
      const t = (L[0] - A2[0]) * d[0] + (L[1] - A2[1]) * d[1];
      const T = [A2[0] + d[0] * t, A2[1] + d[1] * t];
      if (t < 0 || t > len) line(t < 0 ? A2 : B2, T);
      this.label(ctx, c, T, col);
    } else if (c.t === 'rad' || c.t === 'dia') {
      const e = getEnt(sk, c.e), C = getPt(sk, e.c), r = radiusOf(sk, e);
      const w = [L[0] - C.x, L[1] - C.y], wl = hyp(w[0], w[1]) || 1, u = [w[0] / wl, w[1] / wl];
      const edge = [C.x + u[0] * r, C.y + u[1] * r];
      if (c.t === 'dia') { const opp = [C.x - u[0] * r, C.y - u[1] * r]; line(opp, wl > r ? L : edge); arrowAt(edge, [C.x, C.y]); arrowAt(opp, [C.x, C.y]); }
      else { line([C.x, C.y], wl > r ? L : edge); arrowAt(edge, [C.x, C.y]); }
      this.label(ctx, c, L, col);
    } else if (c.t === 'ang') {
      const l1 = getEnt(sk, c.e1), l2 = getEnt(sk, c.e2);
      const V = this.lineX(l1, l2);
      if (!V) return;
      const d1 = this.dirOf(l1).map(v => v * (c.r1 ? -1 : 1)), d2 = this.dirOf(l2).map(v => v * (c.r2 ? -1 : 1));
      const R = hyp(L[0] - V[0], L[1] - V[1]);
      let a1 = Math.atan2(d1[1], d1[0]), a2 = Math.atan2(d2[1], d2[0]);
      let sw = a2 - a1; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
      const pts = []; for (let i = 0; i <= 32; i++) { const a = a1 + sw * i / 32; pts.push([V[0] + R * Math.cos(a), V[1] + R * Math.sin(a)]); }
      ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = S(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
      arrowAt(pts[0], pts[2]); arrowAt(pts[32], pts[30]);
      // extension from line ends if needed
      const mid = [V[0] + R * Math.cos(a1 + sw / 2), V[1] + R * Math.sin(a1 + sw / 2)];
      this.label(ctx, c, mid, col);
    }
  }
  label(ctx, c, P, col) {
    const s = this.dimText(c);
    const [x, y] = this.scr(P[0], P[1]);
    const w = ctx.measureText(s).width + 10;
    c._lab = [P[0], P[1]]; c._w = w;
    const sk = this.sk;
    const real = sk.cons.find(k => k.id === c.id);
    if (real) { real._lab = c._lab; real._w = w; }
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    const r = 4, h = 18;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, r) : ctx.rect(x - w / 2, y - h / 2, w, h); ctx.fill(); if (!isPlainNumber(c.v) && !c.driven) ctx.stroke();
    ctx.fillStyle = col; ctx.fillText(s, x, y + 0.5);
    ctx.restore();
  }
  drawGlyphs(ctx) {
    const sk = this.sk;
    this.glyphs = [];
    const counts = {};
    const sym = { h: 'H', v: 'V', par: '∥', perp: '⊥', tan: 'T', eq: '=', eqd: '=', mid: 'M', sym: '⇋', on: '•', col: '≡' };
    ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const place = (key, P, id, label) => {
      const n = (counts[key] = (counts[key] || 0) + 1) - 1;
      const x = P[0] + 14 + n * 15, y = P[1] - 14;
      this.glyphs.push({ x, y, id });
      const sel = this.sel.has('c:' + id) || this.hover === 'c:' + id;
      ctx.fillStyle = sel ? COL.sel : 'rgba(255,255,255,.95)';
      ctx.strokeStyle = sel ? COL.sel : '#94a3b8'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 6.5, y - 6.5, 13, 13, 3) : ctx.rect(x - 6.5, y - 6.5, 13, 13); ctx.fill(); ctx.stroke();
      ctx.fillStyle = sel ? '#fff' : '#334155'; ctx.fillText(label, x, y + 0.5);
    };
    const midOf = (eid) => { const e = getEnt(sk, eid); if (!e || e.virt) return null; const pl = entPolyline(sk, e, 0.2); const m = pl[Math.floor(pl.length / 2)]; if (e.t === 'line') { const a = getPt(sk, e.a), b = getPt(sk, e.b); return this.scr((a.x + b.x) / 2, (a.y + b.y) / 2); } return this.scr(m[0], m[1]); };
    if (!this.app.showGlyphs) return;
    for (const c of sk.cons) {
      if (isDim(c)) continue;
      const g = sym[c.t]; if (!g) continue;
      if (c.t === 'on' && sk.pts[c.p]?.sharp) continue;
      let P = null, key;
      if (c.e && !c.p) { P = midOf(c.e); key = c.e; }
      else if (c.t === 'h' || c.t === 'v') { const a = getPt(sk, c.p); P = this.scr(a.x, a.y); key = c.p; }
      else if (c.e1) { P = midOf(c.e1); key = c.e1; if (c.t !== 'col' && c.t !== 'tan') { const P2 = midOf(c.e2); if (P2) place(c.e2, P2, c.id, g); } if (c.t === 'tan' && c.at) { const a = getPt(sk, c.at); P = this.scr(a.x, a.y); key = c.at; } }
      else if (c.p) { const a = getPt(sk, c.p); if (!a) continue; P = this.scr(a.x, a.y); key = c.p; if (c.t === 'sym') { const b = getPt(sk, c.q); place(c.q, this.scr(b.x, b.y), c.id, g); } }
      else if (c.p1) { const a = getPt(sk, c.p1), b = getPt(sk, c.q1); P = this.scr((a.x + b.x) / 2, (a.y + b.y) / 2); key = c.p1 + c.q1; }
      if (P) place(key, P, c.id, g);
    }
    for (const id in sk.pts) {
      const p = sk.pts[id];
      if (!p.fixed || p.ref) continue;
      const [x, y] = this.scr(p.x, p.y);
      place(id, [x, y + 26], 'fix:' + id, '⚲');
    }
  }
  drawPreview(ctx) {
    if (!this.mouse || this.tool === 'select') return;
    const [mx, my] = this.mouse;
    const op = this.op;
    const s = (this.tool === 'trim' || this.tool === 'fillet' || this.tool === 'dimension' || this.tool === 'smirror' || this.tool === 'use') ? null : this.snap(mx, my, { from: op && op.p ? op.p : null, exclude: op && op.pid ? [op.pid] : [] });
    ctx.strokeStyle = COL.sel; ctx.lineWidth = 1.6; ctx.setLineDash(this.consMode ? [7, 5] : []);
    const S = (u, v) => this.scr(u, v);
    const poly = (pts, close) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = S(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); if (close) ctx.closePath(); ctx.stroke(); };
    const circ = (c, r) => { const pts = []; for (let i = 0; i <= 64; i++) pts.push([c[0] + r * Math.cos(i / 64 * 2 * Math.PI), c[1] + r * Math.sin(i / 64 * 2 * Math.PI)]); poly(pts); };
    if (s) {
      // snap marker
      const [x, y] = S(s.u, s.v);
      ctx.save(); ctx.setLineDash([]);
      if (s.kind === 'pt') { ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke(); }
      else if (s.kind === 'mid') { ctx.fillStyle = COL.sel; ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 4); ctx.lineTo(x - 6, y + 4); ctx.closePath(); ctx.fill(); }
      else if (s.kind === 'on') { ctx.strokeStyle = COL.sel; ctx.lineWidth = 2; ctx.strokeRect(x - 5, y - 5, 10, 10); }
      else { ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke(); }
      if (s.hv) { ctx.fillStyle = COL.sel; ctx.font = '700 11px system-ui'; ctx.fillText(s.hv === 'h' ? 'H' : 'V', x + 14, y - 12); }
      ctx.restore();
      ctx.font = '600 11px system-ui'; ctx.fillStyle = '#475569'; ctx.textAlign = 'left';
      ctx.fillText(`${fmt(s.u, 2)}, ${fmt(s.v, 2)}`, x + 12, y + 16);
      ctx.textAlign = 'center';
    }
    if (!op) { ctx.setLineDash([]); return; }
    switch (this.tool) {
      case 'line': poly([op.p, [s.u, s.v]]); this.lenLabel(ctx, op.p, [s.u, s.v]); break;
      case 'rect': case 'rectc': {
        const s0 = op.s0; let x0, y0, x1, y1;
        if (this.tool === 'rectc') { const dx = Math.abs(s.u - s0.u), dy = Math.abs(s.v - s0.v); x0 = s0.u - dx; x1 = s0.u + dx; y0 = s0.v - dy; y1 = s0.v + dy; }
        else { x0 = s0.u; y0 = s0.v; x1 = s.u; y1 = s.v; }
        poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
        ctx.fillStyle = '#475569'; ctx.font = '600 11px system-ui';
        const [lx, ly] = S((x0 + x1) / 2, Math.max(y0, y1)); ctx.fillText(fmt(Math.abs(x1 - x0)) + ' × ' + fmt(Math.abs(y1 - y0)), lx, ly - 10);
        break;
      }
      case 'circle': { const r = hyp(s.u - op.c[0], s.v - op.c[1]); circ(op.c, r); this.lenLabel(ctx, op.c, [s.u, s.v], 'Ø' + fmt(2 * r)); break; }
      case 'arc3': {
        if (op.step === 1) { poly([[op.s0.u, op.s0.v], [s.u, s.v]]); break; }
        const P = this.loc(mx, my), a = [op.s0.u, op.s0.v], b = [op.s1.u, op.s1.v];
        const g = this.arcFrom3(a, b, P); if (!g) { poly([a, b]); break; }
        this.previewArc(g.c, g.ccw ? b : a, g.ccw ? a : b, poly);
        break;
      }
      case 'arcc': {
        const c = [op.sc.u, op.sc.v];
        if (op.step === 1) { poly([c, [s.u, s.v]]); break; }
        const P = this.loc(mx, my);
        const ang = Math.atan2(P[1] - c[1], P[0] - c[0]);
        let dA = ang - op.lastAng; while (dA > Math.PI) dA -= 2 * Math.PI; while (dA < -Math.PI) dA += 2 * Math.PI;
        op.sweep += dA; op.lastAng = ang;
        const a0 = Math.atan2(op.s0.v - c[1], op.s0.u - c[0]);
        const pts = []; const N = 48;
        let sw = ang - a0; if (op.sweep >= 0) { while (sw < 0) sw += 2 * Math.PI; } else { while (sw > 0) sw -= 2 * Math.PI; }
        for (let i = 0; i <= N; i++) { const t = a0 + sw * i / N; pts.push([c[0] + op.r * Math.cos(t), c[1] + op.r * Math.sin(t)]); }
        poly(pts);
        break;
      }
      case 'arct': {
        const g = this.tanArcGeom(op.p, op.d, [s.u, s.v]);
        if (!g) { poly([op.p, [s.u, s.v]]); break; }
        this.previewArc(g.c, g.ccw ? op.p : [s.u, s.v], g.ccw ? [s.u, s.v] : op.p, poly);
        break;
      }
      case 'polygon': {
        const c = [op.sc.u, op.sc.v], r = hyp(s.u - c[0], s.v - c[1]), a0 = Math.atan2(s.v - c[1], s.u - c[0]);
        const n = Math.max(3, Math.min(24, this.polySides | 0));
        const pts = []; for (let i = 0; i < n; i++) pts.push([c[0] + r * Math.cos(a0 + i * 2 * Math.PI / n), c[1] + r * Math.sin(a0 + i * 2 * Math.PI / n)]);
        poly(pts, true); ctx.setLineDash([5, 4]); circ(c, r); break;
      }
      case 'slot': {
        if (op.step === 1) { poly([[op.s0.u, op.s0.v], [s.u, s.v]]); break; }
        const g = this.slotGeom(op.s0, op.s1, this.loc(mx, my)); if (!g) break;
        const [p0, p1, p2, p3] = g.pts;
        this.previewArc([op.s0.u, op.s0.v], p0, p1, poly); poly([p1, p2]); this.previewArc([op.s1.u, op.s1.v], p2, p3, poly); poly([p3, p0]);
        break;
      }
    }
    ctx.setLineDash([]);
  }
  previewArc(c, a, b, poly) {
    const r = hyp(a[0] - c[0], a[1] - c[1]);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let sw = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0; while (sw <= 0) sw += 2 * Math.PI;
    const pts = []; for (let i = 0; i <= 48; i++) pts.push([c[0] + r * Math.cos(a0 + sw * i / 48), c[1] + r * Math.sin(a0 + sw * i / 48)]);
    poly(pts);
  }
  lenLabel(ctx, a, b, txt) {
    const [x, y] = this.scr((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    ctx.fillStyle = '#475569'; ctx.font = '600 11px system-ui';
    ctx.fillText(txt || fmt(hyp(b[0] - a[0], b[1] - a[1])), x, y - 10);
  }
}
