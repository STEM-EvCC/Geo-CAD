// App shell: state, regeneration, undo, panels (variables, features, parts), part-mode picking, menus.
import { regen, freeResult, newDoc, newSketch, newId, nextName, STD_PLANES, PALETTE, matchFace, dependents, toWorld, planeFrom, TYPE_NAMES } from './model.js';
import { evalVariables, evaluate, fmt, VAR_NAME_RE, ExprError } from './expr.js';
import { getPt } from './solver.js';
import { entPolyline } from './regions.js';
import { View3D, groupLoops } from './view3d.js';
import { SketchEditor } from './sketch.js';
import { FeatureDialog } from './dialogs.js';
import { TOOLS, icon, tipHTML, GUIDE } from './help.js';
import { download, stlBinary, toDXF, toSVG, sketchShapes, loopShapes, safeName } from './io.js';
import { EXAMPLES } from './examples.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (k, v) => (k[0] === '_' ? undefined : v);
export const MATERIALS = [
  { id: 'PLA', name: 'PLA (3D print)', rho: 1.24, print: true },
  { id: 'PETG', name: 'PETG (3D print)', rho: 1.27, print: true },
  { id: 'ABS', name: 'ABS (3D print)', rho: 1.04, print: true },
  { id: 'PLY', name: 'Birch plywood (about)', rho: 0.68 },
  { id: 'ACR', name: 'Acrylic', rho: 1.19 },
  { id: 'AL', name: 'Aluminum 6061', rho: 2.70 },
  { id: 'ST', name: 'Steel', rho: 7.85 },
  { id: 'H2O', name: 'Water (to compare)', rho: 1.00 },
];
const PART_TOOLS = [['sketch'], ['extrude', 'revolve'], ['plane'], ['lpattern', 'cpattern', 'mirror'], ['measure', 'mass']];
const SK_TOOLS = [['select'], ['line', 'rect', 'rectc', 'circle', 'arc3', 'arcc', 'arct', 'polygon', 'slot', 'point'], ['fillet', 'trim', 'smirror', 'construction', 'use'], ['dimension'], ['coin', 'h', 'v', 'par', 'perp', 'tan', 'eq', 'mid', 'conc', 'sym', 'fix']];
const RULES = new Set(['coin', 'h', 'v', 'par', 'perp', 'tan', 'eq', 'mid', 'conc', 'sym', 'fix']);
const SHORT = { lpattern: 'Lin. pattern', cpattern: 'Circ. pattern', rect: 'Rect', rectc: 'Ctr rect', arc3: 'Arc', arcc: 'Ctr arc', arct: 'Tan arc', smirror: 'Mirror', construction: 'Constr.', dimension: 'Dimension', use: 'Use', mass: 'Mass' };

export class App {
  constructor(M) {
    this.M = M;
    this.doc = newDoc();
    this.res = null;
    this.undoStack = []; this.redoStack = [];
    this.mode = 'part';
    this.snapGrid = true; this.showGlyphs = true;
    this.selFeature = null;
    this.hidden = new Set();
    this.view = new View3D($('#view'));
    this.sk = new SketchEditor(this);
    this.dialog = null;
    this.measure = null;
    this.buildToolbar();
    this.bindUI();
    this.bindView();
    let loaded = false;
    try {
      const s = localStorage.getItem('geocad3d-autosave');
      if (s) { const d = JSON.parse(s); if (d && d.app === 'geocad3d' && d.features) { this.doc = d; loaded = true; } }
    } catch (e) { /* no storage */ }
    if (!loaded) this.doc = EXAMPLES[0].build();
    $('#docName').value = this.doc.name || 'My part';
    this.pushUndo(true);
    this.regenNow();
    this.view.viewTo([1, -1, 0.75], [0, 0, 1], { instant: true });
    this.fitAll(true);
    this.setHint('');
    if (!loaded) setTimeout(() => this.showWelcome(), 300);
    else this.toast('Welcome back. Your last part was restored.');
  }

  // ---------- undo / redo / autosave ----------
  snapshot() { return JSON.stringify(this.doc, strip); }
  pushUndo(initial) {
    const s = this.snapshot();
    if (this.undoStack[this.undoStack.length - 1] === s) return;
    this.undoStack.push(s);
    if (this.undoStack.length > 150) this.undoStack.shift();
    if (!initial) this.redoStack = [];
    this.autosave();
    this.updateUndoBtns();
  }
  autosave() {
    clearTimeout(this._as);
    this._as = setTimeout(() => { try { localStorage.setItem('geocad3d-autosave', this.snapshot()); } catch (e) { /* ignore */ } }, 400);
  }
  undo() {
    if (this.undoStack.length < 2) { this.toast('Nothing to undo.'); return; }
    this.redoStack.push(this.undoStack.pop());
    this.restore(this.undoStack[this.undoStack.length - 1]);
  }
  redo() {
    if (!this.redoStack.length) { this.toast('Nothing to redo.'); return; }
    const s = this.redoStack.pop();
    this.undoStack.push(s);
    this.restore(s);
  }
  restore(s) {
    this.doc = JSON.parse(s);
    if (this.mode === 'sketch') {
      if (!this.doc.features.find(f => f.id === this.sk.id)) { this.exitSketch(true); }
      else { this.sk.cancelOp(); this.sk.sel.clear(); this.reevalVars(); this.sk.refresh(); }
    }
    if (this.dialog) this.closeDialog(false);
    this.regenNow();
    this.autosave();
    this.updateUndoBtns();
  }
  updateUndoBtns() {
    const u = $('[data-act=undo]'), r = $('[data-act=redo]');
    if (u) u.disabled = this.undoStack.length < 2;
    if (r) r.disabled = !this.redoStack.length;
  }

  // ---------- regeneration ----------
  reevalVars() {
    const V = evalVariables(this.doc.vars);
    if (this.res) { this.res.values = V.values; this.res.varErrors = V.errors; }
  }
  regenNow(opts = {}) {
    const old = this.res;
    const docUse = opts.doc || this.doc;
    let upTo;
    if (this.mode === 'sketch') upTo = docUse.features.findIndex(f => f.id === this.sk.id) + 1;
    const res = regen(docUse, this.M, { upTo, override: opts.override, noSolve: this.mode === 'sketch' ? new Set([this.sk.id]) : undefined });
    this.res = res;
    this.showResult(opts);
    if (old) freeResult(old);
    return res;
  }
  showResult(opts = {}) {
    const res = this.res;
    const list = [];
    const ghost = this.mode === 'sketch';
    res.bodies.forEach((b, i) => {
      const m = b.man.getMesh();
      const pos = m.vertProperties.slice ? (m.numProp === 3 ? m.vertProperties.slice() : strideCopy(m.vertProperties, m.numProp)) : new Float32Array(m.vertProperties);
      const idx = m.triVerts.slice();
      b.mesh = { pos, idx };
      const color = (this.doc.colors && this.doc.colors[b.id]) || PALETTE[b.idx % PALETTE.length];
      b.name = 'Part ' + (b.idx + 1);
      list.push({ body: b, mesh: b.mesh, color, opacity: ghost ? 0.28 : 1, hidden: this.hidden.has(b.id), ghost });
    });
    this.view.setBodies(list);
    if (opts.preview) this.view.setPreview(opts.preview); else this.view.setPreview(null);
    this.updatePlanes();
    this.renderTree();
    this.renderVars();
    this.renderParts();
    if (this.card === 'mass') this.renderMass();
    this.view.setGrid(this.gridSize(), this.mode === 'part');
    this.view.request();
  }
  bbox(onlyVisible = true) {
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of (this.res ? this.res.bodies : [])) {
      if (onlyVisible && this.hidden.has(b.id)) continue;
      const bb = b.man.boundingBox();
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], bb.min[i]); mx[i] = Math.max(mx[i], bb.max[i]); }
    }
    return isFinite(mn[0]) ? { min: mn, max: mx } : null;
  }
  gridSize() { const bb = this.bbox(); if (!bb) return 200; return Math.max(200, 2.2 * Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), Math.abs(bb.min[1]), Math.abs(bb.max[1]))); }
  fitAll(instant) {
    let bb = this.bbox();
    if (this.res) for (const id in this.res.sketches) {
      const f = this.doc.features.find(x => x.id === id);
      if (!f || !this.sketchVisible(f)) continue;
      const s = this.res.sketches[id];
      for (const k in f.pts) { const p = toWorld(s.plane, f.pts[k].x, f.pts[k].y); bb = growBB(bb, p); }
    }
    this.view.fit(bb || { min: [-60, -60, -10], max: [60, 60, 10] }, { instant });
  }

  // ---------- planes shown in the view ----------
  planeSize() { const bb = this.bbox(); if (!bb) return 100; const s = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]); return Math.max(60, s * 1.1); }
  updatePlanes() {
    const list = [];
    const size = this.planeSize();
    const picking = this.planePickActive();
    const showStd = this.mode === 'part' && (picking || this.doc.showPlanes !== false);
    if (showStd) for (const name of ['Top', 'Front', 'Right']) {
      const key = 'std:' + name;
      list.push({ key, plane: STD_PLANES[name], size, label: name, selected: this.selFeature === key, hover: this.hoverPlane === key });
    }
    if (this.mode === 'part' && this.res) {
      for (const f of this.doc.features) {
        if (f.t !== 'plane' || !this.res.planes[f.id] || f.suppressed) continue;
        if (f.show === false && !picking) continue;
        const key = 'plane:' + f.id;
        list.push({ key, plane: this.res.planes[f.id], size: size * 0.8, label: f.name, color: 0xc08a3e, selected: this.selFeature === f.id, hover: this.hoverPlane === key });
      }
    }
    this.view.setPlanes(list);
  }
  planePickActive() { return this.picking === 'plane' || (this.dialog && this.dialog.activeKind() === 'plane'); }

  // ---------- toolbar ----------
  buildToolbar() {
    const tb = $('#toolbar');
    const groups = this.mode === 'sketch' ? SK_TOOLS : PART_TOOLS;
    tb.innerHTML = groups.map(g => `<div class="tg${RULES.has(g[0]) ? ' rules' : ''}">` + (RULES.has(g[0]) ? '<span class="tgcap">Rules</span>' : '') + g.map(id => {
      const t = TOOLS[id];
      const lab = RULES.has(id) ? '' : `<span>${esc(SHORT[id] || t.name)}</span>`;
      return `<button class="tool${RULES.has(id) ? ' ico' : ''}" data-tool="${id}" aria-label="${esc(t.name)}">${icon(id)}${lab}</button>`;
    }).join('') + '</div>').join('');
    tb.classList.toggle('sk', this.mode === 'sketch');
    if (this.mode === 'part') {
      tb.insertAdjacentHTML('beforeend', `<div class="tg right"><button class="tool" data-view="fit" aria-label="Fit">${icon('fit')}<span>Fit</span></button><button class="tool" data-view="iso" aria-label="Iso view">${icon('iso')}<span>Iso view</span></button></div>`);
    }
    this.renderOptBar();
  }
  renderOptBar() {
    const ob = $('#optbar');
    if (this.mode !== 'sketch') { ob.hidden = true; return; }
    ob.hidden = false;
    const t = this.sk.tool;
    let h = '';
    if (t === 'polygon') h += `<label>Sides <input id="optSides" type="number" min="3" max="24" value="${this.sk.polySides}"></label>`;
    if (t === 'fillet') h += `<label>Fillet radius <input id="optFillet" type="text" value="${esc(this.sk.filletR)}" spellcheck="false"></label>`;
    h += `<label class="chk"><input id="optCons" type="checkbox" ${this.sk.consMode ? 'checked' : ''}> New lines are construction (dashed)</label>`;
    h += `<label class="chk"><input id="optGlyph" type="checkbox" ${this.showGlyphs ? 'checked' : ''}> Show rule symbols</label>`;
    h += `<span class="obr"><button class="obtn" data-view="normal" title="Look straight at the sketch">${icon('normal')} Normal to</button><button class="obtn no" data-tool="cancel">${icon('cancel')} Cancel</button><button class="obtn ok" data-tool="finish">${icon('finish')} Finish sketch</button></span>`;
    ob.innerHTML = h;
    ob.querySelectorAll('[data-view]').forEach(b => b.onclick = () => this.viewCmd(b.dataset.view));
    ob.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => this.toolClick(b.dataset.tool));
    const sides = $('#optSides'); if (sides) sides.oninput = () => { this.sk.polySides = Math.max(3, Math.min(24, +sides.value || 6)); this.view.request(); };
    const fr = $('#optFillet'); if (fr) fr.oninput = () => { this.sk.filletR = fr.value; };
    $('#optCons').onchange = (e) => { this.sk.consMode = e.target.checked; };
    $('#optGlyph').onchange = (e) => { this.showGlyphs = e.target.checked; this.view.request(); };
  }
  markTools() {
    document.querySelectorAll('#toolbar .tool').forEach(b => {
      const id = b.dataset.tool;
      let on = false;
      if (this.mode === 'sketch') on = id === this.sk.tool || (id === 'construction' && this.sk.consMode) || (this.sk.pick && this.sk.pick.type === id);
      else on = (this.dialog && this.dialog.type === id) || (id === 'measure' && this.measure) || (id === 'mass' && this.card === 'mass') || (id === 'sketch' && this.picking === 'plane');
      b.classList.toggle('on', !!on);
    });
  }

  // ---------- UI wiring ----------
  bindUI() {
    $('#toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.view) { this.viewCmd(b.dataset.view); return; }
      this.toolClick(b.dataset.tool);
    });
    // hover tips
    let tipT = null;
    const tip = $('#tip');
    document.addEventListener('pointerover', (e) => {
      const b = e.target.closest && e.target.closest('[data-tool]');
      clearTimeout(tipT);
      if (!b) { tip.hidden = true; return; }
      tipT = setTimeout(() => {
        const h = tipHTML(b.dataset.tool); if (!h) return;
        tip.innerHTML = h; tip.hidden = false;
        const r = b.getBoundingClientRect(), vw = window.innerWidth;
        tip.style.left = Math.max(8, Math.min(vw - 300, r.left)) + 'px'; tip.style.top = (r.bottom + 6) + 'px';
      }, 380);
    });
    document.addEventListener('pointerdown', () => { clearTimeout(tipT); tip.hidden = true; });
    document.querySelectorAll('#top [data-act]').forEach(b => {
      const act = b.dataset.act;
      if (['undo', 'redo', 'new', 'open', 'save', 'export', 'examples', 'guide'].includes(act)) b.insertAdjacentHTML('afterbegin', icon(act === 'guide' ? 'help' : act === 'new' ? 'newdoc' : act));
      b.addEventListener('click', (e) => this.topAct(act, b));
    });
    $('#docName').addEventListener('change', (e) => { this.doc.name = e.target.value.trim() || 'My part'; this.pushUndo(); });
    $('#addVar').addEventListener('click', () => this.addVariable());
    $('#snapChk').addEventListener('change', (e) => { this.snapGrid = e.target.checked; });
    $('#fileIn').addEventListener('change', (e) => this.openFile(e.target.files[0]));
    window.addEventListener('keydown', (e) => this.key(e));
    // drag and drop project files
    $('#view').addEventListener('dragover', (e) => e.preventDefault());
    $('#view').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.openFile(f); });
  }
  viewCmd(v) {
    if (v === 'fit') this.fitAll();
    if (v === 'iso') { this.view.viewTo([1, -1, 0.75], [0, 0, 1]); setTimeout(() => this.fitAll(), 10); }
    if (v === 'normal' && this.mode === 'sketch') this.lookAtSketch();
  }
  toolClick(id) {
    if (this.mode === 'sketch') {
      if (id === 'finish') return this.exitSketch();
      if (id === 'cancel') return this.cancelSketch();
      if (id === 'construction') { this.sk.toggleConstruction(); this.markTools(); return; }
      if (['coin', 'h', 'v', 'par', 'perp', 'tan', 'eq', 'mid', 'conc', 'sym', 'fix'].includes(id)) { this.sk.applyConstraint(id); this.markTools(); return; }
      this.sk.setTool(id);
      return;
    }
    if (id === 'sketch') return this.startSketchPick();
    if (id === 'measure') return this.toggleMeasure();
    if (id === 'mass') return this.toggleMass();
    if (['extrude', 'revolve', 'plane', 'lpattern', 'cpattern', 'mirror'].includes(id)) this.openDialog(id);
  }
  topAct(act, btn) {
    if (act === 'undo') return this.undo();
    if (act === 'redo') return this.redo();
    if (act === 'guide') return this.showGuide();
    if (act === 'new') return this.confirm('Start a new part?', 'Your current part is kept in the undo history until you close the page. Save it first if you want to keep it.', 'Start new', () => { this.loadDoc(newDoc()); });
    if (act === 'open') return $('#fileIn').click();
    if (act === 'save') return this.saveProject();
    if (act === 'examples') return this.menu(btn, EXAMPLES.map((ex, i) => ({ label: ex.name, sub: ex.desc, act: () => this.confirm('Open "' + ex.name + '"?', 'This replaces the part on screen. You can Undo to get it back.', 'Open example', () => this.loadDoc(ex.build())) })));
    if (act === 'export') return this.exportMenu(btn);
  }
  loadDoc(d) {
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.dialog) this.closeDialog(false);
    this.doc = d; this.selFeature = null; this.hidden.clear();
    $('#docName').value = d.name || 'My part';
    this.pushUndo();
    this.regenNow();
    this.view.viewTo([1, -1, 0.75], [0, 0, 1], { instant: true });
    this.fitAll(true);
  }

  // ---------- keyboard ----------
  key(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('#modal').hidden) { if (e.key === 'Escape') this.closeModal(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveProject(); return; }
    if (this.mode === 'sketch') {
      if (e.key === 'Enter' && !this.sk.op) { e.preventDefault(); this.exitSketch(); return; }
      if (this.sk.key(e)) { e.preventDefault(); this.markTools(); this.renderOptBar(); }
      return;
    }
    if (e.key === 'Escape') {
      if (this.dialog) { this.closeDialog(false); return; }
      if (this.picking) { this.cancelPick(); return; }
      if (this.measure) { this.toggleMeasure(); return; }
      this.selFeature = null; this.renderTree(); this.updatePlanes(); return;
    }
    if (e.key === 'Enter' && this.dialog) { e.preventDefault(); this.dialog.ok(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selFeature && !this.selFeature.startsWith('std:')) { this.deleteFeature(this.selFeature); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { s: 'sketch', e: 'extrude', v: 'revolve', m: 'measure' };
    if (map[e.key.toLowerCase()] && !this.dialog) { this.toolClick(map[e.key.toLowerCase()]); return; }
    if (e.key.toLowerCase() === 'f') this.fitAll();
  }

  // ---------- view events ----------
  bindView() {
    const v = this.view;
    v.overlayDraw = (ctx) => this.drawOverlay(ctx);
    v.handlers = {
      down: (x, y, e) => {
        if (this.mode === 'sketch') return this.sk.down(x, y, e);
        return false;
      },
      drag: (x, y, e) => { if (this.mode === 'sketch') this.sk.drag(x, y, e); },
      up: (x, y, e) => { if (this.mode === 'sketch') this.sk.up(x, y, e); },
      move: (x, y, e) => { if (this.mode === 'sketch') this.sk.move(x, y, e); else this.partMove(x, y, e); },
      click: (x, y, e) => { if (this.mode === 'sketch') this.sk.click(x, y, e); else this.partClick(x, y, e); },
      dbl: (x, y, e) => { if (this.mode === 'sketch') this.sk.dbl(x, y, e); else this.partDbl(x, y); },
      rclick: (x, y, e) => { if (this.mode === 'sketch') this.sk.rclick(x, y, e); else this.partRclick(x, y, e); },
      leave: () => { if (this.mode === 'sketch') this.sk.leave(); else { this.view.clearHighlight(); this.hoverPlane = null; } },
      viewChanged: () => { this.view.scaleOrigin(); },
    };
    v.scaleOrigin();
  }

  // overlay: sketches in part mode, dialog overlays, measure markers
  drawOverlay(ctx) {
    this.view.scaleOrigin();
    if (this.mode === 'sketch') { this.sk.draw(ctx); return; }
    if (!this.res) return;
    const pickSketchGeo = this.dialog && ['line', 'point', 'sketch', 'axis'].includes(this.dialog.activeKind());
    for (const f of this.doc.features) {
      const s = this.res.sketches[f.id];
      if (!s || f.t !== 'sketch') continue;
      const vis = this.sketchVisible(f) || pickSketchGeo || (this.dialog && this.dialog.d.sketch === f.id) || this.selFeature === f.id;
      if (!vis) continue;
      const sel = this.selFeature === f.id || (this.dialog && this.dialog.d.sketch === f.id);
      for (const e of f.ents) {
        const pl = entPolyline(f, e, 0.3);
        const key = f.id + '/' + e.id;
        const hov = this.hoverSkEnt === key;
        const picked = this.dialog && this.dialog.isPicked(f.id, e.id);
        ctx.strokeStyle = picked ? '#f28c28' : hov ? '#f59e0b' : sel ? '#1f6fd1' : s.ok ? '#3b4a5c' : '#d63b3b';
        ctx.lineWidth = picked || hov ? 3 : sel ? 1.8 : 1.3;
        ctx.setLineDash(e.cons ? [6, 4] : []);
        ctx.beginPath();
        pl.forEach((p, i) => { const [x, y] = this.view.project(toWorld(s.plane, p[0], p[1])); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (pickSketchGeo && this.dialog.activeKind() === 'point') {
        for (const id in f.pts) {
          const p = f.pts[id];
          const [x, y] = this.view.project(toWorld(s.plane, p.x, p.y));
          const key = f.id + '/' + id;
          ctx.fillStyle = this.hoverSkEnt === key || (this.dialog && this.dialog.isPicked(f.id, id)) ? '#f28c28' : '#3b4a5c';
          ctx.beginPath(); ctx.arc(x, y, this.hoverSkEnt === key ? 5 : 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    if (this.dialog) this.dialog.drawOverlay(ctx);
    if (this.measure) this.drawMeasure(ctx);
  }
  sketchVisible(f) {
    if (f.show === true) return true;
    if (f.show === false) return false;
    return !this.doc.features.some(g => (g.t === 'extrude' || g.t === 'revolve') && g.sketch === f.id && !g.suppressed);
  }
  // hit test sketch geometry in part mode: returns {s: sketchId, e: entId} or {s, p}
  hitSketch(x, y, kind) {
    let best = null, bd = 8;
    const all = this.dialog && ['line', 'point', 'axis'].includes(this.dialog.activeKind());
    for (const f of this.doc.features) {
      if (f.t !== 'sketch' || !this.res.sketches[f.id]) continue;
      if (!all && !this.sketchVisible(f) && !(this.dialog && this.dialog.d.sketch === f.id)) continue;
      const pl = this.res.sketches[f.id].plane;
      if (kind === 'point') {
        for (const id in f.pts) {
          const p = f.pts[id]; const [sx, sy] = this.view.project(toWorld(pl, p.x, p.y));
          const d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = { s: f.id, p: id }; }
        }
        continue;
      }
      for (const e of f.ents) {
        if (kind === 'line' && e.t !== 'line') continue;
        const pts = entPolyline(f, e, 0.3).map(p => this.view.project(toWorld(pl, p[0], p[1])));
        for (let i = 0; i + 1 < pts.length; i++) {
          const d = segDist(x, y, pts[i], pts[i + 1]);
          if (d < bd) { bd = d; best = { s: f.id, e: e.id }; }
        }
      }
    }
    return best;
  }

  partMove(x, y) {
    if (this.dialog && this.dialog.move(x, y)) return;
    if (this.measure) { this.measureHover(x, y); return; }
    // hover planes when picking, else faces
    const planeKey = this.planePickActive() || this.picking === 'plane' ? this.view.pickPlane(x, y) : null;
    const hit = this.view.pickFace(x, y);
    let changed = false;
    if (planeKey && !hit) { if (this.hoverPlane !== planeKey) { this.hoverPlane = planeKey; changed = true; } this.view.clearHighlight(); }
    else {
      if (this.hoverPlane) { this.hoverPlane = null; changed = true; }
      if (hit) this.view.highlightGroup(hit.bodyIdx, hit.group, this.planePickActive() || this.picking ? 0xf28c28 : 0xf7c58f);
      else this.view.clearHighlight();
    }
    if (changed) this.updatePlanes();
    this.view.overlay.style.cursor = hit || planeKey ? 'pointer' : 'default';
  }
  // returns a plane reference for a click (plane or flat face) or null
  planeRefAt(x, y) {
    const hit = this.view.pickFace(x, y);
    const planeKey = this.view.pickPlane(x, y);
    if (hit) {
      const fc = matchFace(this.res, hit.point, hit.normal);
      if (fc) return { ref: { k: 'face', f: fc.f, role: fc.role }, label: this.faceLabel(fc) };
      return { ref: { k: 'fixed', plane: planeFrom(hit.point, hit.normal) }, label: 'Face', fixed: true };
    }
    if (planeKey) {
      if (planeKey.startsWith('std:')) return { ref: { k: 'std', name: planeKey.slice(4) }, label: planeKey.slice(4) + ' plane' };
      if (planeKey.startsWith('plane:')) { const id = planeKey.slice(6); return { ref: { k: 'plane', f: id }, label: this.featName(id) }; }
    }
    return null;
  }
  faceLabel(fc) {
    const n = this.featName(fc.f);
    const r = fc.role.split(':').pop();
    const words = { start: 'start face', end: 'end face' };
    return 'Face of ' + n + (words[fc.role] ? ' (' + words[fc.role] + ')' : '');
  }
  featName(id) { const f = this.doc.features.find(x => x.id === id); return f ? f.name : '?'; }
  partClick(x, y, e) {
    if (this.dialog && this.dialog.click(x, y, e)) return;
    if (this.measure) { this.measureClick(x, y); return; }
    if (this.picking === 'plane') {
      const r = this.planeRefAt(x, y);
      if (!r) { this.toast('Click a plane (Top, Front, Right) or a flat face of the part.'); return; }
      this.cancelPick();
      this.createSketch(r.ref, r.fixed);
      return;
    }
    // select feature from face
    const hit = this.view.pickFace(x, y);
    const sk = this.hitSketch(x, y);
    if (sk) { this.selectFeature(sk.s); return; }
    if (hit) {
      const fc = matchFace(this.res, hit.point, hit.normal);
      if (fc) { const fid = fc.f; this.selectFeature(fid); this.selFace = { ref: { k: 'face', f: fc.f, role: fc.role }, hit }; return; }
      this.selFace = { ref: { k: 'fixed', plane: planeFrom(hit.point, hit.normal) }, hit };
    }
    const pk = this.view.pickPlane(x, y);
    if (pk) { this.selectFeature(pk.startsWith('std:') ? pk : pk.slice(6)); return; }
    this.selFeature = null; this.selFace = null; this.renderTree(); this.updatePlanes();
  }
  partDbl(x, y) {
    if (this.dialog || this.measure) return;
    const sk = this.hitSketch(x, y);
    if (sk) { this.editFeature(sk.s); return; }
    const pk = this.view.pickPlane(x, y);
    const hit = this.view.pickFace(x, y);
    if (hit) { const fc = matchFace(this.res, hit.point, hit.normal); if (fc) this.editFeature(fc.f); return; }
    if (pk && pk.startsWith('std:')) this.createSketch({ k: 'std', name: pk.slice(4) });
  }
  partRclick(x, y, e) {
    const r = this.planeRefAt(x, y);
    if (!r || this.dialog) return;
    const rect = this.view.overlay.getBoundingClientRect();
    const hit = this.view.pickFace(x, y);
    const items = [{ label: 'New sketch here', act: () => this.createSketch(r.ref, r.fixed) }];
    if (hit) {
      items.push({ label: 'Export this flat face (DXF)', act: () => this.exportFace(hit, 'dxf') });
      items.push({ label: 'Export this flat face (SVG)', act: () => this.exportFace(hit, 'svg') });
      if (r.ref.k === 'face') items.push({ label: 'Edit ' + this.featName(r.ref.f), act: () => this.editFeature(r.ref.f) });
    }
    this.menu({ x: rect.left + x, y: rect.top + y }, items);
  }
  selectFeature(id) {
    this.selFeature = id;
    this.renderTree(); this.updatePlanes(); this.view.request();
  }

  // ---------- sketches ----------
  startSketchPick() {
    if (this.dialog) this.closeDialog(false);
    if (this.selFace) { const r = this.selFace.ref; this.selFace = null; return this.createSketch(r, r.k === 'fixed'); }
    if (this.selFeature && this.selFeature.startsWith('std:')) return this.createSketch({ k: 'std', name: this.selFeature.slice(4) });
    const sf = this.doc.features.find(f => f.id === this.selFeature);
    if (sf && sf.t === 'plane') return this.createSketch({ k: 'plane', f: sf.id });
    this.picking = 'plane';
    this.updatePlanes();
    this.markTools();
    this.setHint('Click a plane or a flat face to sketch on. Or press Top, Front or Right below.');
    this.showPickBar();
  }
  showPickBar() {
    const d = $('#dlg');
    d.hidden = false;
    d.innerHTML = `<div class="dh">${icon('sketch')}<b>New sketch</b></div><p class="dp">Click a plane or a flat face of your part. Or pick one:</p>
    <div class="row3"><button data-p="Top">Top</button><button data-p="Front">Front</button><button data-p="Right">Right</button></div>
    <div class="dfoot"><button class="btn no" id="pickCancel">${icon('cancel')} Cancel</button></div>`;
    d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { this.cancelPick(); this.createSketch({ k: 'std', name: b.dataset.p }); });
    $('#pickCancel').onclick = () => this.cancelPick();
  }
  cancelPick() { this.picking = null; $('#dlg').hidden = true; this.updatePlanes(); this.markTools(); this.setHint(''); }
  createSketch(ref, fixed) {
    const sk = newSketch(this.doc, ref);
    this.insertFeature(sk);
    if (fixed) this.toast('This face isn\'t tied to a feature, so the sketch stays put if the part changes.');
    this.pushUndo();
    this.enterSketch(sk.id, true);
  }
  insertFeature(f) {
    const fs = this.doc.features;
    if (this.doc.rollback != null && this.doc.rollback < fs.length) { fs.splice(this.doc.rollback, 0, f); this.doc.rollback++; }
    else fs.push(f);
  }
  enterSketch(id, isNew) {
    const f = this.doc.features.find(x => x.id === id);
    if (!f) return;
    if (this.measure) this.toggleMeasure();
    if (this.card) this.closeCard();
    this.sketchEntry = this.snapshot();
    this.mode = 'sketch';
    this.sk.id = id;
    this.sk.planeCache = null;
    const res = this.regenNow();
    const s = res.sketches[id];
    if (!s) { this.mode = 'part'; this.toast(res.errors[id] || 'Can\'t open that sketch.', 'bad'); this.regenNow(); return; }
    this.sk.start(id, s.plane);
    this.selFeature = id;
    this.buildToolbar();
    $('#app').classList.add('sketching');
    this.updatePlanes();
    this.renderTree();
    this.lookAtSketch(isNew);
    this.sk.hint();
    this.markTools();
  }
  lookAtSketch(isNew) {
    const pl = this.sk.plane;
    const f = this.sk.sk;
    let bb = null;
    for (const k in f.pts) bb = growBB(bb, toWorld(pl, f.pts[k].x, f.pts[k].y));
    const center = bb ? [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2] : pl.o;
    this.view.viewTo(pl.n, pl.y, { center });
    if (bb) { const m = 18 + 0.25 * Math.max(...bb.max.map((v, i) => v - bb.min[i])); setTimeout(() => this.view.fit({ min: bb.min.map(v => v - m), max: bb.max.map(v => v + m) }), 0); }
    else if (isNew) { const b2 = this.bbox(); if (b2) setTimeout(() => this.view.fit(b2), 0); }
  }
  exitSketch(silent) {
    if (this.mode !== 'sketch') return;
    this.sk.hideInput();
    this.sk.cancelOp();
    const id = this.sk.id;
    this.mode = 'part';
    $('#app').classList.remove('sketching');
    this.buildToolbar();
    this.regenNow();
    this.markTools();
    this.setHint('');
    $('#skStatus').innerHTML = '';
    if (!silent) {
      this.pushUndo();
      const s = this.res.sketches[id];
      const f = this.doc.features.find(x => x.id === id);
      if (s && s.ok && s.regions.length && f && !this.doc.features.some(g => g.sketch === id)) {
        this.selFeature = id;
        this.renderTree();
        this.toast('Sketch done. Next: click Extrude to make it 3D.');
      }
      this.view.viewTo([1, -1, 0.75], [0, 0, 1]);
      setTimeout(() => this.fitAll(), 10);
    }
  }
  cancelSketch() {
    const entry = this.sketchEntry;
    this.mode = 'part';
    this.sk.hideInput();
    $('#app').classList.remove('sketching');
    this.doc = JSON.parse(entry);
    // a brand-new empty sketch is removed on cancel
    const f = this.doc.features.find(x => x.id === this.sk.id);
    if (f && !f.ents.length && !Object.keys(f.pts).length) { this.doc.features = this.doc.features.filter(x => x !== f); if (this.doc.rollback != null) this.doc.rollback--; }
    this.buildToolbar();
    this.pushUndo();
    this.regenNow();
    this.markTools();
    this.setHint('');
    $('#skStatus').innerHTML = '';
    this.view.viewTo([1, -1, 0.75], [0, 0, 1]);
  }
  onSketchStatus(st) {
    const el = $('#skStatus');
    if (this.mode !== 'sketch' || !st) { el.innerHTML = ''; return; }
    const s = this.sk.regions;
    const open = s && s.openPts.length;
    let h = '';
    if (st.dof === 0) h = `<span class="chip def">Fully defined</span>`;
    else h = `<span class="chip free">${st.dof} more ${st.dof === 1 ? 'size or rule' : 'sizes or rules'} to fully define</span>`;
    if (st.redundant > 0) h += `<span class="chip bad">Over-defined</span>`;
    if (open) h += `<span class="chip bad">${open} open ${open === 1 ? 'end' : 'ends'}</span>`;
    el.innerHTML = h;
  }
  onToolChange() { this.markTools(); this.renderOptBar(); }
  onSelChange() { this.markTools(); }
  setHint(t) { $('#hint').textContent = t || (this.mode === 'part' ? 'Right-drag or left-drag empty space to rotate. Scroll to zoom. Shift-drag to pan.' : ''); }

  hoverFace(x, y) {
    const hit = this.view.pickFace(x, y, { ghost: true });
    if (hit) this.view.highlightGroup(hit.bodyIdx, hit.group); else this.view.clearHighlight();
  }
  useFaceAt(x, y) {
    const hit = this.view.pickFace(x, y, { ghost: true });
    if (!hit) { this.toast('Click a flat face of the part. (Earlier features show see-through while you sketch.)'); return; }
    const B = this.view.bodies[hit.bodyIdx];
    const loops = groupLoops(B.mesh.pos, B.mesh.idx, hit.grp);
    const pl = this.sk.plane;
    const n = hit.normal;
    if (Math.abs(n[0] * pl.n[0] + n[1] * pl.n[1] + n[2] * pl.n[2]) < 0.999) this.toast('That face is not parallel to the sketch, so its outline is flattened onto the sketch.');
    this.view.clearHighlight();
    this.sk.useFace(loops, pl);
  }

  // ---------- feature list ----------
  renderTree() {
    const t = $('#tree');
    const d = this.doc, res = this.res || { errors: {}, warn: {}, sketches: {} };
    const rb = d.rollback == null ? d.features.length : d.rollback;
    const pickFeats = this.dialog && this.dialog.activeKind() === 'feats';
    const pickPlane = this.planePickActive();
    let h = `<div class="trow std${this.selFeature === 'origin' ? ' sel' : ''}"><span class="ti">${originIcon()}</span><span class="tn">Origin</span></div>`;
    for (const n of ['Top', 'Front', 'Right']) h += `<div class="trow std${this.selFeature === 'std:' + n ? ' sel' : ''}${pickPlane ? ' pickable' : ''}" data-std="${n}" title="Double-click to sketch on the ${n} plane"><span class="ti">${icon('plane')}</span><span class="tn">${n}</span></div>`;
    d.features.forEach((f, i) => {
      if (i === rb) h += `<div class="rollbar" title="Rollback bar: features below it are turned off. Drag it to the end to turn them back on.">Rollback bar (drag me)</div>`;
      const err = res.errors[f.id], warn = res.warn[f.id];
      const s = res.sketches[f.id];
      const under = f.t === 'sketch' && s && s.dof && s.dof.dof > 0;
      const iconName = f.t === 'sketch' ? 'sketch' : f.t;
      const cls = ['trow', this.selFeature === f.id ? 'sel' : '', i >= rb ? 'rolled' : '', f.suppressed ? 'supp' : '', err ? 'err' : '', (pickFeats && ['extrude', 'revolve', 'lpattern', 'cpattern', 'mirror'].includes(f.t)) || (pickPlane && f.t === 'plane') ? 'pickable' : '', this.dialog && this.dialog.featPicked(f.id) ? 'picked' : '', this.mode === 'sketch' && this.sk.id === f.id ? 'editing' : ''].filter(Boolean).join(' ');
      const vis = f.t === 'sketch' ? this.sketchVisible(f) : f.t === 'plane' ? f.show !== false : null;
      h += `<div class="${cls}" data-id="${f.id}" title="${esc(err || warn || (under ? 'Under-defined: ' + s.dof.dof + ' degrees of freedom left' : 'Double-click to edit'))}">
        <span class="ti">${icon(iconName)}</span><span class="tn">${under ? '<i class="ud">(−)</i> ' : ''}${esc(f.name)}</span>
        ${err ? '<span class="tbad">!</span>' : warn ? '<span class="twarn">!</span>' : ''}
        ${vis !== null ? `<button class="teye" data-eye="${f.id}" aria-label="Show or hide">${icon(vis ? 'eye' : 'eyeoff')}</button>` : ''}
      </div>`;
    });
    if (rb >= d.features.length && d.rollback != null) h += `<div class="rollbar">Rollback bar (drag me)</div>`;
    if (!d.features.length) h += `<div class="tempty">Nothing yet. Click <b>Sketch</b> to start, then pick the Top plane.</div>`;
    t.innerHTML = h;
    t.querySelectorAll('.trow[data-id]').forEach(r => {
      const id = r.dataset.id;
      r.onclick = (e) => {
        if (e.target.closest('[data-eye]')) return;
        if (this.dialog && this.dialog.treeClick(id)) return;
        this.selectFeature(id);
      };
      r.ondblclick = () => this.editFeature(id);
      r.oncontextmenu = (e) => { e.preventDefault(); this.featureMenu(id, e.clientX, e.clientY); };
    });
    t.querySelectorAll('.trow[data-std]').forEach(r => {
      const n = r.dataset.std;
      r.onclick = () => { if (this.dialog && this.dialog.treeClick('std:' + n)) return; if (this.picking === 'plane') { this.cancelPick(); this.createSketch({ k: 'std', name: n }); return; } this.selectFeature('std:' + n); };
      r.ondblclick = () => { if (this.mode === 'part' && !this.dialog) this.createSketch({ k: 'std', name: n }); };
      r.oncontextmenu = (e) => { e.preventDefault(); this.menu({ x: e.clientX, y: e.clientY }, [{ label: 'New sketch on ' + n, act: () => this.createSketch({ k: 'std', name: n }) }, { label: this.doc.showPlanes === false ? 'Show the 3 planes' : 'Hide the 3 planes', act: () => { this.doc.showPlanes = this.doc.showPlanes === false; this.updatePlanes(); } }]); };
    });
    t.querySelectorAll('[data-eye]').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const f = this.doc.features.find(x => x.id === b.dataset.eye);
      if (f.t === 'sketch') f.show = !this.sketchVisible(f); else f.show = f.show === false;
      this.renderTree(); this.updatePlanes(); this.view.request(); this.autosave();
    });
    const bar = t.querySelector('.rollbar');
    if (bar) this.bindRollbar(bar);
    else if (this.mode === 'part') {
      t.insertAdjacentHTML('beforeend', `<div class="rollbar end" title="Drag up to roll back: see the part as it was at an earlier step.">Rollback bar</div>`);
      this.bindRollbar(t.querySelector('.rollbar'));
    }
  }
  bindRollbar(bar) {
    bar.onpointerdown = (e) => {
      if (this.mode !== 'part' || this.dialog) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('drag');
      const rows = [...$('#tree').querySelectorAll('.trow[data-id]')];
      const move = (ev) => { bar.style.transform = `translateY(${ev.clientY - e.clientY}px)`; };
      const up = (ev) => {
        bar.releasePointerCapture(e.pointerId);
        bar.onpointermove = null; bar.onpointerup = null;
        let idx = rows.length;
        for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { idx = i; break; } }
        this.doc.rollback = idx >= this.doc.features.length ? null : idx;
        this.pushUndo();
        this.regenNow();
      };
      bar.onpointermove = move; bar.onpointerup = up;
    };
  }
  featureMenu(id, x, y) {
    const f = this.doc.features.find(k => k.id === id);
    if (!f) return;
    const items = [{ label: 'Edit', act: () => this.editFeature(id) }, { label: 'Rename', act: () => this.renameFeature(id) }];
    if (f.t === 'sketch') {
      items.push({ label: this.sketchVisible(f) ? 'Hide sketch' : 'Show sketch', act: () => { f.show = !this.sketchVisible(f); this.renderTree(); this.view.request(); } });
      items.push({ label: 'Export sketch as DXF (laser, router)', act: () => this.exportSketch(id, 'dxf') });
      items.push({ label: 'Export sketch as SVG', act: () => this.exportSketch(id, 'svg') });
    }
    items.push({ label: f.suppressed ? 'Turn back on (unsuppress)' : 'Turn off (suppress)', act: () => { f.suppressed = !f.suppressed; this.pushUndo(); this.regenNow(); } });
    const idx = this.doc.features.indexOf(f);
    items.push({ label: 'Roll back to here', act: () => { this.doc.rollback = idx; this.pushUndo(); this.regenNow(); } });
    if (this.doc.rollback != null) items.push({ label: 'Roll to the end', act: () => { this.doc.rollback = null; this.pushUndo(); this.regenNow(); } });
    items.push({ label: 'Delete', danger: true, act: () => this.deleteFeature(id) });
    this.menu({ x, y }, items);
  }
  renameFeature(id) {
    const f = this.doc.features.find(k => k.id === id);
    this.prompt('Rename', f.name, (v) => { if (v.trim()) { f.name = v.trim(); this.pushUndo(); this.renderTree(); } });
  }
  editFeature(id) {
    if (this.mode === 'sketch') return;
    const f = this.doc.features.find(k => k.id === id);
    if (!f) return;
    if (f.t === 'sketch') return this.enterSketch(id);
    this.openDialog(f.t, id);
  }
  deleteFeature(id) {
    const f = this.doc.features.find(k => k.id === id);
    if (!f) return;
    const deps = dependents(this.doc, id);
    const doIt = () => {
      const kill = new Set([id, ...deps]);
      const before = this.doc.features.length;
      const idxs = this.doc.features.map((g, i) => kill.has(g.id) ? i : -1).filter(i => i >= 0);
      this.doc.features = this.doc.features.filter(g => !kill.has(g.id));
      for (const g of this.doc.features) if (g.feats) g.feats = g.feats.filter(x => !kill.has(x));
      if (this.doc.rollback != null) this.doc.rollback -= idxs.filter(i => i < this.doc.rollback).length;
      if (this.doc.rollback != null && this.doc.rollback >= this.doc.features.length) this.doc.rollback = null;
      this.selFeature = null;
      this.pushUndo(); this.regenNow();
    };
    if (deps.length) this.confirm('Delete ' + f.name + '?', 'These use it and will be deleted too: <b>' + deps.map(d => esc(this.featName(d))).join(', ') + '</b>. You can Undo.', 'Delete all', doIt, true);
    else doIt();
  }

  // ---------- dialogs ----------
  openDialog(type, editId) {
    if (this.mode !== 'part') return;
    if (this.dialog) this.closeDialog(false);
    if (this.picking) this.cancelPick();
    if (this.measure) this.toggleMeasure();
    this.dialog = new FeatureDialog(this, type, editId);
    this.markTools();
  }
  closeDialog(commit) {
    const d = this.dialog;
    if (!d) return;
    this.dialog = null;
    $('#dlg').hidden = true; $('#dlg').innerHTML = '';
    this.view.setPreview(null);
    if (commit) {
      if (d.editId) { const i = this.doc.features.findIndex(f => f.id === d.editId); this.doc.features[i] = d.d; }
      else this.insertFeature(d.d);
      this.pushUndo();
    }
    this.regenNow();
    this.markTools();
    this.setHint('');
  }
  previewDialog(d) {
    // regenerate with the draft feature in place
    let docUse = this.doc, override;
    if (d.editId) override = d.d;
    else {
      const fs = this.doc.features.slice();
      const pos = this.doc.rollback != null && this.doc.rollback < fs.length ? this.doc.rollback : fs.length;
      fs.splice(pos, 0, d.d);
      docUse = { ...this.doc, features: fs, rollback: this.doc.rollback != null && this.doc.rollback < this.doc.features.length ? this.doc.rollback + 1 : null };
    }
    const old = this.res;
    this.res = regen(docUse, this.M, { override });
    const tools = this.res.tools[d.d.id] || [];
    const col = { new: 0x2b6cd4, add: 0x2f9e44, remove: 0xd63b3b, intersect: 0xd9a400 };
    const prev = tools.map(t => { const m = t.tool.getMesh(); return { pos: m.numProp === 3 ? m.vertProperties.slice() : strideCopy(m.vertProperties, m.numProp), idx: m.triVerts.slice(), color: col[t.op] || 0x2b6cd4 }; });
    this.showResult({ preview: prev });
    if (old) freeResult(old);
    return this.res;
  }

  // ---------- variables ----------
  renderVars() {
    const el = $('#vars');
    const vals = this.res ? this.res.values : {}, errs = this.res ? this.res.varErrors : {};
    if (!this.doc.vars.length) { el.innerHTML = `<div class="vempty">Variables are named numbers, like <code>#width</code>. Click + to add one.</div>`; return; }
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      // only refresh values while typing
      el.querySelectorAll('.vrow').forEach((r, i) => { const v = this.doc.vars[i]; if (!v) return; const o = r.querySelector('.vval'); o.textContent = errs[v.name] ? '!' : fmt(vals[v.name], 3); o.title = errs[v.name] || ''; r.classList.toggle('bad', !!errs[v.name]); });
      return;
    }
    el.innerHTML = this.doc.vars.map((v, i) => `<div class="vrow${errs[v.name] ? ' bad' : ''}" data-i="${i}">
      <span class="vh">#</span><input class="vname" value="${esc(v.name)}" aria-label="Variable name" spellcheck="false">
      <output class="vval" title="${esc(errs[v.name] || '')}">${errs[v.name] ? '!' : fmt(vals[v.name], 3)}</output>
      <input class="vexpr" value="${esc(v.expr)}" title="${esc(v.expr)}" aria-label="Value or formula for ${esc(v.name)}" spellcheck="false">
      <button class="vdel" aria-label="Delete variable">${icon('trash')}</button></div>`).join('');
    el.querySelectorAll('.vrow').forEach(r => {
      const i = +r.dataset.i;
      const nm = r.querySelector('.vname'), ex = r.querySelector('.vexpr');
      nm.onchange = () => this.renameVar(i, nm.value.trim());
      ex.oninput = () => { this.doc.vars[i].expr = ex.value; this.reevalVars(); this.renderVars(); };
      ex.onchange = () => { this.doc.vars[i].expr = ex.value.trim() || '0'; this.varsChanged(); };
      ex.onkeydown = nm.onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
      r.querySelector('.vdel').onclick = () => {
        const name = this.doc.vars[i].name;
        const used = this.varUsers(name);
        const go = () => { this.doc.vars.splice(i, 1); this.varsChanged(); };
        if (used.length) this.confirm('Delete #' + name + '?', 'It is used in: ' + used.map(esc).join(', ') + '. Those will show an error until you fix them.', 'Delete', go, true);
        else go();
      };
    });
  }
  varsChanged() {
    this.pushUndo();
    if (this.mode === 'sketch') { this.reevalVars(); const r = this.sk.sk; const s = (r && this.res) ? this.sk.commit() : null; this.renderVars(); return; }
    this.regenNow();
  }
  varUsers(name) {
    const re = new RegExp('#' + name + '\\b');
    const out = [];
    for (const v of this.doc.vars) if (re.test(v.expr)) out.push('#' + v.name);
    for (const f of this.doc.features) {
      const txt = JSON.stringify(f.t === 'sketch' ? f.cons.map(c => c.v || '') : f);
      if (re.test(txt)) out.push(f.name);
    }
    return out;
  }
  addVariable() {
    let k = 1, name = 'size';
    const names = new Set(this.doc.vars.map(v => v.name));
    while (names.has(name)) name = 'size' + (++k);
    this.doc.vars.push({ name, expr: '10' });
    this.varsChanged();
    setTimeout(() => { const r = $('#vars').lastElementChild; if (r) { const i = r.querySelector('.vname'); i.focus(); i.select(); } }, 0);
  }
  renameVar(i, nn) {
    const v = this.doc.vars[i], old = v.name;
    if (nn === old) return;
    if (!VAR_NAME_RE.test(nn)) { this.toast('Names start with a letter and use letters, numbers or _ (no spaces).', 'bad'); this.renderVars(); return; }
    if (this.doc.vars.some((x, j) => j !== i && x.name === nn)) { this.toast('There is already a #' + nn + '.', 'bad'); this.renderVars(); return; }
    const re = new RegExp('#' + old + '\\b', 'g');
    v.name = nn;
    for (const x of this.doc.vars) x.expr = x.expr.replace(re, '#' + nn);
    const fix = (o) => { for (const k in o) { if (typeof o[k] === 'string') o[k] = o[k].replace(re, '#' + nn); else if (o[k] && typeof o[k] === 'object') fix(o[k]); } };
    for (const f of this.doc.features) fix(f);
    this.toast('Renamed #' + old + ' to #' + nn + ' everywhere it was used.');
    this.varsChanged();
  }

  // ---------- parts ----------
  renderParts() {
    const el = $('#parts');
    const bodies = this.res ? this.res.bodies : [];
    if (!bodies.length) { el.innerHTML = `<div class="vempty">No solid parts yet.</div>`; return; }
    el.innerHTML = bodies.map(b => {
      const color = (this.doc.colors && this.doc.colors[b.id]) || PALETTE[b.idx % PALETTE.length];
      return `<div class="prow" data-id="${b.id}"><input type="color" class="pcol" value="${color}" aria-label="Part color"><span class="pn">${esc(b.name)}</span><span class="pv">${fmt(b.man.volume() / 1000, 2)} cm³</span>
      <button class="teye" data-hide="${b.id}" aria-label="Show or hide part">${icon(this.hidden.has(b.id) ? 'eyeoff' : 'eye')}</button>
      <button class="teye" data-stl="${b.id}" aria-label="Export this part as STL" title="Export STL">${icon('export')}</button></div>`;
    }).join('');
    el.querySelectorAll('[data-hide]').forEach(bt => bt.onclick = () => { const id = bt.dataset.hide; this.hidden.has(id) ? this.hidden.delete(id) : this.hidden.add(id); this.showResult(); });
    el.querySelectorAll('[data-stl]').forEach(bt => bt.onclick = () => this.exportSTL([bt.dataset.stl]));
    el.querySelectorAll('.pcol').forEach(inp => inp.onchange = () => { const id = inp.closest('.prow').dataset.id; (this.doc.colors ||= {})[id] = inp.value; this.pushUndo(); this.showResult(); });
  }

  // ---------- mass properties ----------
  toggleMass() { if (this.card === 'mass') this.closeCard(); else { this.card = 'mass'; this.renderMass(); } this.markTools(); }
  closeCard() { this.card = null; $('#card').hidden = true; this.markTools(); }
  renderMass() {
    const el = $('#card');
    el.hidden = false;
    const mat = MATERIALS.find(m => m.id === this.doc.material) || MATERIALS[0];
    const infill = this.doc.infill ?? 15;
    const bodies = (this.res ? this.res.bodies : []).filter(b => !this.hidden.has(b.id));
    let V = 0, A = 0;
    const rows = bodies.map(b => { const v = b.man.volume(), a = b.man.surfaceArea(); V += v; A += a; return { b, v, a }; });
    const bb = this.bbox();
    const size = bb ? bb.max.map((v, i) => v - bb.min[i]) : [0, 0, 0];
    const cm3 = V / 1000, g = cm3 * mat.rho;
    const wall = 0.9;
    const shell = Math.min(V, A * wall), printG = ((shell + (V - shell) * infill / 100) / 1000) * mat.rho;
    el.innerHTML = `<div class="dh">${icon('mass')}<b>Mass and volume</b><button class="x" aria-label="Close">${icon('cancel')}</button></div>
      <label class="fl">Material <select id="matSel">${MATERIALS.map(m => `<option value="${m.id}"${m.id === mat.id ? ' selected' : ''}>${m.name} · ${m.rho} g/cm³</option>`).join('')}</select></label>
      ${bodies.length ? `<div class="big"><span>${fmt(g, 1)} g</span><small>if solid ${mat.name.split(' (')[0]}</small></div>
      <table class="mt"><tr><td>Volume</td><td>${fmt(cm3, 2)} cm³</td></tr><tr><td>Surface area</td><td>${fmt(A / 100, 2)} cm²</td></tr>
      <tr><td>Size (X × Y × Z)</td><td>${fmt(size[0], 1)} × ${fmt(size[1], 1)} × ${fmt(size[2], 1)} mm</td></tr>
      <tr><td></td><td>${fmt(size[0] / 25.4, 2)} × ${fmt(size[1] / 25.4, 2)} × ${fmt(size[2] / 25.4, 2)} in</td></tr></table>
      ${mat.print ? `<label class="fl">Infill for a 3D print: <b id="infV">${infill}%</b><input id="infill" type="range" min="0" max="100" step="5" value="${infill}"></label>
      <div class="note">Rough print estimate: <b>${fmt(printG, 1)} g</b> (2 walls of 0.45 mm, ${infill}% infill). The slicer's number is better, and the scale is best.</div>` : ''}
      ${rows.length > 1 ? `<table class="mt sm">${rows.map(r => `<tr><td>${esc(r.b.name)}</td><td>${fmt(r.v / 1000, 2)} cm³ · ${fmt(r.v / 1000 * mat.rho, 1)} g</td></tr>`).join('')}</table>` : ''}
      <div class="note">Mass = volume × density. ${fmt(cm3, 2)} cm³ × ${mat.rho} g/cm³ = ${fmt(g, 1)} g</div>` : '<p class="dp">Make a solid part first.</p>'}`;
    el.querySelector('.x').onclick = () => this.closeCard();
    $('#matSel').onchange = (e) => { this.doc.material = e.target.value; this.autosave(); this.renderMass(); };
    const inf = $('#infill'); if (inf) inf.oninput = () => { this.doc.infill = +inf.value; this.renderMass(); };
  }

  // ---------- measure ----------
  toggleMeasure() {
    if (this.measure) { this.measure = null; $('#card').hidden = true; this.card = null; this.view.request(); this.setHint(''); }
    else { if (this.dialog) this.closeDialog(false); this.measure = { picks: [], hover: null }; this.card = 'measure'; this.renderMeasure(); this.setHint('Measure: click a corner or a flat face, then a second one. Esc to stop.'); }
    this.markTools();
  }
  measureTarget(x, y) {
    // nearest mesh vertex within 10px, else face
    let best = null, bs = Infinity;
    const vd = this.view.viewDir(), cam = this.view.camera.position;
    for (const B of this.view.bodies) {
      if (!B.obj.visible) continue;
      const P = B.mesh.pos;
      for (let i = 0; i < P.length; i += 3) {
        const [sx, sy] = this.view.project([P[i], P[i + 1], P[i + 2]]);
        const d = Math.hypot(sx - x, sy - y);
        if (d > 10) continue;
        const depth = (P[i] - cam.x) * vd.x + (P[i + 1] - cam.y) * vd.y + (P[i + 2] - cam.z) * vd.z;
        const score = Math.round(d / 3) * 1e6 + depth;   // nearest on screen, then nearest the camera
        if (score < bs) { bs = score; best = { k: 'pt', p: [P[i], P[i + 1], P[i + 2]] }; }
      }
    }
    if (best) {
      // make sure the vertex is not hidden behind the part
      const hit = this.view.pickFace(x, y);
      if (!hit || Math.hypot(...hit.point.map((v, i) => v - best.p[i])) < 0.5 || this.view.viewDir().dot({ x: best.p[0] - hit.point[0], y: best.p[1] - hit.point[1], z: best.p[2] - hit.point[2] }) < 0.5) return best;
    }
    const hit = this.view.pickFace(x, y);
    if (hit) return { k: 'face', hit, n: hit.normal, p: hit.point, area: hit.grp.area, loops: groupLoops(this.view.bodies[hit.bodyIdx].mesh.pos, this.view.bodies[hit.bodyIdx].mesh.idx, hit.grp) };
    return null;
  }
  measureHover(x, y) {
    const t = this.measureTarget(x, y);
    this.measure.hover = t;
    if (t && t.k === 'face') this.view.highlightGroup(t.hit.bodyIdx, t.hit.group, 0xf7c58f); else this.view.clearHighlight();
    this.view.request();
  }
  measureClick(x, y) {
    const t = this.measureTarget(x, y);
    if (!t) { this.measure.picks = []; this.renderMeasure(); this.view.request(); return; }
    if (this.measure.picks.length >= 2) this.measure.picks = [];
    this.measure.picks.push(t);
    this.renderMeasure();
    this.view.request();
  }
  renderMeasure() {
    const el = $('#card'); el.hidden = false;
    const P = this.measure.picks;
    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    let body = '<p class="dp">Click a corner or a flat face.</p>';
    if (P.length === 1) {
      const a = P[0];
      if (a.k === 'pt') body = `<table class="mt"><tr><td>Point</td><td>${a.p.map(v => fmt(v, 2)).join(', ')}</td></tr></table><p class="dp">Click a second corner or face.</p>`;
      else {
        let per = 0; for (const L of a.loops) for (let i = 0; i < L.length; i++) per += len(L[i].map((v, k) => v - L[(i + 1) % L.length][k]));
        body = `<table class="mt"><tr><td>Face area</td><td>${fmt(a.area, 2)} mm² (${fmt(a.area / 100, 2)} cm²)</td></tr><tr><td>Perimeter</td><td>${fmt(per, 2)} mm</td></tr></table><p class="dp">Click a second corner or face.</p>`;
      }
    }
    if (P.length === 2) {
      const [a, b] = P;
      let rows = '';
      if (a.k === 'pt' && b.k === 'pt') {
        const d = b.p.map((v, i) => v - a.p[i]);
        rows = `<tr><td>Distance</td><td><b>${fmt(len(d), 2)} mm</b></td></tr><tr><td>ΔX, ΔY, ΔZ</td><td>${d.map(v => fmt(Math.abs(v), 2)).join(', ')}</td></tr><tr><td></td><td>${fmt(len(d) / 25.4, 3)} in</td></tr>`;
      } else if (a.k === 'face' && b.k === 'face') {
        const c = Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]);
        if (c > 0.9999) { const d = Math.abs((b.p[0] - a.p[0]) * a.n[0] + (b.p[1] - a.p[1]) * a.n[1] + (b.p[2] - a.p[2]) * a.n[2]); rows = `<tr><td>Distance between faces</td><td><b>${fmt(d, 2)} mm</b></td></tr><tr><td></td><td>${fmt(d / 25.4, 3)} in</td></tr>`; }
        else { const ang = Math.acos(Math.max(-1, Math.min(1, a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]))) * 180 / Math.PI; rows = `<tr><td>Angle between faces</td><td><b>${fmt(180 - ang, 2)}°</b></td></tr><tr><td>Angle between normals</td><td>${fmt(ang, 2)}°</td></tr>`; }
      } else {
        const f = a.k === 'face' ? a : b, p = a.k === 'pt' ? a : b;
        const d = Math.abs((p.p[0] - f.p[0]) * f.n[0] + (p.p[1] - f.p[1]) * f.n[1] + (p.p[2] - f.p[2]) * f.n[2]);
        rows = `<tr><td>Point to face</td><td><b>${fmt(d, 2)} mm</b></td></tr>`;
      }
      body = `<table class="mt">${rows}</table><p class="dp">Click again to start a new measurement.</p>`;
    }
    el.innerHTML = `<div class="dh">${icon('measure')}<b>Measure</b><button class="x" aria-label="Close">${icon('cancel')}</button></div>${body}`;
    el.querySelector('.x').onclick = () => this.toggleMeasure();
  }
  drawMeasure(ctx) {
    const m = this.measure;
    const mark = (t, col) => {
      if (!t) return;
      if (t.k === 'pt') { const [x, y] = this.view.project(t.p); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke(); }
      else { for (const L of t.loops) { ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); L.forEach((p, i) => { const [x, y] = this.view.project(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); } }
    };
    m.picks.forEach(p => mark(p, '#f28c28'));
    if (m.hover && m.hover.k === 'pt') mark(m.hover, '#f59e0b');
    if (m.picks.length === 2 && m.picks[0].k === 'pt' && m.picks[1].k === 'pt') {
      const [a, b] = m.picks.map(p => this.view.project(p.p));
      ctx.strokeStyle = '#f28c28'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ---------- export ----------
  exportMenu(btn) {
    const items = [
      { label: 'STL of all visible parts (3D printer)', act: () => this.exportSTL() },
    ];
    if (this.res && this.res.bodies.length > 1) items.push({ label: 'STL of each part (separate files)', act: () => this.res.bodies.forEach(b => this.exportSTL([b.id])) });
    const sel = this.doc.features.find(f => f.id === (this.mode === 'sketch' ? this.sk.id : this.selFeature));
    if (sel && sel.t === 'sketch') {
      items.push({ label: 'Sketch "' + sel.name + '" as DXF (laser, router)', act: () => this.exportSketch(sel.id, 'dxf') });
      items.push({ label: 'Sketch "' + sel.name + '" as SVG', act: () => this.exportSketch(sel.id, 'svg') });
    } else items.push({ label: 'Sketch as DXF or SVG: select a sketch in the list first', disabled: true });
    items.push({ label: 'A flat face as DXF: right-click the face', disabled: true });
    items.push({ label: 'Picture of the view (PNG)', act: () => this.exportPNG() });
    items.push({ label: 'Save the project file (.json)', act: () => this.saveProject() });
    this.menu(btn, items);
  }
  exportSTL(ids) {
    const bodies = (this.res ? this.res.bodies : []).filter(b => ids ? ids.includes(b.id) : !this.hidden.has(b.id));
    if (!bodies.length) { this.toast('There is no solid part to export yet.'); return; }
    const data = stlBinary(bodies.map(b => b.mesh));
    const name = safeName(this.doc.name) + (ids && ids.length === 1 ? '-' + safeName(bodies[0].name) : '') + '.stl';
    download(name, data, (m, k) => this.toast(m, k));
  }
  exportSketch(id, fmtName) {
    const f = this.doc.features.find(x => x.id === id);
    const shapes = sketchShapes(f);
    if (!shapes.length) { this.toast('That sketch has no solid lines to export (construction lines are skipped).'); return; }
    const name = safeName(this.doc.name) + '-' + safeName(f.name) + '.' + fmtName;
    download(name, fmtName === 'dxf' ? toDXF(shapes) : toSVG(shapes, f.name), (m, k) => this.toast(m, k));
  }
  exportFace(hit, fmtName) {
    const B = this.view.bodies[hit.bodyIdx];
    const loops = groupLoops(B.mesh.pos, B.mesh.idx, hit.grp);
    const pl = planeFrom(hit.point, hit.normal);
    const loc = loops.map(L => L.map(p => { const d = [p[0] - pl.o[0], p[1] - pl.o[1], p[2] - pl.o[2]]; return [d[0] * pl.x[0] + d[1] * pl.x[1] + d[2] * pl.x[2], d[0] * pl.y[0] + d[1] * pl.y[1] + d[2] * pl.y[2]]; }));
    const shapes = loopShapes(loc);
    const name = safeName(this.doc.name) + '-face.' + fmtName;
    download(name, fmtName === 'dxf' ? toDXF(shapes) : toSVG(shapes, 'Face'), (m, k) => this.toast(m, k));
  }
  exportPNG() {
    this.view.render();
    const c = document.createElement('canvas');
    c.width = this.view.renderer.domElement.width; c.height = this.view.renderer.domElement.height;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(this.view.renderer.domElement, 0, 0); g.drawImage(this.view.overlay, 0, 0, c.width, c.height);
    c.toBlob(async (b) => { const buf = new Uint8Array(await b.arrayBuffer()); download(safeName(this.doc.name) + '.png', buf, (m, k) => this.toast(m, k)); });
  }
  saveProject() {
    const s = JSON.stringify(this.doc, strip, 1);
    download(safeName(this.doc.name) + '.geocad3d.json', s, (m, k) => this.toast(m, k));
  }
  openFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d.app !== 'geocad3d' || !Array.isArray(d.features)) throw new Error('not a part file');
        this.loadDoc(d);
        this.toast('Opened ' + file.name);
      } catch (e) { this.toast('That file is not a Geo-CAD 3D part (.json). For drawings, use TS 82 CAD.', 'bad'); }
      $('#fileIn').value = '';
    };
    r.readAsText(file);
  }

  // ---------- small UI helpers ----------
  toast(msg, kind) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'bad' ? ' bad' : '');
    el.textContent = msg;
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4700);
  }
  menu(anchor, items) {
    const old = $('#menu'); if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'menu'; m.className = 'menu';
    m.innerHTML = items.map((it, i) => `<button data-i="${i}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('');
    document.body.appendChild(m);
    let x, y;
    if (anchor.getBoundingClientRect) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; } else { x = anchor.x; y = anchor.y; }
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, x)) + 'px';
    m.style.top = Math.max(4, Math.min(window.innerHeight - mh - 4, y)) + 'px';
    m.querySelectorAll('button').forEach(b => b.onclick = () => { m.remove(); items[+b.dataset.i].act(); });
    setTimeout(() => {
      const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  }
  modal(html, wide) {
    const md = $('#modal');
    md.innerHTML = `<div class="mbox${wide ? ' wide' : ''}" role="dialog">${html}</div>`;
    md.hidden = false;
    md.onclick = (e) => { if (e.target === md) this.closeModal(); };
    return md.firstChild;
  }
  closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  confirm(title, body, okLabel, fn, danger) {
    const b = this.modal(`<h3>${esc(title)}</h3><p>${body}</p><div class="mfoot"><button class="btn" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="ok">${esc(okLabel)}</button></div>`);
    b.querySelector('[data-a=no]').onclick = () => this.closeModal();
    b.querySelector('[data-a=ok]').onclick = () => { this.closeModal(); fn(); };
    setTimeout(() => b.querySelector('[data-a=ok]').focus(), 0);
  }
  prompt(title, val, fn) {
    const b = this.modal(`<h3>${esc(title)}</h3><input class="minput" value="${esc(val)}" spellcheck="false"><div class="mfoot"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="ok">OK</button></div>`);
    const inp = b.querySelector('input');
    const ok = () => { this.closeModal(); fn(inp.value); };
    b.querySelector('[data-a=no]').onclick = () => this.closeModal();
    b.querySelector('[data-a=ok]').onclick = ok;
    inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }
  showWelcome() {
    const b = this.modal(`<div class="welcome"><img src="${window.BUNNY && window.BUNNY.peek || ''}" alt="" class="bun">
      <div><h3>Welcome to Geo-CAD 3D</h3>
      <p>This is a Part Studio, like Onshape. Every part starts as a <b>2D sketch</b> that you make exact with sizes and rules, then <b>Extrude</b> or <b>Revolve</b> turns it 3D.</p>
      <ol class="steps"><li>Click <b>Sketch</b>, then click the <b>Top</b> plane.</li><li>Draw a rectangle. It turns <b style="color:#1f6fd1">blue</b>: it can still move.</li><li>Click <b>Dimension</b>, click a side, and type <code>40</code> or <code>#width</code>.</li><li>When it's all <b>black</b>, it's fully defined. Click the green check.</li><li>Click <b>Extrude</b>, type a depth, click the green check. That's a part!</li></ol>
      <p class="dp">The plate on screen is an example. Try changing <code>#width</code> in the Variables box and watch it update.</p></div></div>
      <div class="mfoot"><button class="btn" data-a="guide">Open the guide</button><button class="btn primary" data-a="ok">Let's go</button></div>`, true);
    b.querySelector('[data-a=ok]').onclick = () => this.closeModal();
    b.querySelector('[data-a=guide]').onclick = () => { this.closeModal(); this.showGuide(); };
  }
  showGuide() {
    const groups = [['Part tools', ['sketch', 'extrude', 'revolve', 'plane', 'lpattern', 'cpattern', 'mirror', 'measure', 'mass', 'vars']], ['Sketch drawing tools', ['select', 'line', 'rect', 'rectc', 'circle', 'arc3', 'arcc', 'arct', 'polygon', 'slot', 'point', 'fillet', 'trim', 'smirror', 'construction', 'use']], ['Sizes and rules', ['dimension', 'coin', 'h', 'v', 'par', 'perp', 'tan', 'eq', 'mid', 'conc', 'sym', 'fix']]];
    const b = this.modal(`<div class="guide"><div class="ghead"><img src="${window.BUNNY && window.BUNNY.loaf || ''}" alt="" class="bun sm"><div><h3>Geo-CAD 3D guide</h3><p class="dp">How it works, then every button.</p></div><button class="x" aria-label="Close">${icon('cancel')}</button></div>
      ${GUIDE.map(s => `<section><h4>${s.h}</h4>${s.p.map(p => `<p>${p}</p>`).join('')}</section>`).join('')}
      ${groups.map(([h, ids]) => `<section><h4>${h}</h4><div class="tgrid">${ids.map(id => `<div class="tcard">${tipHTML(id)}</div>`).join('')}</div></section>`).join('')}
      </div>`, true);
    b.querySelector('.x').onclick = () => this.closeModal();
  }
}

function strideCopy(src, np) { const n = src.length / np, out = new Float32Array(n * 3); for (let i = 0; i < n; i++) { out[i * 3] = src[i * np]; out[i * 3 + 1] = src[i * np + 1]; out[i * 3 + 2] = src[i * np + 2]; } return out; }
function growBB(bb, p) { if (!bb) return { min: p.slice(), max: p.slice() }; for (let i = 0; i < 3; i++) { bb.min[i] = Math.min(bb.min[i], p[i]); bb.max[i] = Math.max(bb.max[i], p[i]); } return bb; }
function segDist(x, y, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1e-9; let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
function originIcon() { return `<svg class="ic" viewBox="0 0 24 24"><path d="M12 12h9 M12 12V3 M12 12l-7 7" /></svg>`; }
export { segDist };
