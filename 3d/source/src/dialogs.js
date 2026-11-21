// Feature dialogs (Onshape-style): fields with click-to-pick, live preview, green check / red X.
import { newId, nextName, toWorld, STD_PLANES } from './model.js';
import { pickRegions, regionContains } from './regions.js';
import { evaluate, fmt } from './expr.js';
import { icon, TOOLS } from './help.js';
import { getPt } from './solver.js';
import { stampLen, showLen, fmtLen, usuf, units } from './units.js';
const LEN_KEYS = new Set(['depth', 'off', 'spacing', 'spacing2']);

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SOLID = new Set(['extrude', 'revolve', 'lpattern', 'cpattern', 'mirror']);

export class FeatureDialog {
  constructor(app, type, editId) {
    this.app = app; this.type = type; this.editId = editId;
    const doc = app.doc;
    if (editId) this.d = JSON.parse(JSON.stringify(doc.features.find(f => f.id === editId)));
    else this.d = this.defaults(type);
    this.active = this.firstField();
    this.render();
  }
  defaults(type) {
    const app = this.app, doc = app.doc;
    const d = { id: newId(doc), t: type, name: nextName(doc, type) };
    const rb = doc.rollback == null ? doc.features.length : doc.rollback;
    const before = doc.features.slice(0, rb);
    const hasBodies = app.res && app.res.bodies.length > 0;
    const sel = doc.features.find(f => f.id === app.selFeature);
    if (type === 'extrude' || type === 'revolve') {
      let sk = sel && sel.t === 'sketch' ? sel : null;
      if (!sk) sk = [...before].reverse().find(f => f.t === 'sketch' && !before.some(g => g.sketch === f.id) && app.res.sketches[f.id] && app.res.sketches[f.id].regions.length);
      d.sketch = sk ? sk.id : null;
      d.regions = { auto: true };
      d.op = hasBodies && sk && sk.plane.k === 'face' ? 'add' : hasBodies ? 'add' : 'new';
      if (type === 'extrude') Object.assign(d, { end: 'blind', depth: '10', flip: false });
      else {
        Object.assign(d, { full: true, angle: '180', sym: false, flip: false, axis: null });
        if (sk) {
          const cl = sk.ents.filter(e => e.t === 'line' && e.cons);
          if (cl.length === 1) d.axis = { e: cl[0].id };
        }
      }
    }
    if (type === 'plane') {
      let ref = null;
      if (app.selFace) ref = app.selFace.ref;
      else if (app.selFeature && app.selFeature.startsWith('std:')) ref = { k: 'std', name: app.selFeature.slice(4) };
      else if (sel && sel.t === 'plane') ref = { k: 'plane', f: sel.id };
      Object.assign(d, { ref, off: '20', flip: false });
    }
    const featSel = sel && SOLID.has(sel.t) ? [sel.id] : [];
    if (type === 'lpattern') Object.assign(d, { feats: featSel, dir: { k: 'axis', a: 'X' }, count: '3', spacing: '20', flip: false, dir2: null, count2: '2', spacing2: '20', flip2: false });
    if (type === 'cpattern') Object.assign(d, { feats: featSel, axis: { k: 'axis', a: 'Z' }, count: '6', angle: '360', flip: false });
    if (type === 'mirror') Object.assign(d, { feats: featSel, plane: { k: 'std', name: 'Right' } });
    return d;
  }
  firstField() {
    const t = this.type, d = this.d;
    if (t === 'extrude' || t === 'revolve') return !d.sketch ? 'sketch' : (t === 'revolve' && !d.axis) ? 'axis' : null;
    if (t === 'plane') return d.ref ? null : 'ref';
    if (t === 'lpattern' || t === 'cpattern' || t === 'mirror') return d.feats.length ? null : 'feats';
    return null;
  }
  activeKind() {
    const a = this.active;
    if (!a) return (this.type === 'extrude' || this.type === 'revolve') ? 'sketch' : null;
    if (a === 'sketch') return 'sketch';
    if (a === 'axis' && this.type === 'revolve') return 'line';
    if (a === 'ref' || a === 'plane') return 'plane';
    if (a === 'feats') return 'feats';
    if (a === 'dir' || a === 'dir2') return 'line';
    if (a === 'axisRef') return this.d.axis && this.d.axis.k === 'point' ? 'point' : 'line';
    return null;
  }
  isPicked(sid, eid) {
    const d = this.d;
    if (this.type === 'revolve') return d.sketch === sid && d.axis && d.axis.e === eid;
    for (const r of [d.dir, d.dir2, d.axis]) if (r && r.s === sid && (r.e === eid || r.p === eid)) return true;
    return false;
  }
  featPicked(fid) { return (this.d.feats || []).includes(fid); }

  // ---------- rendering ----------
  render() {
    const el = $('#dlg');
    el.hidden = false;
    const t = this.type, d = this.d, T = TOOLS[t];
    let h = `<div class="dh">${icon(t)}<b>${esc(this.editId ? d.name : T.name)}</b><button class="dhelp" aria-label="How this works" title="${esc(T.what)}">${icon('help')}</button></div>`;
    const sk = d.sketch && this.app.doc.features.find(f => f.id === d.sketch);
    const field = (key, label, value, hint) => `<div class="fld${this.active === key ? ' act' : ''}" data-f="${key}"><div class="fl">${label}</div><div class="fv">${value}</div>${this.active === key && hint ? `<div class="fh">${hint}</div>` : ''}</div>`;
    const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, lab, ic]) => `<button class="${d[key] === v ? 'on' : ''}" data-v="${v}">${ic ? icon(ic) : ''}${lab}</button>`).join('')}</div>`;
    const expr = (key, label, unit) => `<label class="fl">${label.replace('(mm)', '(' + usuf() + ')')}<div class="ex"><input data-x="${key}" value="${esc(LEN_KEYS.has(key) ? showLen(d[key]) : (d[key] ?? ''))}" spellcheck="false" autocomplete="off"><output data-xo="${key}"></output></div></label>`;
    if (t === 'extrude' || t === 'revolve') {
      h += seg('op', [['new', 'New', null], ['add', 'Add', null], ['remove', 'Remove', null], ['intersect', 'Intersect', null]]);
      h += `<div class="opnote">${{ new: 'Makes a new, separate part.', add: 'Joins onto the parts it touches.', remove: 'Cuts away from the parts (holes, pockets).', intersect: 'Keeps only where it overlaps the part.' }[d.op]}</div>`;
      const res = this.app.res;
      let areaTxt = 'Click a sketch';
      if (sk && res.sketches[sk.id]) {
        const regs = res.sketches[sk.id].regions;
        const picked = pickRegions(regs, d.regions).list;
        areaTxt = `<b>${esc(sk.name)}</b> · ${picked.length} of ${regs.length} area${regs.length === 1 ? '' : 's'}${d.regions.auto ? ' (auto)' : ''}`;
      }
      h += field('sketch', 'Sketch areas', areaTxt + (this.active === 'sketch' ? '' : ' <span class="fsub">click to choose</span>'), 'Click areas in the view to pick them (orange = picked). Click a sketch in the list to switch.');
      if (t === 'extrude') {
        h += seg('end', [['blind', 'Depth', null], ['sym', 'Symmetric', null], ['through', 'Through all', null]]);
        if (d.end !== 'through') h += expr('depth', 'Depth (mm)');
        if (d.end !== 'through') h += `<div class="dragtip">${icon('extrude')} Or drag the orange arrow in the view.</div>`;
        if (d.end === 'blind') h += `<button class="flip${d.flip ? ' on' : ''}" data-flip="flip">${icon('redo')} Flip direction</button>`;
        if (d.end === 'sym') h += `<div class="opnote">Half the depth goes each way from the sketch.</div>`;
        if (d.end === 'through') h += `<div class="opnote">Goes all the way through everything, both directions. If the part gets thicker later, it still goes through.</div>`;
      } else {
        let ax = 'Click a line in the view';
        if (d.axis && sk) {
          const e = d.axis.e === 'XAX' ? 'Sketch X axis' : d.axis.e === 'YAX' ? 'Sketch Y axis' : sk.ents.find(x => x.id === d.axis.e) ? 'A line in ' + sk.name : 'Missing line';
          ax = `<b>${esc(e)}</b>`;
        }
        h += field('axis', 'Spin around (axis)', ax, 'Click a straight line in the sketch. Tip: draw a dashed construction line for the axis.');
        h += `<div class="row3"><button data-axq="YAX">Sketch Y axis</button><button data-axq="XAX">Sketch X axis</button></div>`;
        h += `<label class="chk"><input type="checkbox" data-c="full" ${d.full !== false ? 'checked' : ''}> Full turn (360°)</label>`;
        if (d.full === false) {
          h += expr('angle', 'Angle (degrees)');
          h += `<div class="dragtip">${icon('revolve')} Or drag the orange ball around the axis.</div>`;
          h += `<label class="chk"><input type="checkbox" data-c="sym" ${d.sym ? 'checked' : ''}> Symmetric (half each way)</label>`;
          if (!d.sym) h += `<button class="flip${d.flip ? ' on' : ''}" data-flip="flip">${icon('redo')} Flip direction</button>`;
        }
      }
    }
    if (t === 'plane') {
      h += field('ref', 'Start from', d.ref ? `<b>${esc(this.refLabel(d.ref))}</b>` : 'Click a plane or flat face', 'Click a plane or a flat face of the part.');
      h += `<div class="row3"><button data-pq="Top">Top</button><button data-pq="Front">Front</button><button data-pq="Right">Right</button></div>`;
      h += expr('off', 'Offset distance (mm)');
      if (d.ref) h += `<div class="dragtip">${icon('plane')} Or drag the orange arrow in the view.</div>`;
      h += `<button class="flip${d.flip ? ' on' : ''}" data-flip="flip">${icon('redo')} Flip side</button>`;
    }
    if (t === 'lpattern' || t === 'cpattern' || t === 'mirror') {
      const chips = d.feats.length ? d.feats.map(id => `<span class="chip2">${esc(this.app.featName(id))}<button data-unf="${id}" aria-label="Remove">×</button></span>`).join('') : 'Click features in the list, or a face of the part';
      h += field('feats', 'Features to copy', chips, 'Click Extrude or Revolve features in the list (or a face they made). Click again to remove.');
    }
    if (t === 'lpattern') {
      h += this.dirField('dir', 'Direction', d.dir);
      h += expr('count', 'How many (including the first)');
      h += expr('spacing', 'Spacing (mm)');
      h += `<div class="dragtip">${icon('lpattern')} Or drag the orange arrow at the second copy.</div>`;
      h += `<button class="flip${d.flip ? ' on' : ''}" data-flip="flip">${icon('redo')} Flip direction</button>`;
      h += `<label class="chk"><input type="checkbox" data-c="two" ${d.dir2 ? 'checked' : ''}> Second direction (makes a grid)</label>`;
      if (d.dir2) {
        h += this.dirField('dir2', 'Second direction', d.dir2);
        h += expr('count2', 'How many in direction 2');
        h += expr('spacing2', 'Spacing 2 (mm)');
        h += `<button class="flip${d.flip2 ? ' on' : ''}" data-flip="flip2">${icon('redo')} Flip direction 2</button>`;
      }
    }
    if (t === 'cpattern') {
      const a = d.axis || {};
      h += `<label class="fl">Axis<select data-sel="axis"><option value="Z"${a.k === 'axis' && a.a === 'Z' ? ' selected' : ''}>Z axis (blue, straight up)</option><option value="X"${a.k === 'axis' && a.a === 'X' ? ' selected' : ''}>X axis (red)</option><option value="Y"${a.k === 'axis' && a.a === 'Y' ? ' selected' : ''}>Y axis (green)</option><option value="point"${a.k === 'point' ? ' selected' : ''}>Through a sketch point (click one)</option><option value="line"${a.k === 'line' ? ' selected' : ''}>Along a sketch line (click one)</option></select></label>`;
      if (a.k === 'point' || a.k === 'line') h += field('axisRef', a.k === 'point' ? 'Sketch point' : 'Sketch line', a.s ? `<b>${a.k === 'point' ? 'A point' : 'A line'} in ${esc(this.app.featName(a.s))}</b>` : 'Click one in the view', a.k === 'point' ? 'Click a point in a sketch. The copies spin around a line through it, straight out of that sketch.' : 'Click a straight line in a sketch.');
      h += expr('count', 'How many (including the first)');
      h += expr('angle', 'Total angle (degrees)');
      h += `<div class="opnote">360 spreads the copies evenly all the way around. Less than 360 puts the first and last copy at the ends of the angle.</div>`;
      h += `<button class="flip${d.flip ? ' on' : ''}" data-flip="flip">${icon('redo')} Flip direction</button>`;
    }
    if (t === 'mirror') {
      h += field('plane', 'Mirror plane', d.plane ? `<b>${esc(this.refLabel(d.plane))}</b>` : 'Click a plane or flat face', 'Click a plane or a flat face to mirror across.');
      h += `<div class="row3"><button data-mq="Right">Right</button><button data-mq="Front">Front</button><button data-mq="Top">Top</button></div>`;
    }
    h += `<div class="derr" id="derr"></div>`;
    h += `<div class="dfoot"><button class="btn no" id="dCancel">${icon('cancel')} Cancel</button><button class="btn ok" id="dOk">${icon('finish')} OK</button></div>`;
    el.innerHTML = h;
    this.bind();
    this.showErrors();
    this.app.renderTree();
    this.app.updatePlanes();
    this.app.setHint(this.hintText());
  }
  dirField(key, label, ref) {
    const r = ref || {};
    const sel = (v) => (r.k === 'axis' && r.a === v) ? ' selected' : '';
    let h = `<label class="fl">${label}<select data-sel="${key}"><option value="X"${sel('X')}>X axis (red)</option><option value="Y"${sel('Y')}>Y axis (green)</option><option value="Z"${sel('Z')}>Z axis (blue, up)</option><option value="line"${r.k === 'line' ? ' selected' : ''}>Along a sketch line (click one)</option></select></label>`;
    if (r.k === 'line') h += `<div class="fld${this.active === key ? ' act' : ''}" data-f="${key}"><div class="fl">Sketch line</div><div class="fv">${r.s ? '<b>A line in ' + esc(this.app.featName(r.s)) + '</b>' : 'Click a line in the view'}</div></div>`;
    return h;
  }
  refLabel(ref) {
    if (!ref) return '';
    if (ref.k === 'std') return ref.name + ' plane';
    if (ref.k === 'plane') return this.app.featName(ref.f);
    if (ref.k === 'face') return 'Face of ' + this.app.featName(ref.f);
    return 'Face';
  }
  hintText() {
    const k = this.activeKind();
    if (k === 'sketch') return 'Click sketch areas to pick or un-pick them. Then set the depth and click OK.';
    if (k === 'line') return 'Click a straight line in a sketch.';
    if (k === 'point') return 'Click a point in a sketch.';
    if (k === 'plane') return 'Click a plane or a flat face.';
    if (k === 'feats') return 'Click features in the list (or faces of the part) to copy them.';
    return 'Change the settings, then click OK (or press Enter).';
  }
  bind() {
    const el = $('#dlg'), d = this.d;
    el.querySelectorAll('[data-f]').forEach(f => f.onclick = (e) => { if (e.target.closest('button')) return; this.active = this.active === f.dataset.f ? null : f.dataset.f; this.render(); this.app.view.request(); });
    el.querySelectorAll('[data-seg]').forEach(s => s.querySelectorAll('button').forEach(b => b.onclick = () => { d[s.dataset.seg] = b.dataset.v; this.render(); this.update(); }));
    el.querySelectorAll('[data-x]').forEach(inp => {
      const k = inp.dataset.x;
      const isLen = LEN_KEYS.has(k);
      const show = () => {
        const o = el.querySelector(`[data-xo="${k}"]`);
        try { const v = evaluate(isLen ? stampLen(inp.value) : inp.value, this.app.res.values); o.textContent = '= ' + (isLen ? fmtLen(v, true, 3) : fmt(v, 3)); o.classList.remove('bad'); }
        catch (er) { o.textContent = er.message; o.classList.add('bad'); }
      };
      show();
      inp.oninput = () => { d[k] = isLen ? stampLen(inp.value) : inp.value; show(); this.update(); };
      inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); this.ok(); }
        if (e.key === 'Escape') this.app.closeDialog(false);
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(inp.value)) {
          e.preventDefault();
          const inch = isLen && units() === 'in';
          const step = inch ? (e.shiftKey ? 1 : e.altKey ? 1 / 32 : 1 / 8) : (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
          let v = parseFloat(inp.value) + (e.key === 'ArrowUp' ? step : -step);
          if (['depth', 'count', 'count2', 'angle'].includes(k)) v = Math.max(k === 'depth' ? (inch ? 1 / 64 : 0.1) : 1, v);
          inp.value = fmt(v, inch ? 4 : 3); d[k] = isLen ? stampLen(inp.value) : inp.value; show(); this.update();
        }
      };
    });
    el.querySelectorAll('[data-flip]').forEach(b => b.onclick = () => { d[b.dataset.flip] = !d[b.dataset.flip]; this.render(); this.update(); });
    el.querySelectorAll('[data-c]').forEach(c => c.onchange = () => {
      const k = c.dataset.c;
      if (k === 'two') d.dir2 = c.checked ? { k: 'axis', a: d.dir && d.dir.a === 'Y' ? 'X' : 'Y' } : null;
      else if (k === 'full') d.full = c.checked;
      else d[k] = c.checked;
      this.render(); this.update();
    });
    el.querySelectorAll('[data-sel]').forEach(s => s.onchange = () => {
      const k = s.dataset.sel, v = s.value;
      if (v === 'line' || v === 'point') { d[k] = { k: v }; this.active = k === 'axis' ? 'axisRef' : k; }
      else { d[k] = { k: 'axis', a: v }; this.active = null; }
      this.render(); this.update();
    });
    el.querySelectorAll('[data-axq]').forEach(b => b.onclick = () => { d.axis = { e: b.dataset.axq }; this.active = null; this.render(); this.update(); });
    el.querySelectorAll('[data-pq]').forEach(b => b.onclick = () => { d.ref = { k: 'std', name: b.dataset.pq }; this.active = null; this.render(); this.update(); });
    el.querySelectorAll('[data-mq]').forEach(b => b.onclick = () => { d.plane = { k: 'std', name: b.dataset.mq }; this.active = null; this.render(); this.update(); });
    el.querySelectorAll('[data-unf]').forEach(b => b.onclick = (e) => { e.stopPropagation(); d.feats = d.feats.filter(x => x !== b.dataset.unf); this.render(); this.update(); });
    const help = el.querySelector('.dhelp');
    if (help) help.onclick = () => this.app.toast(TOOLS[this.type].what + ' ' + TOOLS[this.type].steps.join(' '));
    $('#dCancel').onclick = () => this.app.closeDialog(false);
    $('#dOk').onclick = () => this.ok();
  }
  syncInputs() {
    const el = $('#dlg'), d = this.d;
    if (!el) return;
    el.querySelectorAll('[data-x]').forEach(inp => {
      const k = inp.dataset.x, isLen = LEN_KEYS.has(k);
      const disp = isLen ? showLen(d[k]) : String(d[k] ?? '');
      if (disp === inp.value) return;
      inp.value = disp;
      const o = el.querySelector(`[data-xo="${k}"]`);
      try { const v = evaluate(isLen ? stampLen(inp.value) : inp.value, this.app.res.values); o.textContent = '= ' + (isLen ? fmtLen(v, true, 3) : fmt(v, 3)); o.classList.remove('bad'); } catch (er) { o.textContent = er.message; o.classList.add('bad'); }
    });
    el.querySelectorAll('[data-flip]').forEach(b => b.classList.toggle('on', !!d[b.dataset.flip]));
  }
  update(now) {
    clearTimeout(this._t);
    const go = () => { if (this.app.dialog !== this) return; this.app.previewDialog(this); this.showErrors(); this.refreshSketchField(); };
    if (now) go(); else this._t = setTimeout(go, 90);
  }
  refreshSketchField() {
    if (this.type !== 'extrude' && this.type !== 'revolve') return;
    const fv = $('#dlg [data-f="sketch"] .fv');
    const sk = this.d.sketch && this.app.doc.features.find(f => f.id === this.d.sketch);
    if (!fv || !sk || !this.app.res.sketches[sk.id]) return;
    const regs = this.app.res.sketches[sk.id].regions, picked = pickRegions(regs, this.d.regions).list;
    fv.innerHTML = `<b>${esc(sk.name)}</b> · ${picked.length} of ${regs.length} area${regs.length === 1 ? '' : 's'}${this.d.regions.auto ? ' (auto)' : ''}`;
  }
  showErrors() {
    const e = $('#derr');
    if (!e) return;
    const res = this.app.res;
    const msg = res.errors[this.d.id] || res.warn[this.d.id] || '';
    e.textContent = msg;
    e.className = 'derr' + (res.errors[this.d.id] ? ' bad' : msg ? ' warn' : '');
  }
  ok() {
    const res = this.app.res;
    if (res.errors[this.d.id]) { this.app.toast(res.errors[this.d.id], 'bad'); return; }
    this.app.closeDialog(true);
  }

  // ---------- picking in the view ----------
  sketchRegions() {
    const s = this.d.sketch && this.app.res.sketches[this.d.sketch];
    return s ? s : null;
  }
  regionAt(x, y) {
    const s = this.sketchRegions();
    if (!s) return null;
    const p = this.app.view.rayPlane(x, y, s.plane);
    if (!p) return null;
    const d = [p[0] - s.plane.o[0], p[1] - s.plane.o[1], p[2] - s.plane.o[2]];
    const u = d[0] * s.plane.x[0] + d[1] * s.plane.x[1] + d[2] * s.plane.x[2], v = d[0] * s.plane.y[0] + d[1] * s.plane.y[1] + d[2] * s.plane.y[2];
    let best = null;
    for (const r of s.regions) if (regionContains(r, u, v) && (!best || Math.abs(r.area) < Math.abs(best.area))) best = r;
    return best;
  }
  move(x, y) {
    const k = this.activeKind();
    const app = this.app;
    if (k === 'sketch') {
      const r = this.regionAt(x, y);
      const sh = r ? null : app.hitSketch(x, y);
      const key = r ? 'r' + r.id : sh ? sh.s + '/' + sh.e : null;
      if (key !== this.hov) { this.hov = key; this.hovRegion = r; app.hoverSkEnt = sh ? sh.s + '/' + sh.e : null; app.view.request(); }
      app.view.overlay.style.cursor = r || sh ? 'pointer' : 'default';
      app.view.clearHighlight();
      return true;
    }
    if (k === 'line' || k === 'point') {
      const sh = app.hitSketch(x, y, k);
      const key = sh ? sh.s + '/' + (sh.e || sh.p) : null;
      if (key !== app.hoverSkEnt) { app.hoverSkEnt = key; app.view.request(); }
      app.view.overlay.style.cursor = sh ? 'pointer' : 'default';
      app.view.clearHighlight();
      return true;
    }
    if (k === 'feats') {
      const hit = app.view.pickFace(x, y);
      if (hit) app.view.highlightGroup(hit.bodyIdx, hit.group, 0xf28c28); else app.view.clearHighlight();
      app.view.overlay.style.cursor = hit ? 'pointer' : 'default';
      return true;
    }
    return false;
  }
  click(x, y) {
    const k = this.activeKind(), d = this.d, app = this.app;
    if (k === 'sketch') {
      const r = this.regionAt(x, y);
      if (r) {
        const s = this.sketchRegions();
        let list = pickRegions(s.regions, d.regions).list.slice();
        if (list.includes(r)) list = list.filter(x => x !== r); else list.push(r);
        d.regions = { keys: list.map(q => ({ key: q.key, pt: q.sample })) };
        if (!list.length) d.regions = { keys: [] };
        this.render(); this.update();
        return true;
      }
      const sh = app.hitSketch(x, y);
      if (sh && sh.s !== d.sketch) { this.setSketch(sh.s); return true; }
      return true;
    }
    if (k === 'line' || k === 'point') {
      const sh = app.hitSketch(x, y, k);
      if (!sh) { app.toast(k === 'point' ? 'Click a point in a sketch.' : 'Click a straight line in a sketch.'); return true; }
      if (this.type === 'revolve') {
        if (sh.s !== d.sketch) { app.toast('Pick a line in the same sketch as the shape (' + app.featName(d.sketch) + ').'); return true; }
        d.axis = { e: sh.e };
      } else {
        const key = this.active === 'axisRef' ? 'axis' : this.active;
        d[key] = k === 'point' ? { k: 'point', s: sh.s, p: sh.p } : { k: 'line', s: sh.s, e: sh.e };
      }
      this.active = null;
      app.hoverSkEnt = null;
      this.render(); this.update();
      return true;
    }
    if (k === 'plane') {
      const r = app.planeRefAt(x, y);
      if (!r) { app.toast('Click a plane or a flat face.'); return true; }
      if (this.type === 'plane') d.ref = r.ref; else d.plane = r.ref;
      this.active = null;
      this.render(); this.update();
      return true;
    }
    if (k === 'feats') {
      const hit = app.view.pickFace(x, y);
      if (!hit) return true;
      const fc = app.res.faces.filter(f => Math.abs((hit.point[0] - f.o[0]) * f.n[0] + (hit.point[1] - f.o[1]) * f.n[1] + (hit.point[2] - f.o[2]) * f.n[2]) < 1e-3 && f.n[0] * hit.normal[0] + f.n[1] * hit.normal[1] + f.n[2] * hit.normal[2] > 0.9999).pop();
      if (!fc) { app.toast('Pick that feature in the list instead.'); return true; }
      this.toggleFeat(fc.f);
      return true;
    }
    return false;
  }
  setSketch(id) {
    const f = this.app.doc.features.find(x => x.id === id);
    if (!f || f.t !== 'sketch') return;
    const order = this.app.doc.features.indexOf(f), mine = this.editId ? this.app.doc.features.findIndex(x => x.id === this.editId) : Infinity;
    if (order > mine) { this.app.toast('That sketch comes after this feature in the list.'); return; }
    this.d.sketch = id; this.d.regions = { auto: true };
    if (this.type === 'revolve') { const cl = f.ents.filter(e => e.t === 'line' && e.cons); this.d.axis = cl.length === 1 ? { e: cl[0].id } : null; }
    this.render(); this.update();
  }
  toggleFeat(fid) {
    const f = this.app.doc.features.find(x => x.id === fid);
    if (!f || !SOLID.has(f.t)) { this.app.toast('Pick an Extrude, Revolve or pattern feature.'); return; }
    if (fid === this.d.id) return;
    const d = this.d;
    d.feats = d.feats.includes(fid) ? d.feats.filter(x => x !== fid) : [...d.feats, fid];
    this.render(); this.update();
  }
  treeClick(id) {
    const k = this.activeKind(), d = this.d;
    if (k === 'feats') { this.toggleFeat(id); return true; }
    if (k === 'plane') {
      let ref = null;
      if (id.startsWith('std:')) ref = { k: 'std', name: id.slice(4) };
      else { const f = this.app.doc.features.find(x => x.id === id); if (f && f.t === 'plane') ref = { k: 'plane', f: id }; }
      if (!ref) return true;
      if (this.type === 'plane') d.ref = ref; else d.plane = ref;
      this.active = null; this.render(); this.update();
      return true;
    }
    if ((this.type === 'extrude' || this.type === 'revolve')) {
      const f = this.app.doc.features.find(x => x.id === id);
      if (f && f.t === 'sketch') { this.setSketch(id); this.active = 'sketch'; this.render(); return true; }
    }
    return false;
  }
  drawOverlay(ctx) {
    if (this.type !== 'extrude' && this.type !== 'revolve') return;
    const s = this.sketchRegions();
    if (!s) return;
    const picked = new Set(pickRegions(s.regions, this.d.regions).list);
    const v = this.app.view;
    const choosing = this.active === 'sketch';
    for (const r of s.regions) {
      const isP = picked.has(r), isH = this.hovRegion === r && this.activeKind() === 'sketch';
      if (!choosing && !isH) continue;
      ctx.beginPath();
      for (const loop of [r.outer, ...r.holes]) loop.forEach((p, i) => { const [x, y] = v.project(toWorld(s.plane, p[0], p[1])); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = isP ? (isH ? 'rgba(242,140,40,.45)' : 'rgba(242,140,40,.2)') : isH ? 'rgba(31,111,209,.22)' : 'rgba(31,111,209,.08)';
      ctx.fill('evenodd');
    }
  }
}
