// Interactive lessons: a card says what to click and why, a ring goes round the button,
// a green "click here" spot marks the place in the view, and each step waits until it's done.
import { newDoc, newId } from './model.js';
import { getPt, isDim, measureDim } from './solver.js';
import { evaluate, fmt } from './expr.js';
import { icon } from './help.js';
import { builder, finish } from './examples.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const I = (n) => `<span class="ii">${icon(n)}</span>`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

// ---------- helpers the lessons use ----------
function helpers(app) {
  const H = {
    app,
    ed: app.sk,
    sk: () => (app.mode === 'sketch' ? app.sk.sk : null),
    P: (id) => getPt(app.sk.sk, id),
    lines: () => { const s = H.sk(); return s ? s.ents.filter(e => e.t === 'line' && !e.cons && !e.ref) : []; },
    circles: () => { const s = H.sk(); return s ? s.ents.filter(e => e.t === 'circle' && !e.cons) : []; },
    mid: (l) => { const a = H.P(l.a), b = H.P(l.b); return [(a.x + b.x) / 2, (a.y + b.y) / 2]; },
    edge: (which) => {
      const ls = H.lines();
      const horiz = ls.filter(l => { const a = H.P(l.a), b = H.P(l.b); return Math.abs(a.y - b.y) < 1e-6; });
      const vert = ls.filter(l => { const a = H.P(l.a), b = H.P(l.b); return Math.abs(a.x - b.x) < 1e-6; });
      const by = (arr, f, dir) => arr.sort((p, q) => dir * (f(H.mid(p)) - f(H.mid(q))))[0] || null;
      if (which === 'bottom') return by(horiz, m => m[1], 1);
      if (which === 'top') return by(horiz, m => m[1], -1);
      if (which === 'left') return by(vert, m => m[0], 1);
      return by(vert, m => m[0], -1);
    },
    dims: () => { const s = H.sk(); return s ? s.cons.filter(c => isDim(c) && !c.driven) : []; },
    dimVal: (v) => H.dims().find(c => { try { return near(evaluate(c.v, app.res.values), v, 1e-6); } catch (e) { return false; } }),
    val: (name) => app.res && app.res.values ? app.res.values[name] : undefined,
    feats: (t) => app.doc.features.filter(f => f.t === t && !f.suppressed),
    num: (src) => { try { return evaluate(src, app.res.values); } catch (e) { return NaN; } },
    bbox: () => app.bbox(),
    // simulated input for "Do it for me"
    tool: (id) => app.toolClick(id),
    click: (u, v) => { const [x, y] = app.sk.scr(u, v); app.sk.mouse = [x, y]; app.sk.move(x, y, {}); app.sk.click(x, y, { shiftKey: false }); app.view.request(); },
    type: (txt) => { if (app.sk.inputEl) { app.sk.inputEl.value = txt; app.sk.applyInput(); } },
    dimLine: (l, off, txt) => {
      if (app.sk.tool !== 'dimension') app.sk.setTool('dimension');
      const m = H.mid(l); H.click(m[0], m[1]);
      H.click(m[0] + off[0], m[1] + off[1]);
      if (txt != null) H.type(txt);
    },
    setVar: (name, expr) => { const v = app.doc.vars.find(x => x.name === name); if (v) { v.expr = expr; app.varsChanged(); } },
    varInput: (name, cls = '.vexpr') => { const i = app.doc.vars.findIndex(v => v.name === name); return i < 0 ? null : $(`.vrow[data-i="${i}"] ${cls}`); },
    dlgInput: (key, txt) => { const i = $(`[data-x="${key}"]`); if (!i) return; i.value = txt; i.dispatchEvent(new Event('input')); },
    treeRow: (name) => { const f = app.doc.features.find(x => x.name === name); return f ? $(`.trow[data-id="${f.id}"]`) : null; },
    menuItem: (txt) => [...document.querySelectorAll('#menu button')].find(b => b.textContent.includes(txt)) || null,
  };
  return H;
}

// ---------- starting parts ----------
function plateDoc(name, withHole) {
  const doc = newDoc(name);
  const B = builder(doc, { k: 'std', name: 'Top' }, 'Plate sketch');
  B.centerRect(60, 40, '60', '40');
  doc.features.push({ id: newId(doc), t: 'extrude', name: 'Extrude 1', sketch: B.sk.id, regions: { auto: true }, op: 'new', end: 'blind', depth: '5', flip: false });
  if (withHole) {
    const ext = doc.features[1].id;
    const H = builder(doc, { k: 'face', f: ext, role: 'end' }, 'Hole sketch');
    const c = H.p(-20, 0), k = H.circle(c, 3);
    H.con({ t: 'on', p: c, e: 'XAX' });
    H.con({ t: 'dist', p: c, q: 'O', dir: 'h', s: 1, v: '20', lab: [0, -8] });
    H.con({ t: 'dia', e: k, v: '6', lab: [6, 6] });
    doc.features.push({ id: newId(doc), t: 'extrude', name: 'Hole cut', sketch: H.sk.id, regions: { auto: true }, op: 'remove', end: 'through', depth: '10', flip: false });
  }
  return finish(doc);
}
function tagDoc() {
  const doc = newDoc('Name tag');
  doc.vars.push({ name: 'width', expr: '60' }, { name: 'height', expr: '30' }, { name: 'thick', expr: '3' }, { name: 'hole', expr: '6' });
  const B = builder(doc, { k: 'std', name: 'Top' }, 'Tag outline');
  const { L } = B.centerRect(60, 30, '#width', '#height');
  const c = B.p(0, 0), k = B.circle(c, 3);
  B.con({ t: 'on', p: c, e: 'XAX' });
  B.con({ t: 'pldist', p: c, e: L[3], v: '30', s: 1, lab: [0, 9] });
  B.con({ t: 'dia', e: k, v: '#hole', lab: [7, -7] });
  doc.features.push({ id: newId(doc), t: 'extrude', name: 'Extrude 1', sketch: B.sk.id, regions: { auto: true }, op: 'new', end: 'blind', depth: '#thick', flip: false });
  return finish(doc);
}

// ---------- the lessons ----------
function lessons() {
  const SK = (H) => H.app.mode === 'sketch';
  const PART = (H) => H.app.mode === 'part';
  const DLG = (t) => (H) => H.app.dialog && H.app.dialog.type === t;
  const finishStep = {
    say: `Click ${I('finish')} <b>Finish sketch</b>.`, why: 'It\'s at the right end of the blue bar. This closes the sketch and goes back to 3D.',
    ring: () => $('#optbar [data-tool=finish]'), done: PART, auto: (H) => H.app.exitSketch(),
  };
  return [
    // ---------------------------------------------------------------- 1
    {
      id: 'first', title: 'Your first part', time: '5 min', learn: 'Sketch a rectangle, give it exact sizes, and extrude it into a 3D plate.',
      start: () => newDoc('My first part'),
      steps: [
        { intro: true, say: 'Let\'s make a plate 60 mm by 40 mm, 5 mm thick.', why: 'Every part starts as a flat drawing called a <b>sketch</b>. You draw rough shapes first, then make them exact. Then you turn the sketch into 3D. This card will show you where to click and wait for you.' },
        { say: `Click ${I('sketch')} <b>Sketch</b>.`, why: 'It\'s the first button in the toolbar at the top.', ring: '[data-tool=sketch]', done: (H) => H.app.picking === 'plane' || SK(H), auto: (H) => H.tool('sketch') },
        { say: 'Click <b>Top</b>.', why: 'A sketch needs a flat surface to draw on. The Top plane is like a sheet of paper lying on the table.', ring: () => $('[data-p=Top]'), need: (H) => H.app.picking === 'plane' || SK(H), done: SK, auto: (H) => { H.app.cancelPick(); H.app.createSketch({ k: 'std', name: 'Top' }); } },
        { say: `Click ${I('rectc')} <b>Ctr rect</b> (center rectangle).`, why: 'It draws a rectangle from its middle out, so the plate is centered on the origin.', ring: '[data-tool=rectc]', need: SK, done: (H) => H.ed.tool === 'rectc', auto: (H) => H.ed.setTool('rectc') },
        { say: 'Click the <b>origin</b>: the dark dot where the red and green dashed lines cross.', why: 'The origin is the 0, 0 point. Starting there keeps the plate centered.', dot: (H) => [0, 0], need: SK, done: (H) => H.ed.tool === 'rectc' && H.ed.op && H.ed.op.s0, check: (H) => H.ed.op && H.ed.op.s0 && H.ed.op.s0.id !== 'O' ? 'That wasn\'t quite on the origin. Press Esc and click right on the dot.' : null, auto: (H) => H.click(0, 0) },
        { say: 'Click up and to the right to set a corner.', why: 'Don\'t worry about the size yet. You\'ll make it exact next.', dot: (H) => [30, 20], need: (H) => SK(H) && ((H.ed.op && H.ed.op.s0) || H.lines().length >= 4), done: (H) => H.lines().length >= 4, auto: (H) => H.click(30, 20) },
        { say: 'See the blue? Blue means it can still change.', why: 'The bar at the bottom says how many sizes or rules are still missing. Right now the width and height are not decided.', manual: true, need: SK },
        { say: `Click ${I('dimension')} <b>Dimension</b>.`, why: 'A dimension sets an exact size.', ring: '[data-tool=dimension]', need: SK, done: (H) => H.ed.tool === 'dimension', auto: (H) => H.ed.setTool('dimension') },
        { say: 'Click the <b>bottom edge</b> of the rectangle.', why: 'That picks the line you want to measure.', dot: (H) => { const l = H.edge('bottom'); const m = l && H.mid(l); return m && [m[0] + 8, m[1]]; }, need: SK, done: (H) => H.ed.op && H.ed.op.place && H.ed.op.picks.length === 1, auto: (H) => { const m = H.mid(H.edge('bottom')); H.click(m[0] + 8, m[1]); } },
        { say: 'Click below the rectangle to place the number.', why: 'The number can go anywhere that\'s easy to read.', dot: (H) => { const l = H.edge('bottom'); const m = l && H.mid(l); return m && [m[0] + 8, m[1] - 10]; }, need: (H) => SK(H) && ((H.ed.op && H.ed.op.place) || H.ed.inputCon), done: (H) => !!H.ed.inputCon, auto: (H) => { const m = H.mid(H.edge('bottom')); H.click(m[0] + 8, m[1] - 10); } },
        { say: 'Type <code>60</code> and press <b>Enter</b>.', why: 'All sizes are in millimeters.', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.dimVal(60)), done: (H) => !H.ed.inputCon && !!H.dimVal(60), auto: (H) => H.type('60') },
        { say: 'Click the <b>right edge</b>.', why: 'The Dimension tool is still on, so you can keep going.', dot: (H) => { const l = H.edge('right'); const m = l && H.mid(l); return m && [m[0], m[1] + 6]; }, need: SK, done: (H) => H.ed.tool === 'dimension' && H.ed.op && H.ed.op.place && H.ed.op.picks.length === 1, auto: (H) => { if (H.ed.tool !== 'dimension') H.ed.setTool('dimension'); const m = H.mid(H.edge('right')); H.click(m[0], m[1] + 6); } },
        { say: 'Click to the right of it to place the number.', dot: (H) => { const l = H.edge('right'); const m = l && H.mid(l); return m && [m[0] + 10, m[1] + 6]; }, need: (H) => SK(H) && ((H.ed.op && H.ed.op.place) || H.ed.inputCon), done: (H) => !!H.ed.inputCon, auto: (H) => { const m = H.mid(H.edge('right')); H.click(m[0] + 10, m[1] + 6); } },
        { say: 'Type <code>40</code> and press <b>Enter</b>.', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.dimVal(40)), done: (H) => !H.ed.inputCon && !!H.dimVal(40), auto: (H) => H.type('40') },
        { say: 'It turned <b>black</b>. That means fully defined.', why: 'Every size and position is decided. The bar at the bottom says Fully defined. Engineers aim for this before they build.', manual: true, need: SK, check: (H) => H.ed.status && H.ed.status.dof > 0 ? 'Some of it is still blue. Make sure the rectangle started at the origin.' : null },
        finishStep,
        { say: `Click ${I('extrude')} <b>Extrude</b>.`, why: 'Extrude pushes the sketch straight up to make it 3D.', ring: '[data-tool=extrude]', need: PART, done: DLG('extrude'), auto: (H) => H.tool('extrude') },
        { say: 'In <b>Depth</b>, type <code>5</code>.', why: 'Watch the preview change. You can also drag the orange arrow in the view.', ring: () => $('[data-x=depth]'), need: DLG('extrude'), done: (H) => near(H.num(H.app.dialog.d.depth), 5), auto: (H) => H.dlgInput('depth', '5') },
        { say: `Click ${I('finish')} <b>OK</b>.`, ring: '#dOk', need: (H) => !!H.app.dialog || H.feats('extrude').length, done: (H) => !H.app.dialog && H.feats('extrude').length > 0, auto: (H) => H.app.dialog.ok() },
        { say: '<b>Right-drag</b> in the view to spin your part around.', why: 'Hold the right mouse button and move. On a touchpad, left-drag on empty space works too. Scroll to zoom.', dot: () => null, manual: true, done: (H, s) => s.q0 && H.app.view.camera.quaternion.angleTo(s.q0) > 0.35, enter: (H, s) => { s.q0 = H.app.view.camera.quaternion.clone(); } },
        { outro: true, say: 'You made a part!', why: 'Sketch, make it exact, extrude: that\'s how every part in Onshape and SolidWorks starts too. Next, try <b>Design intent</b>.' },
      ],
    },
    // ---------------------------------------------------------------- 2
    {
      id: 'intent', title: 'Design intent: make it change the right way', time: '10 min', star: true,
      learn: 'Why a part should change the way you mean, and how to choose rules (centered, from an edge, same size) that say it.',
      start: tagDoc,
      steps: [
        { intro: true, say: 'This name tag needs its bolt hole in the exact middle.', why: 'Right now it looks centered. But a part has to keep working when sizes change. <b>Design intent</b> means building in the rules you really mean, so changes go the right way. Let\'s test it.' },
        { say: 'In the <b>Variables</b> box, change <code>#width</code> to <code>90</code>, then press <b>Enter</b>.', why: '#width controls how wide the tag is.', ring: (H) => H.varInput('width'), need: PART, done: (H) => near(H.val('width'), 90) && H.bbox() && near(H.bbox().min[0], -45, 1e-3), auto: (H) => H.setVar('width', '90') },
        { say: 'Look: the hole is <b>not</b> in the middle anymore.', why: 'It was dimensioned <b>30 mm from the left edge</b>. When the tag got wider, it stayed 30 mm from the left edge. The part did what we told it, not what we meant.', manual: true },
        { say: 'Double-click <b>Tag outline</b> in the Feature list.', why: 'That opens the sketch so you can change its rules.', ring: (H) => H.treeRow('Tag outline'), need: (H) => true, done: SK, auto: (H) => H.app.editFeature(H.app.doc.features[0].id) },
        { say: 'Click the <b>30</b> dimension.', why: 'This is the rule that\'s wrong: it measures from the left edge.', dot: (H) => { const c = H.dims().find(c => c.t === 'pldist'); return c && c._lab; }, need: SK, done: (H) => { const c = H.dims().find(c => c.t === 'pldist'); return !c || H.ed.sel.has('c:' + c.id); }, auto: (H) => { const c = H.dims().find(c => c.t === 'pldist'); H.ed.sel.clear(); H.ed.sel.add('c:' + c.id); H.app.view.request(); } },
        { say: 'Press <b>Delete</b> on the keyboard.', why: 'Removing the rule lets the hole move again.', need: SK, done: (H) => !H.dims().some(c => c.t === 'pldist'), auto: (H) => H.ed.deleteSel() },
        { say: 'Drag the hole\'s <b>center dot</b> left and right.', why: 'It\'s blue now: nothing decides where it goes left to right. Blue geometry can be dragged. Black can\'t.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x, c.y]; }, need: SK, manual: true, enter: (H, s) => { const k = H.circles()[0]; s.x0 = k ? H.P(k.c).x : 0; }, done: (H, s) => { const k = H.circles()[0]; return k && Math.abs(H.P(k.c).x - s.x0) > 3; } },
        { say: `Click ${I('coin')} <b>Coincident</b>.`, why: 'It\'s in the <b>Rules</b> group. Coincident puts a point on another point or on a line.', ring: '[data-tool=coin]', need: SK, done: (H) => H.ed.pick && H.ed.pick.type === 'coin', auto: (H) => H.ed.applyConstraint('coin') },
        { say: 'Click the hole\'s <b>center dot</b>.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x, c.y]; }, need: (H) => SK(H) && (H.ed.pick && H.ed.pick.type === 'coin'), done: (H) => { const k = H.circles()[0]; return H.ed.pick && k && H.ed.pick.items.some(i => i.id === k.c); }, auto: (H) => { const k = H.circles()[0]; const c = H.P(k.c); H.click(c.x, c.y); } },
        { say: 'Click the <b>green dashed line</b> above the tag.', why: 'That\'s the Y axis: the up-and-down centerline of the sketch. The tag is centered on it, so the hole will be too.', dot: (H) => [0, H.val('height') / 2 + 10], need: (H) => SK(H) && ((H.ed.pick && H.ed.pick.type === 'coin') || H.sk().cons.some(c => c.t === 'on' && c.e === 'YAX')), done: (H) => H.sk().cons.some(c => c.t === 'on' && c.e === 'YAX'), auto: (H) => H.click(0, H.val('height') / 2 + 10) },
        { say: 'Black again, and now the rule says what we mean: <b>on the centerline</b>.', why: 'Same picture, better rule. Before, the hole was "30 from the left". Now it\'s "in the middle".', manual: true, need: SK },
        finishStep,
        { say: 'Change <code>#width</code> to <code>40</code> and press <b>Enter</b>.', ring: (H) => H.varInput('width'), need: PART, done: (H) => near(H.val('width'), 40) && H.bbox() && near(H.bbox().min[0], -20, 1e-3), auto: (H) => H.setVar('width', '40') },
        { say: 'The hole stayed in the middle.', why: 'That\'s design intent: the part changed the way we meant. Now a second hole, with a different intent.', manual: true },
        { say: 'Double-click <b>Tag outline</b> again.', ring: (H) => H.treeRow('Tag outline'), done: SK, auto: (H) => H.app.editFeature(H.app.doc.features[0].id) },
        { say: `Click ${I('circle')} <b>Circle</b>.`, why: 'This hole is for hanging the tag. It should always sit <b>6 mm from the right edge</b>, however wide the tag is.', ring: '[data-tool=circle]', need: SK, done: (H) => H.ed.tool === 'circle', auto: (H) => H.ed.setTool('circle') },
        { say: 'Click on the <b>red dashed line</b> near the right end.', why: 'The red line is the X axis. Clicking on it keeps the hole level with the first one.', dot: (H) => [H.val('width') / 2 - 6, 0], need: (H) => SK(H) && (H.ed.tool === 'circle' || H.circles().length > 1), done: (H) => (H.ed.op && H.ed.op.cid) || H.circles().length > 1, auto: (H) => H.click(H.val('width') / 2 - 6, 0) },
        { say: 'Click a little to the right to set its size.', dot: (H) => [H.val('width') / 2 - 6 + 2.5, 1.2], need: (H) => SK(H) && ((H.ed.op && H.ed.op.cid) || H.circles().length > 1), done: (H) => H.circles().length > 1, check: (H) => null, auto: (H) => H.click(H.val('width') / 2 - 3.5, 1.2) },
        { say: `Click ${I('dimension')} <b>Dimension</b>.`, ring: '[data-tool=dimension]', need: SK, done: (H) => H.ed.tool === 'dimension', check: (H) => { const k = H.circles()[1]; return k && !H.sk().cons.some(c => c.t === 'on' && c.p === k.c && c.e === 'XAX') ? 'The new hole\'s center isn\'t on the red line. Press Ctrl+Z, then click Circle and click right on the red dashed line.' : null; }, auto: (H) => H.ed.setTool('dimension') },
        { say: 'Click the <b>new hole\'s center dot</b>.', dot: (H) => { const k = H.circles()[1]; if (!k) return null; const c = H.P(k.c); return [c.x, c.y]; }, need: SK, done: (H) => { const k = H.circles()[1]; return H.ed.op && k && H.ed.op.picks.some(p => p.id === k.c); }, auto: (H) => { if (H.ed.tool !== 'dimension') H.ed.setTool('dimension'); const k = H.circles()[1]; const c = H.P(k.c); H.click(c.x, c.y); } },
        { say: 'Click the <b>right edge</b> of the tag.', dot: (H) => { const l = H.edge('right'); return l && [H.mid(l)[0], H.val('height') / 4]; }, need: (H) => SK(H) && ((H.ed.op && H.ed.op.picks) || H.ed.inputCon), done: (H) => (H.ed.op && H.ed.op.picks.length === 2) || H.ed.inputCon, auto: (H) => { const l = H.edge('right'); H.click(H.mid(l)[0], H.val('height') / 4); } },
        { say: 'Click above the tag to place the number.', dot: (H) => [H.val('width') / 2 - 3, H.val('height') / 2 + 8], need: (H) => SK(H) && ((H.ed.op && H.ed.op.picks && H.ed.op.picks.length === 2) || H.ed.inputCon), done: (H) => !!H.ed.inputCon, auto: (H) => H.click(H.val('width') / 2 - 3, H.val('height') / 2 + 8) },
        { say: 'Type <code>6</code> and press <b>Enter</b>.', why: 'Now the rule is "6 mm from the right edge".', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.dimVal(6)), done: (H) => !H.ed.inputCon && H.dims().some(c => c.t === 'pldist' && near(H.num(c.v), 6)), auto: (H) => H.type('6') },
        { say: `Click ${I('eq')} <b>Equal</b>.`, why: 'Both holes take the same bolt, so they should always be the same size. Equal says that.', ring: '[data-tool=eq]', need: SK, done: (H) => (H.ed.pick && H.ed.pick.type === 'eq') || H.sk().cons.some(c => c.t === 'eq'), auto: (H) => { H.ed.setTool('select'); H.ed.applyConstraint('eq'); } },
        { say: 'Click the edge of the <b>first hole</b>.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x + k.r * 0.7071, c.y + k.r * 0.7071]; }, need: (H) => SK(H) && ((H.ed.pick && H.ed.pick.type === 'eq') || H.sk().cons.some(c => c.t === 'eq')), done: (H) => { const k = H.circles()[0]; return (H.ed.pick && k && H.ed.pick.items.some(i => i.id === k.id)) || H.sk().cons.some(c => c.t === 'eq'); }, auto: (H) => { const k = H.circles()[0]; const c = H.P(k.c); H.click(c.x + k.r * 0.7071, c.y + k.r * 0.7071); } },
        { say: 'Click the edge of the <b>new hole</b>.', dot: (H) => { const k = H.circles()[1]; if (!k) return null; const c = H.P(k.c); return [c.x + k.r * 0.7071, c.y + k.r * 0.7071]; }, need: SK, done: (H) => H.sk().cons.some(c => c.t === 'eq'), auto: (H) => { const k = H.circles()[1]; const c = H.P(k.c); H.click(c.x + k.r * 0.7071, c.y + k.r * 0.7071); } },
        { say: 'All black: fully defined, with three different intents.', why: '<b>Centered</b> (on the centerline), <b>measured from an edge</b> (6 mm from the right), and <b>the same size</b> (Equal).', manual: true, need: SK, check: (H) => H.ed.status && H.ed.status.dof > 0 ? 'Something is still blue. Check that the new hole\'s center sits on the red line.' : null },
        finishStep,
        { say: 'Change <code>#width</code> to <code>100</code> and press <b>Enter</b>.', ring: (H) => H.varInput('width'), need: PART, done: (H) => near(H.val('width'), 100) && H.bbox() && near(H.bbox().min[0], -50, 1e-3), auto: (H) => H.setVar('width', '100') },
        { say: 'Each hole followed its own rule.', why: 'The first stayed in the middle, the second stayed 6 mm from the right edge, and they stayed the same size. Try <code>#hole</code> = 8 too.', manual: true },
        { outro: true, say: 'That\'s design intent.', why: 'Before you add a dimension, ask three questions: <b>What must stay the same?</b> <b>What is allowed to change?</b> <b>What should it be measured from?</b> Then pick the rule that says it: symmetric or on a centerline, a distance from an edge, Equal, or a #variable.' },
      ],
    },
    // ---------------------------------------------------------------- 3
    {
      id: 'vars', title: 'Variables: let math drive the part', time: '7 min', learn: 'Name a size, link another size to it with a formula, and check the Pythagorean theorem with Measure.',
      start: () => plateDoc('Variables plate', false),
      steps: [
        { intro: true, say: 'A variable is a named number, like <code>#width</code>.', why: 'Use it in any size. Change it once and every size that uses it updates. Formulas work too, so the part follows your math.' },
        { say: 'Double-click <b>Plate sketch</b> in the Feature list.', ring: (H) => H.treeRow('Plate sketch'), done: SK, auto: (H) => H.app.editFeature(H.app.doc.features[0].id) },
        { say: 'Double-click the <b>60</b> dimension.', why: 'Double-clicking a dimension lets you change it.', dot: (H) => { const c = H.dimVal(60); return c && c._lab; }, need: SK, done: (H) => { const c = H.dimVal(60); return H.ed.inputCon && c && H.ed.inputCon === c.id; }, auto: (H) => H.ed.editDim(H.dimVal(60).id) },
        { say: 'Type <code>#width = 60</code> and press <b>Enter</b>.', why: 'This makes a variable named width, sets it to 60, and uses it here, all at once.', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.app.doc.vars.some(v => v.name === 'width')), done: (H) => !H.ed.inputCon && H.dims().some(c => /#width\b/.test(c.v)) && H.app.doc.vars.some(v => v.name === 'width'), auto: (H) => H.type('#width = 60') },
        { say: 'Double-click the <b>40</b> dimension.', dot: (H) => { const c = H.dimVal(40); return c && c._lab; }, need: SK, done: (H) => { const c = H.dimVal(40); return H.ed.inputCon && c && H.ed.inputCon === c.id; }, auto: (H) => H.ed.editDim(H.dimVal(40).id) },
        { say: 'Type <code>#width / 2</code> and press <b>Enter</b>.', why: 'Now the height is always half the width.', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.dims().some(c => /#width\s*\/\s*2/.test(c.v))), done: (H) => !H.ed.inputCon && H.dims().some(c => /#width\s*\/\s*2/.test(c.v)), auto: (H) => H.type('#width / 2') },
        finishStep,
        { say: 'In the <b>Variables</b> box, change <code>width</code> to <code>80</code>, then press <b>Enter</b>.', ring: (H) => H.varInput('width'), need: PART, done: (H) => near(H.val('width'), 80) && H.bbox() && near(H.bbox().max[1] - H.bbox().min[1], 40, 1e-3), auto: (H) => H.setVar('width', '80') },
        { say: 'The height followed: 80 ÷ 2 = 40.', why: 'One number now controls two sizes. That\'s how real products come in small, medium and large.', manual: true },
        { say: `Click ${I('plus')} <b>Add</b> in the Variables box.`, ring: '#addVar', need: PART, done: (H) => H.app.doc.vars.length >= 2, auto: (H) => H.app.addVariable() },
        { say: 'Rename the new variable to <code>diag</code>, then press <b>Enter</b>.', why: 'Click its name (it says size) and type over it.', ring: (H) => { const v = H.app.doc.vars[H.app.doc.vars.length - 1]; return v ? H.varInput(v.name, '.vname') : null; }, done: (H) => H.app.doc.vars.some(v => v.name === 'diag'), auto: (H) => { const i = H.app.doc.vars.length - 1; H.app.renameVar(i, 'diag'); } },
        { say: 'For its value, type <code>sqrt(#width^2 + (#width/2)^2)</code> and press <b>Enter</b>.', why: 'That\'s the Pythagorean theorem: the diagonal is the square root of width² plus height².', ring: (H) => H.varInput('diag'), done: (H) => near(H.val('diag'), Math.hypot(80, 40), 1e-6), auto: (H) => H.setVar('diag', 'sqrt(#width^2 + (#width/2)^2)') },
        { say: 'The diagonal is 89.44 mm. Let\'s check it.', why: 'Engineers check math against the model.', manual: true },
        { say: `Click ${I('measure')} <b>Measure</b>.`, ring: '[data-tool=measure]', need: PART, done: (H) => !!H.app.measure, auto: (H) => H.tool('measure') },
        { say: 'Click one <b>top corner</b> of the plate.', dot: (H) => { const b = H.bbox(); return b && { w: [b.min[0], b.min[1], b.max[2]] }; }, need: (H) => !!H.app.measure, done: (H) => H.app.measure && H.app.measure.picks.length >= 1, auto: (H) => { const b = H.bbox(); H.app.measure.picks = [{ k: 'pt', p: [b.min[0], b.min[1], b.max[2]] }]; H.app.renderMeasure(); } },
        { say: 'Click the <b>opposite top corner</b>.', dot: (H) => { const b = H.bbox(); return b && { w: [b.max[0], b.max[1], b.max[2]] }; }, need: (H) => !!H.app.measure, done: (H) => H.app.measure && H.app.measure.picks.length === 2, auto: (H) => { const b = H.bbox(); H.app.measure.picks.push({ k: 'pt', p: [b.max[0], b.max[1], b.max[2]] }); H.app.renderMeasure(); } },
        { say: 'Measure says 89.44 mm too.', why: 'The math and the model agree. If you change #width, #diag changes with it.', manual: true, check: (H) => { const P = H.app.measure && H.app.measure.picks; if (!P || P.length < 2) return null; const d = Math.hypot(...P[1].p.map((v, i) => v - P[0].p[i])); return Math.abs(d - H.val('diag')) > 0.05 ? 'Those weren\'t opposite corners. Click two corners across from each other.' : null; } },
        { outro: true, say: 'Math is driving your part now.', why: 'Trig works too: <code>atan(#rise / #run)</code> gives an angle in degrees, and <code>2 in</code> turns inches into millimeters.', exit: (H) => { if (H.app.measure) H.app.toggleMeasure(); } },
      ],
    },
    // ---------------------------------------------------------------- 4
    {
      id: 'holes', title: 'Holes: sketch on a face and cut', time: '5 min', learn: 'Sketch right on the top of a part, center a hole, and cut it all the way through.',
      start: () => plateDoc('Plate for a hole', false),
      steps: [
        { intro: true, say: 'Let\'s put a hole in the middle of this plate.', why: 'You can sketch on any flat face of a part, then use Extrude to cut.' },
        { say: `Click ${I('sketch')} <b>Sketch</b>.`, ring: '[data-tool=sketch]', done: (H) => H.app.picking === 'plane' || SK(H), auto: (H) => H.tool('sketch') },
        { say: 'Click the <b>top face</b> of the plate.', why: 'The face turns orange when you point at it.', dot: (H) => { const b = H.bbox(); return b && { w: [b.max[0] * 0.5, b.max[1] * 0.4, b.max[2]] }; }, need: (H) => H.app.picking === 'plane' || SK(H), done: (H) => SK(H) && H.sk().plane.k === 'face', check: (H) => SK(H) && H.sk().plane.k !== 'face' ? 'That made a sketch on a plane, not the face. Click Cancel in the blue bar and try again.' : null, auto: (H) => { H.app.cancelPick(); H.app.createSketch({ k: 'face', f: H.app.doc.features[1].id, role: 'end' }); } },
        { say: `Click ${I('circle')} <b>Circle</b>.`, ring: '[data-tool=circle]', need: SK, done: (H) => H.ed.tool === 'circle', auto: (H) => H.ed.setTool('circle') },
        { say: 'Click somewhere on the plate for the center.', why: 'Not in the exact middle on purpose: you\'ll center it with a rule.', dot: (H) => [10, 8], need: SK, done: (H) => (H.ed.op && H.ed.op.cid) || H.circles().length, auto: (H) => H.click(10, 8) },
        { say: 'Click to set the size.', dot: (H) => [14, 8], need: (H) => SK(H) && ((H.ed.op && H.ed.op.cid) || H.circles().length), done: (H) => H.circles().length > 0, auto: (H) => H.click(14, 8) },
        { say: `Click ${I('dimension')} <b>Dimension</b>.`, ring: '[data-tool=dimension]', need: SK, done: (H) => H.ed.tool === 'dimension', auto: (H) => H.ed.setTool('dimension') },
        { say: 'Click the <b>edge of the circle</b>.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x + k.r * 0.7071, c.y + k.r * 0.7071]; }, need: SK, done: (H) => H.ed.op && H.ed.op.place && H.ed.op.picks.length === 1, auto: (H) => { const k = H.circles()[0]; const c = H.P(k.c); H.click(c.x + k.r * 0.7071, c.y + k.r * 0.7071); } },
        { say: 'Click outside the circle to place the number.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x + k.r + 8, c.y + k.r + 6]; }, need: (H) => SK(H) && ((H.ed.op && H.ed.op.place) || H.ed.inputCon), done: (H) => !!H.ed.inputCon, auto: (H) => { const k = H.circles()[0]; const c = H.P(k.c); H.click(c.x + k.r + 8, c.y + k.r + 6); } },
        { say: 'Type <code>8</code> and press <b>Enter</b>.', why: 'Ø means diameter: all the way across.', ring: () => $('.dimbox input'), need: (H) => SK(H) && (H.ed.inputCon || H.dimVal(8)), done: (H) => !H.ed.inputCon && !!H.dimVal(8), auto: (H) => H.type('8') },
        { say: `Click ${I('coin')} <b>Coincident</b>.`, why: 'Next you\'ll put the circle\'s center right on the origin, which is the middle of the plate.', ring: '[data-tool=coin]', need: SK, done: (H) => (H.ed.pick && H.ed.pick.type === 'coin') || (H.circles()[0] && H.circles()[0].c === 'O'), auto: (H) => { H.ed.setTool('select'); H.ed.applyConstraint('coin'); } },
        { say: 'Click the circle\'s <b>center dot</b>.', dot: (H) => { const k = H.circles()[0]; if (!k) return null; const c = H.P(k.c); return [c.x, c.y]; }, need: (H) => SK(H) && ((H.ed.pick && H.ed.pick.type === 'coin') || (H.circles()[0] && H.circles()[0].c === 'O')), done: (H) => { const k = H.circles()[0]; return (H.ed.pick && k && H.ed.pick.items.some(i => i.id === k.c)) || (k && k.c === 'O'); }, auto: (H) => { const k = H.circles()[0]; const c = H.P(k.c); H.click(c.x, c.y); } },
        { say: 'Click the <b>origin</b> (the dark dot where the dashed lines cross).', dot: () => [0, 0], need: SK, done: (H) => H.circles()[0] && H.circles()[0].c === 'O', auto: (H) => H.click(0, 0) },
        finishStep,
        { say: `Click ${I('extrude')} <b>Extrude</b>.`, ring: '[data-tool=extrude]', need: PART, done: DLG('extrude'), auto: (H) => H.tool('extrude') },
        { say: 'Click <b>Remove</b>.', why: 'Remove cuts the shape away instead of adding it. The preview turns red.', ring: () => $('[data-seg=op] [data-v=remove]'), need: DLG('extrude'), done: (H) => H.app.dialog.d.op === 'remove', auto: (H) => { H.app.dialog.d.op = 'remove'; H.app.dialog.render(); H.app.dialog.update(true); } },
        { say: 'Click <b>Through all</b>.', why: 'The hole goes all the way through, even if the plate gets thicker later. That\'s design intent too.', ring: () => $('[data-seg=end] [data-v=through]'), need: DLG('extrude'), done: (H) => H.app.dialog.d.end === 'through', auto: (H) => { H.app.dialog.d.end = 'through'; H.app.dialog.render(); H.app.dialog.update(true); } },
        { say: `Click ${I('finish')} <b>OK</b>.`, ring: '#dOk', need: (H) => !!H.app.dialog || H.feats('extrude').length > 1, done: (H) => !H.app.dialog && H.feats('extrude').some(f => f.op === 'remove'), auto: (H) => H.app.dialog.ok() },
        { outro: true, say: 'A centered hole, all the way through.', why: 'Change the plate\'s size and the hole stays in the middle. Change its thickness and the hole still goes through.' },
      ],
    },
    // ---------------------------------------------------------------- 5
    {
      id: 'revolve', title: 'Revolve: make a round part', time: '5 min', learn: 'Draw half of a shape beside an axis and spin it into a ring, then sweep only part of the way.',
      start: () => newDoc('Revolved ring'),
      steps: [
        { intro: true, say: 'Round parts, like a cup, a knob or a washer, are made by spinning a flat shape.', why: 'You draw what you\'d see if you cut the part in half, next to the line it spins around.' },
        { say: `Click ${I('sketch')} <b>Sketch</b>.`, ring: '[data-tool=sketch]', done: (H) => H.app.picking === 'plane' || SK(H), auto: (H) => H.tool('sketch') },
        { say: 'Click <b>Front</b>.', why: 'The Front plane stands up like a wall facing you.', ring: () => $('[data-p=Front]'), need: (H) => H.app.picking === 'plane' || SK(H), done: SK, auto: (H) => { H.app.cancelPick(); H.app.createSketch({ k: 'std', name: 'Front' }); } },
        { say: `Click ${I('rect')} <b>Rect</b> (rectangle).`, ring: '[data-tool=rect]', need: SK, done: (H) => H.ed.tool === 'rect', auto: (H) => H.ed.setTool('rect') },
        { say: 'Click on the <b>red dashed line</b>, to the right of the green one.', why: 'The green dashed line is the axis you\'ll spin around. The gap becomes the hole in the middle.', dot: () => [10, 0], need: SK, done: (H) => (H.ed.op && H.ed.op.s0) || H.lines().length >= 4, auto: (H) => H.click(10, 0) },
        { say: 'Click up and to the right.', dot: () => [20, 15], need: (H) => SK(H) && ((H.ed.op && H.ed.op.s0) || H.lines().length >= 4), done: (H) => H.lines().length >= 4, auto: (H) => H.click(20, 15) },
        finishStep,
        { say: `Click ${I('revolve')} <b>Revolve</b>.`, ring: '[data-tool=revolve]', need: PART, done: DLG('revolve'), auto: (H) => H.tool('revolve') },
        { say: 'Click <b>Sketch Y axis</b>.', why: 'That tells Revolve to spin around the green dashed line.', ring: () => $('[data-axq=YAX]'), need: DLG('revolve'), done: (H) => H.app.dialog.d.axis && H.app.dialog.d.axis.e === 'YAX', auto: (H) => { H.app.dialog.d.axis = { e: 'YAX' }; H.app.dialog.active = null; H.app.dialog.render(); H.app.dialog.update(true); } },
        { say: 'Look at the preview: a ring, like a washer.', why: 'The rectangle swept all the way around.', manual: true, need: DLG('revolve') },
        { say: 'Uncheck <b>Full turn (360°)</b>.', ring: () => $('[data-c=full]'), need: DLG('revolve'), done: (H) => H.app.dialog.d.full === false, auto: (H) => { H.app.dialog.d.full = false; H.app.dialog.render(); H.app.dialog.update(true); } },
        { say: 'Drag the <b>orange ball</b> around the axis.', why: 'It sets how far the shape sweeps. It snaps every 5°; hold Shift for any angle.', dot: (H) => { const h = H.app.handleList()[0]; return h && { w: H.app.handlePos(h) }; }, need: DLG('revolve'), enter: (H, s) => { s.a0 = H.app.dialog && H.app.dialog.d.angle; }, done: (H, s) => H.app.dialog && H.app.dialog.d.angle !== s.a0 && !H.app.hdrag, auto: (H) => { H.app.dialog.d.angle = '270'; H.app.dialog.render(); H.app.dialog.update(true); } },
        { say: `Click ${I('finish')} <b>OK</b>.`, ring: '#dOk', need: (H) => !!H.app.dialog || H.feats('revolve').length, done: (H) => !H.app.dialog && H.feats('revolve').length > 0, auto: (H) => H.app.dialog.ok() },
        { outro: true, say: 'You spun a shape into a part.', why: 'Open the <b>Tea light lantern</b> example to see a cup made this way, with windows cut around it.' },
      ],
    },
    // ---------------------------------------------------------------- 6
    {
      id: 'pattern', title: 'Patterns: copy a hole in a row', time: '4 min', learn: 'Copy a feature several times with even spacing, and see the spacing math.',
      start: () => plateDoc('Hole row', true),
      steps: [
        { intro: true, say: 'This plate has one hole. Let\'s make it five, evenly spaced.', why: 'A pattern copies a feature. Change the count or spacing any time and the copies update.' },
        { say: `Click ${I('lpattern')} <b>Lin. pattern</b> (linear pattern).`, ring: '[data-tool=lpattern]', need: PART, done: DLG('lpattern'), auto: (H) => H.tool('lpattern') },
        { say: 'Click <b>Hole cut</b> in the Feature list.', why: 'That\'s the feature to copy.', ring: (H) => H.treeRow('Hole cut'), need: DLG('lpattern'), done: (H) => H.app.dialog.d.feats.length > 0, auto: (H) => H.app.dialog.toggleFeat(H.app.doc.features.find(f => f.name === 'Hole cut').id) },
        { say: 'In <b>How many</b>, type <code>5</code>.', ring: () => $('[data-x=count]'), need: DLG('lpattern'), done: (H) => near(H.num(H.app.dialog.d.count), 5), auto: (H) => H.dlgInput('count', '5') },
        { say: 'In <b>Spacing</b>, type <code>10</code>.', why: 'You can also drag the orange arrow at the second hole.', ring: () => $('[data-x=spacing]'), need: DLG('lpattern'), done: (H) => near(H.num(H.app.dialog.d.spacing), 10), auto: (H) => H.dlgInput('spacing', '10') },
        { say: `Click ${I('finish')} <b>OK</b>.`, ring: '#dOk', need: (H) => !!H.app.dialog || H.feats('lpattern').length, done: (H) => !H.app.dialog && H.feats('lpattern').length > 0, auto: (H) => H.app.dialog.ok() },
        { say: 'Five holes, 10 mm apart.', why: 'From the first to the last is (5 − 1) × 10 = 40 mm: there are 4 gaps between 5 holes. The first hole is at −20, so the last is at +20.', manual: true },
        { outro: true, say: 'Patterns save a lot of clicking.', why: 'Try Circular pattern for bolt circles, and Mirror to build half a part and copy the other half.' },
      ],
    },
    // ---------------------------------------------------------------- 7
    {
      id: 'make', title: 'Get it to the makerspace', time: '4 min', learn: 'Predict a print\'s mass, export an STL for the Prusa, and export a sketch as a DXF for the laser.',
      start: () => plateDoc('Makerspace plate', true),
      steps: [
        { intro: true, say: 'Let\'s get this plate ready for the machines.', why: 'The 3D printer takes an STL file. The laser, router and waterjet take a flat drawing (DXF).' },
        { say: `Click ${I('mass')} <b>Mass</b>.`, ring: '[data-tool=mass]', need: PART, done: (H) => H.app.card === 'mass', auto: (H) => H.tool('mass') },
        { say: 'Set <b>Infill</b> to <code>20%</code>.', why: 'A print isn\'t solid inside. Infill is how full the inside is.', ring: () => $('#infill'), need: (H) => H.app.card === 'mass', done: (H) => H.app.doc.infill === 20, auto: (H) => { H.app.doc.infill = 20; H.app.renderMass(); } },
        { say: 'Write down the print estimate.', why: 'After it prints, weigh it on the gram scale and compare. The slicer gives a closer number, and the scale is the real answer.', manual: true },
        { say: `Click ${I('stl')} <b>Export STL</b> in the toolbar.`, why: 'It saves every part you can see. Open the file in PrusaSlicer to print it. STL files are always in millimeters, even if you work in inches.', ring: '#toolbar [data-tool=stl]', done: (H) => H.app.lastExport === 'stl', auto: (H) => H.app.exportSTL() },
        { say: 'Right-click <b>Plate sketch</b> in the Feature list.', why: 'Sketches have their own menu.', ring: (H) => H.treeRow('Plate sketch'), done: (H) => !!H.menuItem('Export sketch as DXF') || H.app.lastExport === 'dxf', auto: (H) => { const f = H.app.doc.features[0]; const r = H.treeRow('Plate sketch').getBoundingClientRect(); H.app.featureMenu(f.id, r.left + 40, r.top + 10); } },
        { say: 'Click <b>Export sketch as DXF</b>.', why: 'Its lines come out red, and red means cut. It opens in TS 82 CAD or AutoCAD.', ring: (H) => H.menuItem('Export sketch as DXF'), need: (H) => !!H.menuItem('Export sketch as DXF') || H.app.lastExport === 'dxf', done: (H) => H.app.lastExport === 'dxf', auto: (H) => { const m = $('#menu'); if (m) m.remove(); H.app.exportSketch(H.app.doc.features[0].id, 'dxf'); } },
        { outro: true, say: 'Files ready for the printer and the laser.', why: 'To cut a flat face of a 3D part instead, right-click that face and pick Export this flat face.', exit: (H) => { if (H.app.card === 'mass') H.app.closeCard(); } },
      ],
    },
  ];
}

// ---------- engine ----------
export class Tutor {
  constructor(app) {
    this.app = app;
    this.H = helpers(app);
    this.list = lessons();
    this.lesson = null; this.i = 0; this.state = {};
    try { this.doneSet = new Set(JSON.parse(localStorage.getItem('geocad3d-tut-done') || '[]')); } catch (e) { this.doneSet = new Set(); }
    this.build();
  }
  build() {
    const card = document.createElement('div');
    card.id = 'tutCard'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Tutorial'); card.setAttribute('aria-live', 'polite');
    card.innerHTML = `<div class="th"><span class="tl"></span><span class="tn"></span><button type="button" class="tmin" title="Make the card small" aria-label="Make the card small">&ndash;</button><button type="button" class="tx" title="Stop the tutorial" aria-label="Stop the tutorial">&times;</button></div>
      <div class="tbar"><i></i></div><div class="tbody"><img class="tbun" alt=""><div><div class="tsay"></div><div class="twhy"></div></div></div><div class="thint"></div>
      <div class="tbtns"><button type="button" class="tback">Back</button><button type="button" class="tdo">Do it for me</button><span class="tsp"></span><button type="button" class="tnext pri">Next</button></div><div class="tarrow"></div>`;
    document.body.appendChild(card);
    const ring = document.createElement('div'); ring.id = 'tutRing'; ring.setAttribute('aria-hidden', 'true'); document.body.appendChild(ring);
    const dot = document.createElement('div'); dot.id = 'tutDot'; dot.setAttribute('aria-hidden', 'true'); dot.innerHTML = '<span>click here</span>'; document.body.appendChild(dot);
    const pill = document.createElement('button'); pill.id = 'tutPill'; pill.type = 'button'; document.body.appendChild(pill);
    Object.assign(this, { card, ring, dot, pill });
    card.querySelector('.tx').onclick = () => this.stop();
    card.querySelector('.tmin').onclick = () => { this.min = true; this.render(); };
    pill.onclick = () => { this.min = false; this.render(); };
    card.querySelector('.tback').onclick = () => this.go(this.i - 1, true);
    card.querySelector('.tnext').onclick = () => this.next();
    card.querySelector('.tdo').onclick = () => this.doIt();
    [card, ring, dot, pill].forEach(el => el.style.display = 'none');
  }
  // lesson picker
  openPicker() {
    const app = this.app;
    const rows = this.list.map((L, k) => `<button class="tlrow${L.star ? ' star' : ''}" data-k="${k}">
      <span class="tlnum">${this.doneSet.has(L.id) ? '✓' : k + 1}</span>
      <span class="tlt"><b>${esc(L.title)}</b>${L.star ? '<em>Big idea</em>' : ''}<small>${esc(L.learn)}</small></span><span class="tltime">${L.time}</span></button>`).join('');
    const b = app.modal(`<div class="ghead"><img src="${window.BUNNY && window.BUNNY.peek || ''}" alt="" class="bun sm"><div><h3>Tutorials</h3><p class="dp">Each lesson has you make something while a card shows exactly where to click. It waits for you, and <b>Do it for me</b> helps if you get stuck.</p></div><button class="x" aria-label="Close">${icon('cancel')}</button></div><div class="tlist">${rows}</div><p class="dp">Starting a lesson puts its own part on screen. Your part is kept, and you can go back to it at the end.</p>`, true);
    b.querySelector('.x').onclick = () => app.closeModal();
    b.querySelectorAll('.tlrow').forEach(r => r.onclick = () => { app.closeModal(); this.start(+r.dataset.k); });
  }
  start(k) {
    const app = this.app;
    const L = this.list[k];
    if (!L) return;
    if (this.lesson) this.cleanupStep();
    if (!this.saved) this.saved = app.snapshot();
    this.lesson = L; this.k = k; this.min = false; this.state = {};
    if (app.mode === 'sketch') app.exitSketch(true);
    if (app.dialog) app.closeDialog(false);
    if (app.measure) app.toggleMeasure();
    if (app.card) app.closeCard();
    app.loadDoc(L.start());
    this.go(0);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 220);
    const loop = () => { if (!this.lesson) return; this.position(); this.raf = requestAnimationFrame(loop); };
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(loop);
  }
  get step() { return this.lesson && this.lesson.steps[this.i]; }
  go(i, manualBack) {
    const L = this.lesson;
    if (!L) return;
    this.cleanupStep();
    this.i = Math.max(0, Math.min(L.steps.length - 1, i));
    this.okUntil = 0;
    this.hint = manualBack ? '' : this.hint;
    this.stepState = {};
    const s = this.step;
    try { if (s.enter) s.enter(this.H, this.stepState); } catch (e) { /* ignore */ }
    if (s.outro) this.markDone();
    this.render();
    this.app.view.request();
  }
  cleanupStep() { const s = this.step; if (s && s.exit) { try { s.exit(this.H); } catch (e) { /* ignore */ } } }
  next() {
    const s = this.step;
    if (s.outro) {
      const nx = this.k + 1 < this.list.length ? this.k + 1 : null;
      if (nx != null) this.start(nx); else this.stop();
      return;
    }
    this.hint = '';
    this.go(this.i + 1);
  }
  async doIt() {
    const s = this.step;
    if (!s || !s.auto) return;
    try { await s.auto(this.H, this.stepState); } catch (e) { this.hint = 'That didn\'t work from here. Try Back, then Do it for me again.'; this.render(); }
    this.app.view.request();
    setTimeout(() => this.tick(), 60);
  }
  safe(fn, d) { try { return fn ? fn(this.H, this.stepState) : d; } catch (e) { return d; } }
  tick() {
    const s = this.step;
    if (!s || this.okUntil) return;
    if (!s.intro && !s.outro && s.need && !this.safe(s.need, true) && this.i > 0) {
      this.hint = 'That closed, so we went back a step.';
      this.go(this.i - 1);
      return;
    }
    if (s.done && this.safe(s.done, false)) {
      this.okUntil = 1;
      this.card.classList.add('ok');
      this.hint = '';
      this.render();
      setTimeout(() => { this.card.classList.remove('ok'); this.okUntil = 0; if (this.step === s) this.go(this.i + 1); }, 650);
      return;
    }
    const h = s.check ? this.safe(s.check, null) : null;
    if (h !== (this.checkHint || null)) { this.checkHint = h; this.render(); }
  }
  markDone() {
    this.doneSet.add(this.lesson.id);
    try { localStorage.setItem('geocad3d-tut-done', JSON.stringify([...this.doneSet])); } catch (e) { /* ignore */ }
  }
  stop() {
    this.cleanupStep();
    clearInterval(this.timer); cancelAnimationFrame(this.raf);
    const saved = this.saved;
    this.lesson = null; this.saved = null;
    [this.card, this.ring, this.dot, this.pill].forEach(el => el.style.display = 'none');
    this.app.view.request();
    if (saved) {
      const b = this.app.modal(`<h3>Tutorial closed</h3><p>Keep the tutorial's part, or go back to the part you had before?</p><div class="mfoot"><button class="btn" data-a="keep">Keep this part</button><button class="btn primary" data-a="back">Back to my part</button></div>`);
      b.querySelector('[data-a=keep]').onclick = () => this.app.closeModal();
      b.querySelector('[data-a=back]').onclick = () => { this.app.closeModal(); this.app.loadDoc(JSON.parse(saved)); };
    }
  }
  render() {
    const L = this.lesson, s = this.step, card = this.card;
    if (!L) return;
    if (this.min) {
      card.style.display = 'none'; this.ring.style.display = 'none'; this.dot.style.display = 'none';
      this.pill.style.display = 'block'; this.pill.textContent = `${L.title}: step ${this.i + 1} of ${L.steps.length}`;
      return;
    }
    this.pill.style.display = 'none';
    card.style.display = 'block';
    card.querySelector('.tl').textContent = L.title;
    card.querySelector('.tn').textContent = `${this.i + 1} / ${L.steps.length}`;
    card.querySelector('.tbar i').style.width = (100 * (this.i + (s.outro ? 1 : 0)) / L.steps.length) + '%';
    card.querySelector('.tsay').innerHTML = s.say;
    card.querySelector('.twhy').innerHTML = s.why || '';
    const bun = card.querySelector('.tbun');
    bun.style.display = s.intro || s.outro ? 'block' : 'none';
    if (s.intro || s.outro) bun.src = (window.BUNNY && (s.outro ? window.BUNNY.flop : window.BUNNY.peek)) || '';
    const hint = this.checkHint || this.hint;
    const th = card.querySelector('.thint'); th.textContent = hint || ''; th.style.display = hint ? 'block' : 'none';
    card.querySelector('.tback').style.visibility = this.i > 0 && !s.outro ? 'visible' : 'hidden';
    const tdo = card.querySelector('.tdo'); tdo.style.display = s.auto ? '' : 'none';
    const nx = card.querySelector('.tnext');
    nx.style.display = s.intro || s.manual || s.outro ? '' : 'none';
    nx.textContent = s.intro ? 'Start' : s.outro ? (this.k + 1 < this.list.length ? 'Next lesson' : 'Finish') : 'Next';
    card.classList.toggle('fin', !!s.outro);
    this.position();
  }
  // where the step points: {el} or {pt:[x,y] page coords} or null
  target() {
    const s = this.step, H = this.H, app = this.app;
    if (!s) return null;
    if (s.ring) {
      const el = typeof s.ring === 'string' ? $(s.ring) : this.safe(s.ring, null);
      if (el && el.getClientRects().length) return { el };
      return null;
    }
    if (s.dot) {
      const p = this.safe(s.dot, null);
      if (!p) return null;
      const r = app.view.overlay.getBoundingClientRect();
      let sx, sy;
      if (p.w) [sx, sy] = app.view.project(p.w);
      else if (app.mode === 'sketch' && app.sk.plane) [sx, sy] = app.sk.scr(p[0], p[1]);
      else return null;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return null;
      return { pt: [sx + r.left, sy + r.top] };
    }
    return null;
  }
  position() {
    if (!this.lesson || this.min) return;
    const t = this.target();
    const card = this.card, ring = this.ring, dot = this.dot;
    const arrow = card.querySelector('.tarrow');
    ring.style.display = 'none'; dot.style.display = 'none';
    const cw = card.offsetWidth, ch = card.offsetHeight, W = innerWidth, Hh = innerHeight;
    let x, y, side = 'none', ax = 0, ay = 0;
    if (t && t.el) {
      const r = t.el.getBoundingClientRect();
      Object.assign(ring.style, { display: 'block', left: (r.left - 5) + 'px', top: (r.top - 5) + 'px', width: (r.width + 10) + 'px', height: (r.height + 10) + 'px' });
      const inLeft = r.right < 300, inTop = r.bottom < 120, inDlg = !!t.el.closest('#dlg'), inMenu = !!t.el.closest('#menu');
      if (inTop) { side = 'below'; x = r.left + r.width / 2 - cw / 2; y = r.bottom + 16; }
      else if (inLeft || inDlg || inMenu) { side = 'right'; x = r.right + 18; y = r.top + r.height / 2 - ch / 2; }
      else { side = 'above'; x = r.left + r.width / 2 - cw / 2; y = r.top - ch - 16; }
      if (side === 'above' && y < 8) { side = 'below'; y = r.bottom + 16; }
      if (side === 'right' && x + cw > W - 8) { side = 'left'; x = r.left - cw - 18; }
      ax = r.left + r.width / 2; ay = r.top + r.height / 2;
    } else if (t && t.pt) {
      const [px, py] = t.pt;
      Object.assign(dot.style, { display: 'block', left: px + 'px', top: py + 'px' });
      side = 'right'; x = px + 46; y = py - ch / 2;
      if (x + cw > W - 8) { side = 'left'; x = px - cw - 46; }
      ax = px; ay = py;
    } else {
      const v = $('#view').getBoundingClientRect();
      x = v.right - cw - 16; y = v.bottom - ch - 16;
    }
    x = Math.max(8, Math.min(W - cw - 8, x)); y = Math.max(8, Math.min(Hh - ch - 8, y));
    card.style.left = x + 'px'; card.style.top = y + 'px';
    arrow.className = 'tarrow ' + side;
    if (side === 'below' || side === 'above') arrow.style.left = Math.max(14, Math.min(cw - 14, ax - x)) + 'px', arrow.style.top = '';
    if (side === 'right' || side === 'left') arrow.style.top = Math.max(14, Math.min(ch - 14, ay - y)) + 'px', arrow.style.left = '';
  }
}
