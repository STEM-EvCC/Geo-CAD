// Display and entry units. The model is always millimeters inside; this only changes how
// lengths are shown and how a plain typed number is read (2 means 2 inches in inch mode).
import { fmt } from './expr.js';

export const UNITS_INFO = {
  mm: { k: 1, suf: 'mm', dec: 2, name: 'millimeters' },
  in: { k: 25.4, suf: 'in', dec: 3, name: 'inches' },
};
let cur = 'mm';
export const setUnits = (u) => { cur = UNITS_INFO[u] ? u : 'mm'; };
export const units = () => cur;
export const uk = () => UNITS_INFO[cur].k;
export const usuf = () => UNITS_INFO[cur].suf;
const PLAIN = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/;
const WITH_IN = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(?:in|inch|inches|")\s*$/;

// mm -> text in the current unit
export function fmtLen(mm, withUnit = false, dec) {
  const u = UNITS_INFO[cur];
  const s = fmt(mm / u.k, dec ?? u.dec);
  return withUnit ? s + ' ' + u.suf : s;
}
// label style used on drawings: millimeters stay bare, inches get "in"
export function lenLabel(mm, dec) { return cur === 'mm' ? fmt(mm, dec ?? 2) : fmt(mm / 25.4, dec ?? 3) + ' in'; }

// text typed for a length -> stored expression (plain numbers get the current unit)
export function stampLen(text) {
  const t = String(text ?? '').trim();
  if (cur === 'in' && PLAIN.test(t)) return t + ' in';
  return t;
}
// stored expression -> text to show in an input box in the current unit
export function showLen(stored) {
  const t = String(stored ?? '').trim();
  if (cur === 'in') {
    let m = PLAIN.exec(t);
    if (m) return fmt(parseFloat(m[1]) / 25.4, 4);
    m = WITH_IN.exec(t);
    if (m) return m[1];
  } else {
    const m = WITH_IN.exec(t);
    if (m) return fmt(parseFloat(m[1]) * 25.4, 3);
  }
  return t;
}
// sketch grid / handle snap steps (in mm) for the current unit
export function niceSteps() {
  return cur === 'in' ? [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 10].map(v => v * 25.4) : [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
}
