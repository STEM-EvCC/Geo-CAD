// Exports: STL, DXF, SVG, project files, plus a download helper that works on GitHub Pages and in claude.ai.
import { getPt } from './solver.js';
import { arcAngles } from './regions.js';
import { fmt } from './expr.js';

const ALLOWED = new Set(['txt', 'json', 'svg', 'zip', 'png', 'csv', 'html', 'md', 'pdf']);
let dlNS = null, dlTried = false;
async function getDownloads() {
  if (dlTried) return dlNS;
  dlTried = true;
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      dlNS = await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 4000))]);
    }
  } catch (e) { dlNS = null; }
  return dlNS;
}
export function inClaude() { return !!(window.claude && typeof window.claude.use === 'function'); }

export async function download(name, data, toast) {
  const ext = name.split('.').pop().toLowerCase();
  const ns = inClaude() ? await getDownloads() : null;
  if (ns) {
    let fname = name, payload = data;
    if (!ALLOWED.has(ext)) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      payload = makeZip([{ name, data: bytes }]);
      fname = name.replace(/\.[^.]+$/, '') + '.zip';
      if (toast) toast(`Your ${ext.toUpperCase()} file comes inside a .zip here. Unzip it, then open the .${ext} file.`);
    }
    try { await ns.save({ filename: fname, data: payload instanceof Uint8Array ? payload : payload }); }
    catch (e) { if (toast && e && e.code !== 'declined') toast('Could not save the file here (' + (e.message || e.code) + ').', 'bad'); }
    return;
  }
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- ZIP (store only) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), d = f.data, crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, d);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + d.length;
  }
  const csize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let k = 0; for (const p of all) { out.set(p, k); k += p.length; }
  return out;
}

// ---------- STL ----------
export function stlBinary(meshes) {
  let nt = 0; for (const m of meshes) nt += m.idx.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  const head = 'Geo-CAD 3D (TS 82) part, millimeters';
  for (let i = 0; i < head.length && i < 80; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (const m of meshes) {
    const P = m.pos, I = m.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true); o += 12;
      for (const q of [a, b, c]) { dv.setFloat32(o, P[q], true); dv.setFloat32(o + 4, P[q + 1], true); dv.setFloat32(o + 8, P[q + 2], true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return new Uint8Array(buf);
}

// ---------- sketch geometry for 2D exports ----------
export function sketchShapes(sk) {
  const out = [];
  for (const e of sk.ents) {
    if (e.cons) continue;
    if (e.t === 'line') { const a = getPt(sk, e.a), b = getPt(sk, e.b); out.push({ t: 'line', a: [a.x, a.y], b: [b.x, b.y] }); }
    else if (e.t === 'circle') { const c = getPt(sk, e.c); out.push({ t: 'circle', c: [c.x, c.y], r: e.r }); }
    else { const A = arcAngles(sk, e); out.push({ t: 'arc', c: [A.cx, A.cy], r: A.r, a0: A.a0 * 180 / Math.PI, a1: (A.a0 + A.sw) * 180 / Math.PI }); }
  }
  return out;
}
export function loopShapes(loops) {
  const out = [];
  for (const L of loops) for (let i = 0; i < L.length; i++) out.push({ t: 'line', a: L[i], b: L[(i + 1) % L.length] });
  return out;
}
function bounds(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const s of shapes) {
    if (s.t === 'line') { add(...s.a); add(...s.b); } else { add(s.c[0] - s.r, s.c[1] - s.r); add(s.c[0] + s.r, s.c[1] + s.r); }
  }
  return { x0, y0, x1, y1 };
}

export function toDXF(shapes) {
  const L = [];
  const p = (...a) => L.push(...a.map(String));
  p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1, 0, 'LAYER', 2, 'CUT', 70, 0, 62, 1, 6, 'CONTINUOUS', 0, 'ENDTAB', 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'ENTITIES');
  const n = (v) => (Math.round(v * 1e6) / 1e6).toString();
  for (const s of shapes) {
    if (s.t === 'line') p(0, 'LINE', 8, 'CUT', 62, 1, 10, n(s.a[0]), 20, n(s.a[1]), 30, 0, 11, n(s.b[0]), 21, n(s.b[1]), 31, 0);
    else if (s.t === 'circle') p(0, 'CIRCLE', 8, 'CUT', 62, 1, 10, n(s.c[0]), 20, n(s.c[1]), 30, 0, 40, n(s.r));
    else p(0, 'ARC', 8, 'CUT', 62, 1, 10, n(s.c[0]), 20, n(s.c[1]), 30, 0, 40, n(s.r), 50, n(((s.a0 % 360) + 360) % 360), 51, n(((s.a1 % 360) + 360) % 360));
  }
  p(0, 'ENDSEC', 0, 'EOF');
  return L.join('\n') + '\n';
}

export function toSVG(shapes, title) {
  const b = bounds(shapes);
  const pad = 2;
  const W = (b.x1 - b.x0) + pad * 2, H = (b.y1 - b.y0) + pad * 2;
  const X = (x) => fmt(x - b.x0 + pad, 4), Y = (y) => fmt(b.y1 - y + pad, 4);
  const parts = shapes.map(s => {
    if (s.t === 'line') return `<line x1="${X(s.a[0])}" y1="${Y(s.a[1])}" x2="${X(s.b[0])}" y2="${Y(s.b[1])}"/>`;
    if (s.t === 'circle') return `<circle cx="${X(s.c[0])}" cy="${Y(s.c[1])}" r="${fmt(s.r, 4)}"/>`;
    const a0 = s.a0 * Math.PI / 180, a1 = s.a1 * Math.PI / 180;
    const sx = s.c[0] + s.r * Math.cos(a0), sy = s.c[1] + s.r * Math.sin(a0), ex = s.c[0] + s.r * Math.cos(a1), ey = s.c[1] + s.r * Math.sin(a1);
    const large = ((s.a1 - s.a0) % 360 + 360) % 360 > 180 ? 1 : 0;
    return `<path d="M ${X(sx)} ${Y(sy)} A ${fmt(s.r, 4)} ${fmt(s.r, 4)} 0 ${large} 0 ${X(ex)} ${Y(ey)}"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W, 3)}mm" height="${fmt(H, 3)}mm" viewBox="0 0 ${fmt(W, 3)} ${fmt(H, 3)}">
<title>${(title || 'Geo-CAD 3D sketch').replace(/[<&]/g, '')}</title>
<g fill="none" stroke="#ff0000" stroke-width="0.1">
${parts.join('\n')}
</g>
</svg>
`;
}

export function safeName(s) { return (s || 'part').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'part'; }
