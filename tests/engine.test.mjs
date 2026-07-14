// Engine test suite — framework-free. Run: node tests/engine.test.mjs
import { createRequire } from 'node:module';
import { evaluateFormula, EngineError, buildFunctionTable } from '../js/engine.js';

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

// ---- finance golden tests (via vendored formulajs) ----
const FNS = buildFunctionTable(formulajs);

// TVM
approx('FV lump sum', evaluateFormula('=FV(8%,10,0,-1000)', FNS), 2158.92, 0.01);
approx('FV annuity due', evaluateFormula('=FV(8%,10,-1000,0,1)', FNS), 15645.49, 0.01);
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

// ---- summary ----
if (failures.length === 0) {
  console.log(`ALL TESTS PASS (${passed})`);
  process.exit(0);
} else {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
