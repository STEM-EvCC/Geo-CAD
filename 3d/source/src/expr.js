// Expression engine: numbers, units, #variables, functions (trig in degrees).
// Lengths are millimeters, angles are degrees.

const UNITS = {
  mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, ft: 304.8, feet: 304.8,
  deg: 1, degree: 1, degrees: 1, rad: 180 / Math.PI, '°': 1, '"': 25.4, "'": 304.8,
};
const D2R = Math.PI / 180;
const FUNCS = {
  sqrt: [1, Math.sqrt], abs: [1, Math.abs],
  sin: [1, x => Math.sin(x * D2R)], cos: [1, x => Math.cos(x * D2R)], tan: [1, x => Math.tan(x * D2R)],
  asin: [1, x => Math.asin(x) / D2R], acos: [1, x => Math.acos(x) / D2R], atan: [1, x => Math.atan(x) / D2R],
  atan2: [2, (y, x) => Math.atan2(y, x) / D2R],
  min: [-1, Math.min], max: [-1, Math.max], round: [1, Math.round], floor: [1, Math.floor], ceil: [1, Math.ceil],
  sq: [1, x => x * x], hypot: [-1, Math.hypot], log: [1, Math.log10], ln: [1, Math.log], exp: [1, Math.exp],
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, PI: Math.PI };

export class ExprError extends Error {}

function tokenize(s) {
  const t = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new ExprError('Bad number near "' + s.slice(i, i + 4) + '"');
      t.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (c === '#' || /[A-Za-z_π]/.test(c)) {
      const m = /^#?[A-Za-z_π][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!m) throw new ExprError('A # must be followed by a variable name');
      t.push({ k: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if (c === '°' || c === '"' || c === "'") { t.push({ k: 'id', v: c }); i++; continue; }
    if ('+-*/^(),%×÷'.includes(c)) { t.push({ k: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c }); i++; continue; }
    throw new ExprError('I don\'t understand "' + c + '"');
  }
  return t;
}

// Parse to an AST so we can list references and evaluate many times.
export function parse(src) {
  if (typeof src === 'number') return { k: 'num', v: src };
  const toks = tokenize(String(src));
  if (!toks.length) throw new ExprError('Type a number or an expression');
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].k === 'op' && toks[p].v === v;
  function expr() {
    let a = term();
    while (isOp('+') || isOp('-')) { const o = toks[p++].v; a = { k: 'bin', o, a, b: term() }; }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) { const o = toks[p++].v; a = { k: 'bin', o, a, b: unary() }; continue; }
      // implicit multiplication: 2(3), 2#w, (a)(b)
      const t = peek();
      if (t && (t.k === 'num' || (t.k === 'id' && !UNITS[t.v]) || (t.k === 'op' && t.v === '('))) { a = { k: 'bin', o: '*', a, b: unary() }; continue; }
      return a;
    }
  }
  function unary() {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power() {
    const a = postfix();
    if (isOp('^')) { p++; return { k: 'bin', o: '^', a, b: unary() }; }
    return a;
  }
  function postfix() {
    let a = primary();
    while (peek() && peek().k === 'id' && UNITS[peek().v] !== undefined) {
      a = { k: 'bin', o: '*', a, b: { k: 'num', v: UNITS[toks[p++].v] } };
    }
    return a;
  }
  function primary() {
    const t = toks[p++];
    if (!t) throw new ExprError('The expression ends too soon');
    if (t.k === 'num') return { k: 'num', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const e = expr();
      if (!isOp(')')) throw new ExprError('Missing )');
      p++; return e;
    }
    if (t.k === 'id') {
      const name = t.v;
      if (name[0] !== '#' && FUNCS[name] && isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) { args.push(expr()); while (isOp(',')) { p++; args.push(expr()); } }
        if (!isOp(')')) throw new ExprError('Missing ) after ' + name);
        p++;
        const n = FUNCS[name][0];
        if (n >= 0 && args.length !== n) throw new ExprError(name + ' needs ' + n + ' number' + (n > 1 ? 's' : ''));
        return { k: 'fn', name, args };
      }
      if (name[0] !== '#' && CONSTS[name] !== undefined) return { k: 'num', v: CONSTS[name] };
      if (name[0] !== '#' && UNITS[name] !== undefined) return { k: 'num', v: UNITS[name] };
      return { k: 'var', name: name.replace(/^#/, '') };
    }
    throw new ExprError('Unexpected "' + t.v + '"');
  }
  const ast = expr();
  if (p < toks.length) throw new ExprError('Unexpected "' + (toks[p].v) + '"');
  return ast;
}

export function refs(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.k === 'var') out.add(ast.name);
  if (ast.a) refs(ast.a, out);
  if (ast.b) refs(ast.b, out);
  if (ast.args) ast.args.forEach(a => refs(a, out));
  return out;
}

export function evalAst(ast, lookup) {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'neg': return -evalAst(ast.a, lookup);
    case 'var': {
      const v = lookup(ast.name);
      if (v === undefined) throw new ExprError('There is no variable #' + ast.name);
      return v;
    }
    case 'fn': return FUNCS[ast.name][1](...ast.args.map(a => evalAst(a, lookup)));
    case 'bin': {
      const a = evalAst(ast.a, lookup), b = evalAst(ast.b, lookup);
      switch (ast.o) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0) throw new ExprError('Dividing by zero'); return a / b;
        case '%': return a % b; case '^': return Math.pow(a, b);
      }
    }
  }
  throw new ExprError('Bad expression');
}

export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Evaluate the variable table. Returns {values:{name:number}, errors:{name:msg}}
export function evalVariables(vars) {
  const byName = {};
  for (const v of vars) byName[v.name] = v;
  const values = {}, errors = {}, state = {};
  function get(name) {
    if (values[name] !== undefined) return values[name];
    const v = byName[name];
    if (!v) return undefined;
    if (state[name] === 1) throw new ExprError('#' + name + ' refers back to itself');
    if (errors[name]) throw new ExprError('#' + name + ' has a problem');
    state[name] = 1;
    try {
      const val = evalAst(parse(v.expr), get);
      if (!isFinite(val)) throw new ExprError('Not a real number');
      values[name] = val;
      return val;
    } catch (e) {
      errors[name] = e.message;
      throw e;
    } finally { state[name] = 2; }
  }
  for (const v of vars) { try { get(v.name); } catch (e) { if (!errors[v.name]) errors[v.name] = e.message; } }
  return { values, errors };
}

export function evaluate(src, values) {
  const v = evalAst(parse(src), n => values[n]);
  if (!isFinite(v)) throw new ExprError('That is not a real number');
  return v;
}

export function isPlainNumber(src) {
  return typeof src === 'number' || /^\s*-?(\d+\.?\d*|\.\d+)\s*(mm)?\s*$/.test(String(src));
}

export function fmt(v, dec = 2) {
  if (!isFinite(v)) return '?';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return (Object.is(r, -0) ? 0 : r).toString();
}
