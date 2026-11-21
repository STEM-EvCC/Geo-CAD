// Sketch constraint system: residuals, damped Gauss-Newton solve (minimum-norm steps),
// and degrees-of-freedom analysis (which geometry is fully defined).
import { evaluate } from './expr.js';

export const VIRTUAL_PTS = { O: { x: 0, y: 0, fixed: true, virt: true }, XE: { x: 1, y: 0, fixed: true, virt: true }, YE: { x: 0, y: 1, fixed: true, virt: true } };
export const VIRTUAL_ENTS = { XAX: { id: 'XAX', t: 'line', a: 'O', b: 'XE', cons: true, virt: true }, YAX: { id: 'YAX', t: 'line', a: 'O', b: 'YE', cons: true, virt: true } };

export function getPt(sk, id) { return VIRTUAL_PTS[id] || sk.pts[id]; }
export function getEnt(sk, id) { return VIRTUAL_ENTS[id] || sk.ents.find(e => e.id === id); }

export const DIM_TYPES = new Set(['dist', 'pldist', 'rad', 'dia', 'ang']);
export function isDim(c) { return DIM_TYPES.has(c.t); }

// Build an indexed system over the free variables of a sketch.
export function buildSystem(sk, dimValues) {
  const vi = {};           // var key -> index
  const X0 = [];
  const add = (key, val) => { vi[key] = X0.length; X0.push(val); };
  for (const id in sk.pts) {
    const p = sk.pts[id];
    if (!p.fixed) { add(id + '.x', p.x); add(id + '.y', p.y); }
  }
  for (const e of sk.ents) if (e.t === 'circle') add(e.id + '.r', e.r);
  const X = Float64Array.from(X0);

  const P = (id) => {
    const p = getPt(sk, id);
    if (!p) throw new Error('missing point ' + id);
    if (p.fixed) return { ix: -1, iy: -1, cx: p.x, cy: p.y };
    return { ix: vi[id + '.x'], iy: vi[id + '.y'] };
  };
  const px = (A, X) => A.ix < 0 ? A.cx : X[A.ix];
  const py = (A, X) => A.iy < 0 ? A.cy : X[A.iy];
  const E = (id) => {
    const e = getEnt(sk, id);
    if (!e) throw new Error('missing entity ' + id);
    return e;
  };
  // circle-ish accessor: center point + radius function
  const C = (e) => {
    if (e.t === 'circle') {
      const c = P(e.c), ri = vi[e.id + '.r'];
      return { c, vars: [c.ix, c.iy, ri], r: (X) => X[ri] };
    }
    if (e.t === 'arc') {
      const c = P(e.c), a = P(e.a);
      return { c, vars: [c.ix, c.iy, a.ix, a.iy], r: (X) => Math.hypot(px(a, X) - px(c, X), py(a, X) - py(c, X)) };
    }
    throw new Error('needs a circle or arc');
  };
  const L = (e) => {
    if (e.t !== 'line') throw new Error('needs a line');
    return { a: P(e.a), b: P(e.b) };
  };
  const pv = (A) => [A.ix, A.iy];
  const rows = [];
  const push = (con, vars, f, n) => rows.push({ con, vars: vars.filter(i => i !== undefined && i >= 0), f, n });
  const SC = 10; // scale for dimensionless residuals

  // implicit arc constraint |b-c| = |a-c|
  for (const e of sk.ents) {
    if (e.t !== 'arc' || e.noR) continue;
    const c = P(e.c), a = P(e.a), b = P(e.b);
    push({ t: 'arcR', implicit: true, e: e.id }, [...pv(c), ...pv(a), ...pv(b)], (X) => [
      Math.hypot(px(b, X) - px(c, X), py(b, X) - py(c, X)) - Math.hypot(px(a, X) - px(c, X), py(a, X) - py(c, X))], 1);
  }

  for (const con of sk.cons) {
    if (con.driven) continue;
    const dv = dimValues ? dimValues[con.id] : undefined;
    switch (con.t) {
      case 'h': case 'v': {
        let A, B;
        if (con.e) { const l = L(E(con.e)); A = l.a; B = l.b; } else { A = P(con.p); B = P(con.q); }
        const g = con.t === 'h' ? py : px;
        push(con, [...pv(A), ...pv(B)], (X) => [g(B, X) - g(A, X)], 1);
        break;
      }
      case 'on': {
        const A = P(con.p), e = E(con.e);
        if (e.t === 'line') {
          const l = L(e);
          push(con, [...pv(A), ...pv(l.a), ...pv(l.b)], (X) => {
            const ax = px(l.a, X), ay = py(l.a, X), dx = px(l.b, X) - ax, dy = py(l.b, X) - ay;
            const len = Math.hypot(dx, dy) || 1e-12;
            return [(dx * (py(A, X) - ay) - dy * (px(A, X) - ax)) / len];
          }, 1);
        } else {
          const cc = C(e);
          push(con, [...pv(A), ...cc.vars], (X) => [Math.hypot(px(A, X) - px(cc.c, X), py(A, X) - py(cc.c, X)) - cc.r(X)], 1);
        }
        break;
      }
      case 'par': case 'perp': case 'col': {
        const l1 = L(E(con.e1)), l2 = L(E(con.e2));
        push(con, [...pv(l1.a), ...pv(l1.b), ...pv(l2.a), ...pv(l2.b)], (X) => {
          const d1x = px(l1.b, X) - px(l1.a, X), d1y = py(l1.b, X) - py(l1.a, X);
          const d2x = px(l2.b, X) - px(l2.a, X), d2y = py(l2.b, X) - py(l2.a, X);
          const n1 = Math.hypot(d1x, d1y) || 1e-12, n2 = Math.hypot(d2x, d2y) || 1e-12;
          if (con.t === 'perp') return [SC * (d1x * d2x + d1y * d2y) / (n1 * n2)];
          const r = [SC * (d1x * d2y - d1y * d2x) / (n1 * n2)];
          if (con.t === 'col') {
            const ax = px(l1.a, X), ay = py(l1.a, X);
            r.push((d1x * (py(l2.a, X) - ay) - d1y * (px(l2.a, X) - ax)) / n1);
          }
          return r;
        }, con.t === 'col' ? 2 : 1);
        break;
      }
      case 'eq': {
        const e1 = E(con.e1), e2 = E(con.e2);
        if (e1.t === 'line' && e2.t === 'line') {
          const l1 = L(e1), l2 = L(e2);
          push(con, [...pv(l1.a), ...pv(l1.b), ...pv(l2.a), ...pv(l2.b)], (X) => [
            Math.hypot(px(l1.b, X) - px(l1.a, X), py(l1.b, X) - py(l1.a, X)) - Math.hypot(px(l2.b, X) - px(l2.a, X), py(l2.b, X) - py(l2.a, X))], 1);
        } else {
          const c1 = C(e1), c2 = C(e2);
          push(con, [...c1.vars, ...c2.vars], (X) => [c1.r(X) - c2.r(X)], 1);
        }
        break;
      }
      case 'eqd': {
        const a1 = P(con.p1), b1 = P(con.q1), a2 = P(con.p2), b2 = P(con.q2);
        push(con, [...pv(a1), ...pv(b1), ...pv(a2), ...pv(b2)], (X) => [
          Math.hypot(px(b1, X) - px(a1, X), py(b1, X) - py(a1, X)) - Math.hypot(px(b2, X) - px(a2, X), py(b2, X) - py(a2, X))], 1);
        break;
      }
      case 'tan': {
        const e1 = E(con.e1), e2 = E(con.e2);
        if (e1.t === 'line' || e2.t === 'line') {
          const le = e1.t === 'line' ? e1 : e2, ce = e1.t === 'line' ? e2 : e1;
          const l = L(le), cc = C(ce);
          if (con.at) {
            const T = P(con.at), O = le.a === con.at ? l.b : l.a;
            push(con, [...pv(T), ...pv(O), ...cc.vars], (X) => {
              const dx = px(O, X) - px(T, X), dy = py(O, X) - py(T, X);
              const rx = px(cc.c, X) - px(T, X), ry = py(cc.c, X) - py(T, X);
              const n = (Math.hypot(dx, dy) * Math.hypot(rx, ry)) || 1e-12;
              return [SC * (dx * rx + dy * ry) / n];
            }, 1);
          } else {
            const s = con.s || 1;
            push(con, [...pv(l.a), ...pv(l.b), ...cc.vars], (X) => {
              const ax = px(l.a, X), ay = py(l.a, X), dx = px(l.b, X) - ax, dy = py(l.b, X) - ay;
              const len = Math.hypot(dx, dy) || 1e-12;
              return [(dx * (py(cc.c, X) - ay) - dy * (px(cc.c, X) - ax)) / len - s * cc.r(X)];
            }, 1);
          }
        } else {
          const c1 = C(e1), c2 = C(e2);
          if (con.at) {
            const T = P(con.at);
            push(con, [...pv(T), ...c1.vars, ...c2.vars], (X) => {
              const ax = px(c1.c, X) - px(T, X), ay = py(c1.c, X) - py(T, X);
              const bx = px(c2.c, X) - px(T, X), by = py(c2.c, X) - py(T, X);
              const n = (Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1e-12;
              return [SC * (ax * by - ay * bx) / n];
            }, 1);
          } else {
            const s = con.s || 1;
            push(con, [...c1.vars, ...c2.vars], (X) => {
              const d = Math.hypot(px(c2.c, X) - px(c1.c, X), py(c2.c, X) - py(c1.c, X));
              return [s > 0 ? d - (c1.r(X) + c2.r(X)) : d - Math.abs(c1.r(X) - c2.r(X))];
            }, 1);
          }
        }
        break;
      }
      case 'mid': {
        const A = P(con.p), l = L(E(con.e));
        push(con, [...pv(A), ...pv(l.a), ...pv(l.b)], (X) => [
          px(A, X) - (px(l.a, X) + px(l.b, X)) / 2, py(A, X) - (py(l.a, X) + py(l.b, X)) / 2], 2);
        break;
      }
      case 'sym': {
        const A = P(con.p), B = P(con.q), l = L(E(con.e));
        push(con, [...pv(A), ...pv(B), ...pv(l.a), ...pv(l.b)], (X) => {
          const ax = px(l.a, X), ay = py(l.a, X), dx = px(l.b, X) - ax, dy = py(l.b, X) - ay;
          const len = Math.hypot(dx, dy) || 1e-12;
          const mx = (px(A, X) + px(B, X)) / 2, my = (py(A, X) + py(B, X)) / 2;
          return [(dx * (my - ay) - dy * (mx - ax)) / len, ((px(B, X) - px(A, X)) * dx + (py(B, X) - py(A, X)) * dy) / len];
        }, 2);
        break;
      }
      case 'dist': {
        const A = P(con.p), B = P(con.q), v = dv;
        if (con.dir === 'h') push(con, [...pv(A), ...pv(B)], (X) => [(px(B, X) - px(A, X)) * (con.s || 1) - v], 1);
        else if (con.dir === 'v') push(con, [...pv(A), ...pv(B)], (X) => [(py(B, X) - py(A, X)) * (con.s || 1) - v], 1);
        else push(con, [...pv(A), ...pv(B)], (X) => [Math.hypot(px(B, X) - px(A, X), py(B, X) - py(A, X)) - v], 1);
        break;
      }
      case 'pldist': {
        const A = P(con.p), l = L(E(con.e)), v = dv, s = con.s || 1;
        push(con, [...pv(A), ...pv(l.a), ...pv(l.b)], (X) => {
          const ax = px(l.a, X), ay = py(l.a, X), dx = px(l.b, X) - ax, dy = py(l.b, X) - ay;
          const len = Math.hypot(dx, dy) || 1e-12;
          return [s * (dx * (py(A, X) - ay) - dy * (px(A, X) - ax)) / len - v];
        }, 1);
        break;
      }
      case 'rad': case 'dia': {
        const cc = C(E(con.e)), k = con.t === 'dia' ? 2 : 1, v = dv;
        push(con, cc.vars, (X) => [k * cc.r(X) - v], 1);
        break;
      }
      case 'ang': {
        const l1 = L(E(con.e1)), l2 = L(E(con.e2)), th = dv * Math.PI / 180;
        const s1 = con.r1 ? -1 : 1, s2 = con.r2 ? -1 : 1;
        push(con, [...pv(l1.a), ...pv(l1.b), ...pv(l2.a), ...pv(l2.b)], (X) => {
          const d1x = s1 * (px(l1.b, X) - px(l1.a, X)), d1y = s1 * (py(l1.b, X) - py(l1.a, X));
          const d2x = s2 * (px(l2.b, X) - px(l2.a, X)), d2y = s2 * (py(l2.b, X) - py(l2.a, X));
          const n = (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y)) || 1e-12;
          const cr = (d1x * d2y - d1y * d2x) / n, dt = (d1x * d2x + d1y * d2y) / n;
          // sin(phi - theta), with phi measured either way (unsigned angle)
          const sg = cr >= 0 ? 1 : -1;
          return [SC * (sg * cr * Math.cos(th) - dt * Math.sin(th))];
        }, 1);
        break;
      }
    }
  }
  return { X, vi, rows, P, px, py };
}

function evalRows(rows, X, out) {
  let k = 0;
  for (const r of rows) { const v = r.f(X); for (let j = 0; j < v.length; j++) out[k++] = v[j]; }
  return out;
}
function countRows(rows) { let m = 0; for (const r of rows) m += r.n; return m; }

// Jacobian as dense m x n (row-major Float64Array)
function jacobian(rows, X, n, m, r0) {
  const J = new Float64Array(m * n);
  let k = 0;
  for (const r of rows) {
    const vars = [...new Set(r.vars)];
    for (const i of vars) {
      const old = X[i];
      const h = 1e-7 * Math.max(1, Math.abs(old));
      X[i] = old + h; const fp = r.f(X);
      X[i] = old - h; const fm = r.f(X);
      X[i] = old;
      for (let j = 0; j < r.n; j++) J[(k + j) * n + i] = (fp[j] - fm[j]) / (2 * h);
    }
    k += r.n;
  }
  return J;
}

function cholSolve(A, b, N) {
  const Lm = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * N + j];
      for (let k = 0; k < j; k++) s -= Lm[i * N + k] * Lm[j * N + k];
      if (i === j) { if (s <= 0) return null; Lm[i * N + i] = Math.sqrt(s); }
      else Lm[i * N + j] = s / Lm[j * N + j];
    }
  }
  const y = new Float64Array(N);
  for (let i = 0; i < N; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= Lm[i * N + k] * y[k]; y[i] = s / Lm[i * N + i]; }
  const x = new Float64Array(N);
  for (let i = N - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < N; k++) s -= Lm[k * N + i] * x[k]; x[i] = s / Lm[i * N + i]; }
  return x;
}

// Weighted damped Gauss-Newton. rows: hard rows; soft: [{vars,f,n,w}]
export function solveRows(rows, X, opts = {}) {
  const n = X.length;
  const all = opts.soft ? rows.concat(opts.soft) : rows;
  const m = countRows(all);
  const tol = opts.tol ?? 1e-9;
  const maxIt = opts.maxIt ?? 80;
  if (m === 0 || n === 0) {
    const r = new Float64Array(m); evalRows(all, X, r);
    let mx = 0; for (const v of r) mx = Math.max(mx, Math.abs(v));
    return { ok: mx < tol * 10, err: mx };
  }
  const w = new Float64Array(m);
  { let k = 0; for (const r of all) for (let j = 0; j < r.n; j++) w[k++] = r.w ? Math.sqrt(r.w) : 1; }
  const r = new Float64Array(m), rt = new Float64Array(m);
  const norm2 = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += (v[i] * w[i]) ** 2; return s; };
  evalRows(all, X, r);
  let f = norm2(r);
  let lam = 1e-9;
  const hardM = countRows(rows);
  const hardErr = () => { let mx = 0; for (let i = 0; i < hardM; i++) mx = Math.max(mx, Math.abs(r[i])); return mx; };
  for (let it = 0; it < maxIt; it++) {
    let mx = 0; for (let i = 0; i < m; i++) mx = Math.max(mx, Math.abs(r[i]));
    if (mx < tol) return { ok: true, err: mx, it };
    const J = jacobian(all, X, n, m, r);
    for (let i = 0; i < m; i++) { const wi = w[i]; if (wi !== 1) for (let j = 0; j < n; j++) J[i * n + j] *= wi; }
    const rw = new Float64Array(m); for (let i = 0; i < m; i++) rw[i] = r[i] * w[i];
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      let dx;
      if (m <= n) {
        const A = new Float64Array(m * m);
        for (let i = 0; i < m; i++) for (let j = 0; j <= i; j++) {
          let s = 0; const oi = i * n, oj = j * n;
          for (let k = 0; k < n; k++) s += J[oi + k] * J[oj + k];
          A[i * m + j] = A[j * m + i] = s;
        }
        let tr = 0; for (let i = 0; i < m; i++) tr += A[i * m + i];
        const l = lam * Math.max(1, tr / m);
        for (let i = 0; i < m; i++) A[i * m + i] += l;
        const y = cholSolve(A, rw, m);
        if (!y) { lam *= 10; continue; }
        dx = new Float64Array(n);
        for (let i = 0; i < m; i++) { const yi = y[i]; if (yi) for (let k = 0; k < n; k++) dx[k] -= J[i * n + k] * yi; }
      } else {
        const A = new Float64Array(n * n), g = new Float64Array(n);
        for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
          let s = 0; for (let k = 0; k < m; k++) s += J[k * n + i] * J[k * n + j];
          A[i * n + j] = A[j * n + i] = s;
        }
        for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < m; k++) s += J[k * n + i] * rw[k]; g[i] = -s; }
        let tr = 0; for (let i = 0; i < n; i++) tr += A[i * n + i];
        const l = lam * Math.max(1, tr / n);
        for (let i = 0; i < n; i++) A[i * n + i] += l;
        dx = cholSolve(A, g, n);
        if (!dx) { lam *= 10; continue; }
      }
      // limit huge steps
      let big = 0; for (let k = 0; k < n; k++) big = Math.max(big, Math.abs(dx[k]));
      const lim = opts.maxStep ?? 1e6;
      const sc = big > lim ? lim / big : 1;
      let step = sc;
      const X0 = X.slice();
      for (let ls = 0; ls < 8; ls++) {
        for (let k = 0; k < n; k++) X[k] = X0[k] + step * dx[k];
        evalRows(all, X, rt);
        const ft = norm2(rt);
        if (ft < f || ft < tol * tol) { f = ft; r.set(rt); improved = true; break; }
        step *= 0.5;
      }
      if (!improved) { X.set(X0); lam *= 10; } else lam = Math.max(1e-12, lam / 10);
    }
    if (!improved) break;
  }
  let mx = 0; for (let i = 0; i < m; i++) mx = Math.max(mx, Math.abs(r[i]));
  return { ok: mx < tol * 100, err: mx, hardErr: hardErr() };
}

// Reduced row echelon analysis: rank and which variables are determined.
export function analyze(rows, X) {
  const n = X.length, m = countRows(rows);
  const res = { rank: 0, dof: n, determined: new Uint8Array(n), rowRank: [] };
  if (n === 0) return res;
  if (m === 0) return res;
  const r0 = new Float64Array(m); evalRows(rows, X, r0);
  const J = jacobian(rows, X, n, m, r0);
  // normalize rows
  for (let i = 0; i < m; i++) {
    let s = 0; for (let j = 0; j < n; j++) s += J[i * n + j] ** 2;
    s = Math.sqrt(s); if (s > 1e-14) for (let j = 0; j < n; j++) J[i * n + j] /= s;
  }
  const pivCol = [];
  let row = 0;
  const used = new Uint8Array(m);
  const tol = 1e-7;
  // column-by-column elimination with partial pivoting on rows
  for (let col = 0; col < n && row < m; col++) {
    let best = -1, bv = tol;
    for (let i = row; i < m; i++) { const v = Math.abs(J[i * n + col]); if (v > bv) { bv = v; best = i; } }
    if (best < 0) continue;
    if (best !== row) for (let j = 0; j < n; j++) { const t = J[row * n + j]; J[row * n + j] = J[best * n + j]; J[best * n + j] = t; }
    const pv = J[row * n + col];
    for (let j = 0; j < n; j++) J[row * n + j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = J[i * n + col];
      if (Math.abs(f) > 1e-15) for (let j = 0; j < n; j++) J[i * n + j] -= f * J[row * n + j];
    }
    pivCol.push(col); row++;
  }
  res.rank = row;
  res.dof = n - row;
  const isPiv = new Uint8Array(n); pivCol.forEach(c => isPiv[c] = 1);
  for (let k = 0; k < pivCol.length; k++) {
    const c = pivCol[k];
    let det = true;
    for (let j = 0; j < n; j++) if (!isPiv[j] && Math.abs(J[k * n + j]) > 1e-6) { det = false; break; }
    res.determined[c] = det ? 1 : 0;
  }
  return res;
}

export function rankOf(rows, X) { return analyze(rows, X).rank; }
export { countRows };

// Evaluate all driving dimension expressions. Returns {vals, errors}
export function dimValuesOf(sk, values) {
  const vals = {}, errors = {};
  for (const c of sk.cons) {
    if (!isDim(c) || c.driven) continue;
    try {
      let v = evaluate(c.v, values);
      if ((c.t === 'dist' && !c.dir) || c.t === 'rad' || c.t === 'dia') {
        if (v <= 0) throw new Error('Must be bigger than 0');
      }
      if (c.t === 'ang' && (v <= 0 || v >= 180)) {
        if (v === 180 || v === 0) throw new Error('Use parallel instead of 0 or 180 degrees');
        throw new Error('Angles must be between 0 and 180 degrees');
      }
      vals[c.id] = v;
    } catch (e) { errors[c.id] = e.message; }
  }
  return { vals, errors };
}

function writeBack(sk, sys) {
  const { X, vi } = sys;
  for (const id in sk.pts) {
    const p = sk.pts[id];
    if (!p.fixed) { p.x = X[vi[id + '.x']]; p.y = X[vi[id + '.y']]; }
  }
  for (const e of sk.ents) if (e.t === 'circle') e.r = X[vi[e.id + '.r']];
}

// Solve a sketch in place. Tries a homotopy ramp from last-solved dimension values if needed.
export function solveSketch(sk, values, opts = {}) {
  const { vals, errors } = dimValuesOf(sk, values);
  const errIds = Object.keys(errors);
  if (errIds.length) return { ok: false, reason: 'dim', errors };
  const snapshot = JSON.stringify({ pts: sk.pts, ents: sk.ents });
  const attempt = (dv) => {
    const sys = buildSystem(sk, dv);
    const res = solveRows(sys.rows, sys.X, { soft: opts.soft ? opts.soft(sys) : undefined, maxIt: opts.maxIt });
    if (opts.soft) {
      // clean-up pass on hard constraints only
      const r2 = solveRows(sys.rows, sys.X, {});
      res.ok = r2.ok; res.err = r2.err;
    }
    if (res.ok) writeBack(sk, sys);
    return res;
  };
  let res = attempt(vals);
  if (!res.ok && !opts.soft) {
    // ramp each dimension from its last value
    const last = {};
    let any = false;
    for (const c of sk.cons) if (vals[c.id] !== undefined) { last[c.id] = c.lastv ?? vals[c.id]; if (c.lastv !== undefined && Math.abs(c.lastv - vals[c.id]) > 1e-9) any = true; }
    if (any) {
      const restore = JSON.parse(snapshot);
      sk.pts = restore.pts; sk.ents = restore.ents;
      const N = 12;
      for (let k = 1; k <= N; k++) {
        const dv = {};
        for (const id in vals) dv[id] = last[id] + (vals[id] - last[id]) * k / N;
        res = attempt(dv);
        if (!res.ok) break;
      }
    }
  }
  if (!res.ok) {
    const restore = JSON.parse(snapshot);
    sk.pts = restore.pts; sk.ents = restore.ents;
    return { ok: false, reason: 'conflict', err: res.err };
  }
  for (const c of sk.cons) if (vals[c.id] !== undefined) c.lastv = vals[c.id];
  return { ok: true, vals };
}

// Which entities/points are fully defined
export function dofStatus(sk, values) {
  const { vals } = dimValuesOf(sk, values);
  const sys = buildSystem(sk, vals);
  const an = analyze(sys.rows, sys.X);
  const ptDef = {};
  for (const id in sk.pts) {
    const p = sk.pts[id];
    if (p.fixed) { ptDef[id] = true; continue; }
    ptDef[id] = !!(an.determined[sys.vi[id + '.x']] && an.determined[sys.vi[id + '.y']]);
  }
  const entDef = {};
  const pd = (id) => !!(VIRTUAL_PTS[id] || ptDef[id]);
  for (const e of sk.ents) {
    if (e.t === 'line') entDef[e.id] = pd(e.a) && pd(e.b);
    else if (e.t === 'circle') entDef[e.id] = pd(e.c) && !!an.determined[sys.vi[e.id + '.r']];
    else entDef[e.id] = pd(e.c) && pd(e.a) && pd(e.b);
  }
  const m = countRows(sys.rows);
  return { dof: an.dof, rank: an.rank, m, n: sys.X.length, ptDef, entDef, redundant: m - an.rank };
}

// Would adding constraint `con` be redundant (not reduce DOF)? Returns {redundant, added}
export function testAdd(sk, values, con) {
  const { vals } = dimValuesOf(sk, values);
  const before = buildSystem(sk, vals);
  const r0 = analyze(before.rows, before.X).rank;
  const sk2 = { ...sk, cons: sk.cons.concat([con]) };
  const v2 = { ...vals };
  if (isDim(con)) v2[con.id] = measureDim(sk, con);
  const after = buildSystem(sk2, v2);
  const r1 = analyze(after.rows, after.X).rank;
  const newRows = countRows(after.rows) - countRows(before.rows);
  return { redundant: r1 - r0 < newRows, gained: r1 - r0, newRows };
}

// ---------- measuring current geometry ----------
export function ptXY(sk, id) { const p = getPt(sk, id); return [p.x, p.y]; }
export function radiusOf(sk, e) {
  if (e.t === 'circle') return e.r;
  const c = getPt(sk, e.c), a = getPt(sk, e.a);
  return Math.hypot(a.x - c.x, a.y - c.y);
}
export function measureDim(sk, c) {
  switch (c.t) {
    case 'dist': {
      const [ax, ay] = ptXY(sk, c.p), [bx, by] = ptXY(sk, c.q);
      if (c.dir === 'h') return (bx - ax) * (c.s || 1);
      if (c.dir === 'v') return (by - ay) * (c.s || 1);
      return Math.hypot(bx - ax, by - ay);
    }
    case 'pldist': {
      const e = getEnt(sk, c.e);
      const [ax, ay] = ptXY(sk, e.a), [bx, by] = ptXY(sk, e.b), [x, y] = ptXY(sk, c.p);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
      return (c.s || 1) * (dx * (y - ay) - dy * (x - ax)) / len;
    }
    case 'rad': return radiusOf(sk, getEnt(sk, c.e));
    case 'dia': return 2 * radiusOf(sk, getEnt(sk, c.e));
    case 'ang': {
      const e1 = getEnt(sk, c.e1), e2 = getEnt(sk, c.e2);
      const [a1x, a1y] = ptXY(sk, e1.a), [b1x, b1y] = ptXY(sk, e1.b), [a2x, a2y] = ptXY(sk, e2.a), [b2x, b2y] = ptXY(sk, e2.b);
      const s1 = c.r1 ? -1 : 1, s2 = c.r2 ? -1 : 1;
      const d1x = s1 * (b1x - a1x), d1y = s1 * (b1y - a1y), d2x = s2 * (b2x - a2x), d2y = s2 * (b2y - a2y);
      return Math.abs(Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y)) * 180 / Math.PI;
    }
  }
  return 0;
}
