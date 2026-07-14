# Deterministic Solver (FormulaEngine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app computes each Excel formula Claude returns deterministically in client-side JS and displays the numeric answer beneath the formula — the LLM never does arithmetic.

**Architecture:** A new `js/engine.js` module tokenizes and parses the restricted Excel-formula grammar our skill prompt guarantees (numbers, `%`, `+ - * / ^`, parentheses, function calls, `{...}` arrays, `[PLACEHOLDER]`s), evaluates the AST with arithmetic in JS and Excel functions dispatched to a vendored formulajs bundle, and resolves placeholders by chaining earlier computed results. `app.js` renders each formula line with a `→ value` line beneath it. Evaluation failures degrade gracefully: the formula shows without a value.

**Tech Stack:** Vanilla ES-module JS (no framework, no build step), vendored `@formulajs/formulajs` UMD bundle, Node (any recent LTS) for running the test file.

**Spec:** `docs/superpowers/specs/2026-07-14-deterministic-solver-design.md`

## Global Constraints

- No npm, no bundler, no build step. Third-party code only as vendored single files in `js/vendor/`.
- Vanilla ES2020+ JavaScript, ES modules. Target: iOS Safari 16+.
- Design language "ASCII minimalism": colors only `#000000` / `#ffffff` / `#8e8e8e`, monospace everywhere, no icons, no spinners.
- **The app never shows a number it isn't sure of** — any parse/eval doubt → `value: null` → formula renders without a value line.
- Evaluation is entirely client-side after the API response: no new API calls, no latency or cost change.
- Existing five-state machine, camera, capture, setup, and API client behavior unchanged.
- Windows dev machine; bash shell (use `mkdir -p`, forward slashes).
- All engine tests must pass via `node tests/engine.test.mjs` (exit code 0, prints `ALL TESTS PASS`).

---

### Task 1: Vendor formulajs and create the test harness

**Files:**
- Create: `js/vendor/formulajs.min.js` (downloaded, committed verbatim)
- Create: `tests/engine.test.mjs` (harness + vendor smoke test only)

**Interfaces:**
- Produces: `js/vendor/formulajs.min.js` — UMD bundle; in the browser it sets `window.formulajs`; in Node it loads via `require()`. Exposes Excel functions as properties, e.g. `formulajs.FV(rate, nper, pmt, pv, type)`.
- Produces: test harness globals used by all later tasks: `check(name, ok, detail)`, `approx(name, actual, expected, tol)`, `equal(name, actual, expected)`, and the pass/fail summary + exit code.

- [ ] **Step 1: Download the formulajs browser bundle**

```bash
mkdir -p js/vendor tests
curl -L -o js/vendor/formulajs.min.js "https://cdn.jsdelivr.net/npm/@formulajs/formulajs@4/lib/browser/formula.min.js"
```

- [ ] **Step 2: Smoke-test the bundle loads in Node**

Run:
```bash
node -e "const f = require('./js/vendor/formulajs.min.js'); console.log(f.FV(0.08, 10, 0, -1000))"
```
Expected output: `2158.9249972727788` (± tiny float noise).
If this prints `undefined` or throws, the CDN path changed — check https://www.jsdelivr.com/package/npm/@formulajs/formulajs for the browser bundle path (`lib/browser/formula.min.js`) and re-download.

- [ ] **Step 3: Write the test harness with the smoke test**

Create `tests/engine.test.mjs`:

```js
// Engine test suite — framework-free. Run: node tests/engine.test.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const formulajs = require('../js/vendor/formulajs.min.js');

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${name}: ${detail}`);
}

function approx(name, actual, expected, tol = 0.01) {
  check(
    name,
    typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `expected ${expected} (±${tol}), got ${actual}`,
  );
}

function equal(name, actual, expected) {
  check(
    name,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function throws(name, fn) {
  try {
    fn();
    check(name, false, 'expected throw, got value');
  } catch {
    check(name, true);
  }
}

// ---- vendor smoke test ----
approx('vendor: FV lump sum', formulajs.FV(0.08, 10, 0, -1000), 2158.92, 0.01);

// ---- summary ----
if (failures.length === 0) {
  console.log(`ALL TESTS PASS (${passed})`);
  process.exit(0);
} else {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
```

- [ ] **Step 4: Run the suite**

Run: `node tests/engine.test.mjs`
Expected: `ALL TESTS PASS (1)`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add js/vendor/formulajs.min.js tests/engine.test.mjs
git commit -m "feat: vendor formulajs and add engine test harness"
```

---

### Task 2: Tokenizer, parser, and arithmetic evaluator (engine core)

**Files:**
- Create: `js/engine.js`
- Modify: `tests/engine.test.mjs` (insert tests between the smoke test and the summary block)

**Interfaces:**
- Consumes: test harness from Task 1.
- Produces: `evaluateFormula(formula: string, fns: object|null, vars?: object) -> number` — evaluates one formula string (leading `=` optional); throws `EngineError` on any failure (syntax error, unknown function, unresolved placeholder, non-finite result). `fns` maps UPPERCASE function names to implementations; `vars` maps UPPERCASE placeholder names to numbers.
- Produces: `EngineError` class (named export).

Excel semantics implemented here (they differ from math convention — later tasks and tests rely on them):
- `^` is **left**-associative: `2^3^2` = 64
- unary minus binds **tighter** than `^`: `-2^2` = 4
- postfix `%` divides by 100: `10%` = 0.1

- [ ] **Step 1: Write the failing tests**

Insert into `tests/engine.test.mjs` after the smoke test (the import at the top of the file):

```js
import { evaluateFormula, EngineError } from '../js/engine.js';
```

and the test block:

```js
// ---- arithmetic / grammar ----
approx('precedence', evaluateFormula('=2+3*4', null), 14, 1e-9);
approx('parens', evaluateFormula('=(2+3)*4', null), 20, 1e-9);
approx('percent literal', evaluateFormula('=10%', null), 0.1, 1e-12);
approx('percent in expr', evaluateFormula('=100*(1+8%)', null), 108, 1e-9);
approx('unary minus before ^ (Excel)', evaluateFormula('=-2^2', null), 4, 1e-9);
approx('^ left-assoc (Excel)', evaluateFormula('=2^3^2', null), 64, 1e-9);
approx('ratio (plain arithmetic)', evaluateFormula('=45000/300000', null), 0.15, 1e-12);
approx('CAPM (arithmetic only)', evaluateFormula('=3%+1.2*(10%-3%)', null), 0.114, 1e-12);
approx('WACC (arithmetic only)', evaluateFormula('=40%*6%*(1-25%)+60%*12%', null), 0.09, 1e-12);
approx('DDM stock value', evaluateFormula('=2.5/(11%-4%)', null), 35.7142857, 1e-6);
approx('leading = optional', evaluateFormula('2+2', null), 4, 1e-12);
approx('whitespace tolerated', evaluateFormula('= 2 + 3 * 4', null), 14, 1e-9);

// function-call plumbing with a stub table (formulajs wired in next task)
approx('function dispatch', evaluateFormula('=DOUBLE(2)+1', { DOUBLE: (x) => 2 * x }), 5, 1e-12);
approx('array literal arg', evaluateFormula('=FIRST({7,8,9})', { FIRST: (a) => a[0] }), 7, 1e-12);
approx('placeholder substitution', evaluateFormula('=[X]*2', null, { X: 21 }), 42, 1e-12);

// failures throw
throws('unknown function throws', () => evaluateFormula('=FOO(1)', null));
throws('unresolved placeholder throws', () => evaluateFormula('=[MISSING]+1', null));
throws('truncated formula throws', () => evaluateFormula('=2+', null));
throws('unbalanced paren throws', () => evaluateFormula('=(2+3', null));
throws('trailing garbage throws', () => evaluateFormula('=2+2 4', null));
throws('bad character throws', () => evaluateFormula('=2+$3', null));
throws('division by zero throws (non-finite)', () => evaluateFormula('=1/0', null));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/engine.test.mjs`
Expected: FAIL — module not found `../js/engine.js`.

- [ ] **Step 3: Implement the engine core**

Create `js/engine.js`:

```js
// FormulaEngine: parses and evaluates the restricted Excel-formula grammar
// the skill prompt guarantees. Excel semantics: '^' left-associative
// (2^3^2 = 64), unary minus binds tighter than '^' (-2^2 = 4), postfix '%'
// divides by 100. The app never shows a number it didn't compute.

export class EngineError extends Error {}

// ---- tokenizer ----

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = /^\d+(?:\.\d+)?/.exec(rest))) {
      tokens.push({ type: 'num', value: parseFloat(m[0]) });
    } else if ((m = /^[A-Za-z][A-Za-z0-9_.]*/.exec(rest))) {
      tokens.push({ type: 'ident', value: m[0].toUpperCase() });
    } else if ((m = /^\[([A-Za-z][A-Za-z0-9_]*)\]/.exec(rest))) {
      tokens.push({ type: 'placeholder', value: m[1].toUpperCase() });
    } else if ('+-*/^%(),{}'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    } else {
      throw new EngineError(`unexpected character: ${ch}`);
    }
    i += m[0].length;
  }
  return tokens;
}

// ---- parser (recursive descent over the restricted grammar) ----

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const t = next();
    if (!t || t.type !== type) throw new EngineError(`expected ${type}`);
    return t;
  };

  function parseExpr() {
    let node = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = next().type;
      node = { op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parsePow();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = next().type;
      node = { op, left: node, right: parsePow() };
    }
    return node;
  }

  function parsePow() { // Excel: '^' is left-associative
    let node = parseUnary();
    while (peek() && peek().type === '^') {
      next();
      node = { op: '^', left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() { // Excel: unary sign binds tighter than '^'
    if (peek() && (peek().type === '-' || peek().type === '+')) {
      const op = next().type;
      return { op: `u${op}`, operand: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix() { // postfix '%' divides by 100
    let node = parsePrimary();
    while (peek() && peek().type === '%') {
      next();
      node = { op: '%', operand: node };
    }
    return node;
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new EngineError('unexpected end of formula');
    if (t.type === 'num') return { num: t.value };
    if (t.type === 'placeholder') return { placeholder: t.value };
    if (t.type === '(') {
      const node = parseExpr();
      expect(')');
      return node;
    }
    if (t.type === '{') {
      const items = [parseExpr()];
      while (peek() && peek().type === ',') { next(); items.push(parseExpr()); }
      expect('}');
      return { array: items };
    }
    if (t.type === 'ident') {
      expect('(');
      const args = [];
      if (peek() && peek().type !== ')') {
        args.push(parseExpr());
        while (peek() && peek().type === ',') { next(); args.push(parseExpr()); }
      }
      expect(')');
      return { call: t.value, args };
    }
    throw new EngineError(`unexpected token: ${t.type}`);
  }

  const root = parseExpr();
  if (pos !== tokens.length) throw new EngineError('trailing tokens');
  return root;
}

// ---- evaluator ----

function evalNode(node, fns, vars) {
  if ('num' in node) return node.num;
  if ('placeholder' in node) {
    if (!vars || !(node.placeholder in vars)) {
      throw new EngineError(`unresolved [${node.placeholder}]`);
    }
    return vars[node.placeholder];
  }
  if ('array' in node) return node.array.map((n) => evalNode(n, fns, vars));
  if ('call' in node) {
    const fn = fns ? fns[node.call] : undefined;
    if (typeof fn !== 'function') {
      throw new EngineError(`unsupported function: ${node.call}`);
    }
    const result = fn(...node.args.map((n) => evalNode(n, fns, vars)));
    // formulajs signals #NUM!-style failures by returning an Error object
    if (result instanceof Error) throw new EngineError(result.message);
    return result;
  }
  if (node.op === 'u-') return -evalNode(node.operand, fns, vars);
  if (node.op === 'u+') return evalNode(node.operand, fns, vars);
  if (node.op === '%') return evalNode(node.operand, fns, vars) / 100;
  const left = evalNode(node.left, fns, vars);
  const right = evalNode(node.right, fns, vars);
  switch (node.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return left / right;
    case '^': return left ** right;
    default: throw new EngineError(`unknown operator: ${node.op}`);
  }
}

/**
 * Evaluates one formula string (leading '=' optional).
 * Throws EngineError on any failure. Returns a finite number.
 */
export function evaluateFormula(formula, fns, vars = {}) {
  const src = formula.startsWith('=') ? formula.slice(1) : formula;
  const value = evalNode(parse(tokenize(src)), fns, vars);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EngineError('non-numeric result');
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/engine.test.mjs`
Expected: `ALL TESTS PASS (23)`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add js/engine.js tests/engine.test.mjs
git commit -m "feat: formula tokenizer, parser, and arithmetic evaluator with Excel semantics"
```

---

### Task 3: Function whitelist wired to formulajs + finance golden tests

**Files:**
- Modify: `js/engine.js` (add `FUNCTION_NAMES` and `buildFunctionTable`)
- Modify: `tests/engine.test.mjs` (add golden tests)

**Interfaces:**
- Consumes: `evaluateFormula` from Task 2; vendored formulajs from Task 1.
- Produces: `buildFunctionTable(fjs: object|null|undefined) -> object|null` (named export) — maps each whitelisted UPPERCASE name to its formulajs implementation; returns `null` if `fjs` is missing. Handles dotted names (`STDEV.S`) whether formulajs exposes them flat (`fjs['STDEV.S']`) or nested (`fjs.STDEV.S`).
- Produces: the whitelist itself (single source of truth for the skill prompt in Task 6): NPV, IRR, MIRR, PMT, PV, FV, RATE, NPER, EFFECT, NOMINAL, AVERAGE, STDEV.S, STDEV.P, SUM, SQRT, ABS, ROUND, MAX, MIN.

- [ ] **Step 1: Write the failing tests**

Add to the imports in `tests/engine.test.mjs`:

```js
import { buildFunctionTable } from '../js/engine.js';
```

Add the test block, inserted after the Task 2 tests and BEFORE the `---- summary ----` block (the `FNS` const defined here is also used by Task 4's tests; expected values verified against Excel by hand):

```js
// ---- finance golden tests (via vendored formulajs) ----
const FNS = buildFunctionTable(formulajs);

// TVM
approx('FV lump sum', evaluateFormula('=FV(8%,10,0,-1000)', FNS), 2158.92, 0.01);
approx('FV annuity due', evaluateFormula('=FV(8%,10,-1000,0,1)', FNS), 15645.59, 0.01);
approx('PMT loan payment', evaluateFormula('=PMT(5%,10,-10000)', FNS), 1295.05, 0.01);
approx('RATE (inverse of PMT case)', evaluateFormula('=RATE(10,-1295.0457496545667,10000)', FNS), 0.05, 1e-6);
approx('NPER (inverse of PMT case)', evaluateFormula('=NPER(5%,-1295.0457496545667,10000)', FNS), 10, 1e-6);

// Bonds via per-period PV/RATE (no PRICE/YIELD — they need dates)
approx('bond price: 20 semiannual periods, 3% coupon, 4% yield',
  evaluateFormula('=-PV(4%,20,30,1000)', FNS), 864.10, 0.01);
approx('bond YTM per period',
  evaluateFormula('=RATE(20,30,-864.0967365,1000)', FNS), 0.04, 1e-6);

// Capital budgeting
approx('NPV', evaluateFormula('=NPV(10%,50000,60000,70000)-100000', FNS), 47633.36, 0.01);
approx('IRR', evaluateFormula('=IRR({-100000,50000,60000,70000})', FNS), 0.3388, 0.0005);
approx('MIRR', evaluateFormula('=MIRR({-100000,50000,60000,70000},10%,10%)', FNS), 0.2526, 0.0005);

// Interest rates
approx('EFFECT', evaluateFormula('=EFFECT(12%,12)', FNS), 0.1268250301, 1e-6);

// Risk & return
approx('AVERAGE of returns', evaluateFormula('=AVERAGE({10%,20%,-6%})', FNS), 0.08, 1e-9);
approx('STDEV.S of returns', evaluateFormula('=STDEV.S({0.1,0.2,-0.06})', FNS), 0.1311, 0.0005);
approx('SQRT', evaluateFormula('=SQRT(0.0172)', FNS), 0.131149, 1e-4);

// Whitelist enforcement: XNPV exists in formulajs but is NOT whitelisted
throws('non-whitelisted function throws', () => evaluateFormula('=XNPV(0.1,{1,2},{1,2})', FNS));
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node tests/engine.test.mjs`
Expected: FAIL — `buildFunctionTable` is not exported.

- [ ] **Step 3: Implement buildFunctionTable**

Add to `js/engine.js`, after the `EngineError` class:

```js
/** The only functions the engine evaluates. Must match the skill prompt. */
const FUNCTION_NAMES = [
  'NPV', 'IRR', 'MIRR', 'PMT', 'PV', 'FV', 'RATE', 'NPER',
  'EFFECT', 'NOMINAL',
  'AVERAGE', 'STDEV.S', 'STDEV.P', 'SUM',
  'SQRT', 'ABS', 'ROUND', 'MAX', 'MIN',
];

/**
 * Maps whitelisted names to formulajs implementations.
 * Returns null when formulajs is unavailable (engine degrades to
 * arithmetic-only; every function call yields value: null upstream).
 */
export function buildFunctionTable(fjs) {
  if (!fjs) return null;
  const table = {};
  for (const name of FUNCTION_NAMES) {
    const fn = fjs[name]
      ?? name.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), fjs);
    if (typeof fn === 'function') table[name] = fn;
  }
  return table;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/engine.test.mjs`
Expected: `ALL TESTS PASS (38)`, exit code 0.
If `STDEV.S of returns` is the only failure, inspect how the vendored bundle names it: `node -e "const f=require('./js/vendor/formulajs.min.js'); console.log(Object.keys(f).filter(k=>k.startsWith('STDEV')))"` and adjust the lookup in `buildFunctionTable` accordingly.

- [ ] **Step 5: Commit**

```bash
git add js/engine.js tests/engine.test.mjs
git commit -m "feat: whitelist finance functions dispatched to vendored formulajs"
```

---

### Task 4: Response-level evaluation — placeholders, formatting, failure containment

**Files:**
- Modify: `js/engine.js` (add `formatValue` and `evaluateResponse`)
- Modify: `tests/engine.test.mjs` (add tests)

**Interfaces:**
- Consumes: `evaluateFormula`, `buildFunctionTable` from Tasks 2–3.
- Produces: `formatValue(value: number) -> string` (named export) — `|value| < 1`: 4 decimals plus percent, e.g. `"0.1268 (12.68%)"`; otherwise `en-US` thousands separators with 2 decimals, e.g. `"47,633.36"`.
- Produces: `evaluateResponse(text: string, fns?: object|null) -> Array<{text: string, kind: 'formula'|'text', value: string|null}>` (named export) — the non-empty trimmed lines of Claude's response in order. `fns` defaults to `buildFunctionTable(globalThis.formulajs)` (the browser path; `window.formulajs` is set by the vendored script tag added in Task 5). This is the function `app.js` calls in Task 5.

Behavior contract (from the spec):
- Lines starting with `=` are formulas; everything else is text.
- Formulas evaluate top-to-bottom. If the nearest preceding text line contains `[NAME]`, the formula's raw numeric result is stored under `NAME` for later `[NAME]` placeholders.
- Every formula evaluates inside try/catch: parse error, unsupported function, unresolved placeholder, formulajs error, non-finite result → `value: null` for that line only; later lines still evaluate.
- `fns === null` (formulajs missing) → function calls all yield `value: null`, but plain-arithmetic formulas still compute.

- [ ] **Step 1: Write the failing tests**

Add to the imports in `tests/engine.test.mjs`:

```js
import { formatValue, evaluateResponse } from '../js/engine.js';
```

Add the test block, inserted after the Task 3 tests (it uses their `FNS` const) and BEFORE the `---- summary ----` block:

```js
// ---- formatting ----
equal('format currency', formatValue(47633.35837716), '47,633.36');
equal('format small = rate/ratio', formatValue(0.12682503), '0.1268 (12.68%)');
equal('format negative currency', formatValue(-864.0967), '-864.10');
equal('format 5%', formatValue(0.05), '0.0500 (5.00%)');
equal('format small integer', formatValue(4), '4.00');

// ---- response-level evaluation ----
const chained = evaluateResponse(
  [
    'Step 1 - Calculate NPV [NPV_STEP1]:',
    '=-2000000+NPV(9%,500000,500000,500000,500000,500000)',
    'Step 2 - Calculate EAA using NPV from Step 1:',
    '=PMT(9%, 5, -[NPV_STEP1], 0, 0)',
    '',
    'Note: NPV < 0 means reject',
  ].join('\n'),
  FNS,
);
equal('chained: line count (blank dropped)', chained.length, 5);
equal('chained: label kind', chained[0].kind, 'text');
equal('chained: label has no value', chained[0].value, null);
equal('chained: step 1 value', chained[1].value, '-55,174.37');
equal('chained: step 2 kind', chained[3].kind, 'formula');
check('chained: step 2 uses computed step 1',
  chained[3].value !== null && chained[3].value.startsWith('-14,184.9'),
  `got ${chained[3].value}`);
equal('chained: note preserved verbatim', chained[4].text, 'Note: NPV < 0 means reject');

// failure containment: one bad line never poisons the rest
const contained = evaluateResponse('A:\n=FOO(1,2)\nB:\n=2+2', FNS);
equal('containment: unknown fn yields null', contained[1].value, null);
equal('containment: later formula still computes', contained[3].value, '4.00');

const unresolved = evaluateResponse('=[MISSING]+1', FNS);
equal('containment: unresolved placeholder yields null', unresolved[0].value, null);

const malformed = evaluateResponse('=NPV(10%,', FNS);
equal('containment: malformed formula yields null', malformed[0].value, null);

// formulajs missing entirely: arithmetic still works, functions do not
const noLib = evaluateResponse('=FV(8%,10,0,-1000)\n=2+2', null);
equal('no formulajs: function yields null', noLib[0].value, null);
equal('no formulajs: arithmetic still computes', noLib[1].value, '4.00');
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node tests/engine.test.mjs`
Expected: FAIL — `formatValue` is not exported.

- [ ] **Step 3: Implement formatValue and evaluateResponse**

Add to the end of `js/engine.js`:

```js
/**
 * |value| < 1 → rate/ratio presentation: 4 decimals + percent equivalent.
 * Otherwise → currency-scale: thousands separators, 2 decimals.
 */
export function formatValue(value) {
  if (Math.abs(value) < 1) {
    return `${value.toFixed(4)} (${(value * 100).toFixed(2)}%)`;
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const LABEL_NAME_RE = /\[([A-Za-z][A-Za-z0-9_]*)\]/;

/**
 * Evaluates a full response from Claude. Returns its non-empty lines in
 * order, each annotated { text, kind: 'formula'|'text', value: string|null }.
 * A text line containing [NAME] declares that name for the next formula's
 * result; later formulas may reference it as a placeholder. Any evaluation
 * failure yields value: null for that line only.
 */
export function evaluateResponse(text, fns = buildFunctionTable(globalThis.formulajs)) {
  const vars = {};
  let pendingName = null;
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('=')) {
      let value = null;
      try {
        const n = evaluateFormula(line, fns, vars);
        value = formatValue(n);
        if (pendingName) vars[pendingName] = n;
      } catch {
        // Parse error, unsupported function, unresolved placeholder, or
        // formulajs error: show the formula without a value. Never guess.
      }
      pendingName = null;
      lines.push({ text: line, kind: 'formula', value });
    } else {
      const match = LABEL_NAME_RE.exec(line);
      pendingName = match ? match[1].toUpperCase() : null;
      lines.push({ text: line, kind: 'text', value: null });
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/engine.test.mjs`
Expected: `ALL TESTS PASS (56)`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add js/engine.js tests/engine.test.mjs
git commit -m "feat: response-level evaluation with placeholder chaining and value formatting"
```

---

### Task 5: App integration — script tag, results rendering, value styling

**Files:**
- Modify: `index.html` (load vendored formulajs before the module script)
- Modify: `js/app.js:174-192` (renderResults uses the engine)
- Modify: `style.css` (add `.line-value` after the `.line-formula` rule, ~line 221)

**Interfaces:**
- Consumes: `evaluateResponse(text)` from Task 4 (browser default: `window.formulajs` set by the vendored script tag).
- Produces: results screen renders, per formula line, a `→ <value>` div with class `line-value` when `value !== null`. No other screen or state-machine change.

- [ ] **Step 1: Load the vendored bundle in index.html**

In `index.html`, replace:

```html
  <script type="module" src="js/app.js"></script>
```

with:

```html
  <script src="js/vendor/formulajs.min.js"></script>
  <script type="module" src="js/app.js"></script>
```

(Classic script first so `window.formulajs` exists before the module runs. If the file fails to load, the engine degrades to arithmetic-only per Task 4 — the app still works.)

- [ ] **Step 2: Render engine output in app.js**

In `js/app.js`, add to the imports at the top (after `import { canvasToBase64Jpeg } from './image.js';`):

```js
import { evaluateResponse } from './engine.js';
```

Replace the entire `renderResults` function (currently lines 174–192, including its comment block) with:

```js
// ---- results rendering ----
// Engine annotates each line; formulas that computed get a "→ value" line.
// Content rendered verbatim via textContent — no markup interpretation.

function renderResults(text) {
  els.resultsScroll.replaceChildren();
  for (const line of evaluateResponse(text)) {
    const div = document.createElement('div');
    div.className = line.kind === 'formula' ? 'line-formula' : 'line-label';
    div.textContent = line.text;
    els.resultsScroll.appendChild(div);
    if (line.value !== null) {
      const val = document.createElement('div');
      val.className = 'line-value';
      val.textContent = `\u2192 ${line.value}`;
      els.resultsScroll.appendChild(val);
    }
  }
  els.resultsScroll.scrollTop = 0;
}
```

- [ ] **Step 3: Style the value line**

In `style.css`, after the `.line-formula` rule, add:

```css
/* Computed answer: produced by the engine, never by the LLM. */
.line-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--fg);
  margin: 0 0 12px;
  user-select: text;
  -webkit-user-select: text;
}
```

- [ ] **Step 4: Verify in the browser**

Run: `python -m http.server 8000` (leave it running), open `http://localhost:8000` in a desktop browser, open the devtools console, and run:

```js
import('./js/engine.js').then((m) =>
  console.log(m.evaluateResponse('Project A NPV:\n=NPV(10%,50000,60000,70000)-100000')));
```

Expected: array of 2 entries; the second has `kind: 'formula'`, `value: '47,633.36'`. This proves the vendored script tag exposed `window.formulajs` to the engine's browser default path.

Also run `node tests/engine.test.mjs` — Expected: `ALL TESTS PASS (56)` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js style.css
git commit -m "feat: display engine-computed answers under each formula"
```

---

### Task 6: Skill prompt contract update

**Files:**
- Modify: `finance-solver-skill.txt`

**Interfaces:**
- Consumes: the whitelist from Task 3 (must match `FUNCTION_NAMES` exactly) and the placeholder declaration convention from Task 4 (`[NAME]` in the label line).
- Produces: the updated system-prompt contract; `js/api.js` already fetches this file verbatim — no code change.

- [ ] **Step 1: Add the new core rules**

In `finance-solver-skill.txt`, in the `## Core Rules` section, after the line `**Excel formulas only.** Never calculate numbers manually - rounding errors guaranteed.`, add:

```
**Never state a numeric answer.** The app computes every formula's result itself. Output labels, formulas, and brief notes only - no computed numbers anywhere.

**Self-contained formulas only.** Use literal numbers, the allowed functions below, arithmetic (+ - * / ^ %), array literals {}, and [PLACEHOLDER] names. Never cell references (A1), ranges (A1:B2), text strings, dates, or named ranges.
```

- [ ] **Step 2: Add the allowed-functions section**

After the `## Core Rules` section (before `## Output Format`), add:

```
## Allowed Functions

NPV, IRR, MIRR, PMT, PV, FV, RATE, NPER, EFFECT, NOMINAL, AVERAGE, STDEV.S, STDEV.P, SUM, SQRT, ABS, ROUND, MAX, MIN - plus plain arithmetic.

Bond problems: use PV / RATE / PMT / FV / NPER with per-period values (e.g. semiannual coupon and semiannual rate). Never PRICE or YIELD - they require dates, which are not allowed.
```

- [ ] **Step 3: Update the multi-step section to declare placeholders in labels**

Replace the entire `## Multi-Step Problems` section body (the text between the `## Multi-Step Problems` heading and `## Decision Rules Reference`) with:

```
When a formula depends on a previous answer, declare a variable name in brackets at the end of the earlier step's label, then reference it in the later formula:

Step 1 - Calculate NPV [NPV_STEP1]:

=-2000000+NPV(9%,500000,500000,500000,500000,500000)

Step 2 - Calculate EAA using NPV from Step 1:

=PMT(9%, 5, -[NPV_STEP1], 0, 0)

Note: In Excel, replace [NPV_STEP1] with your Step 1 result.

A placeholder must exactly match a name declared in an earlier label.
```

- [ ] **Step 4: Update the Common Mistakes table**

In the `| Mistake | Why It's Wrong |` table, add two rows at the end:

```
| Stating computed results | The app computes; LLM arithmetic is unreliable |
| Cell references or dates in formulas | The app cannot evaluate them - use literal numbers |
```

- [ ] **Step 5: Verify and commit**

Run: `node tests/engine.test.mjs`
Expected: `ALL TESTS PASS (56)` (prompt change touches no code).

Read the modified `finance-solver-skill.txt` end to end and confirm: the function list matches `FUNCTION_NAMES` in `js/engine.js` exactly; the placeholder example matches the Task 4 test input.

```bash
git add finance-solver-skill.txt
git commit -m "feat: tighten skill prompt contract for machine-evaluated formulas"
```

---

## Manual end-to-end verification (after all tasks)

Not a plan task — the checklist for the human with a phone and homework:

1. `python -m http.server 8000`, desktop browser with webcam: photograph an NPV problem displayed on another screen; confirm the results screen shows the formula and a `→` value, and that pasting the formula into Excel yields the same number.
2. A multi-step problem (NPV → EAA): confirm the second value used the first.
3. A blurry photo: confirm the `ERROR:` path is unchanged.
4. Deploy to the HTTPS host and repeat on iPhone Safari.
