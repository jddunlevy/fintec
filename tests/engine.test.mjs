// Engine test suite — framework-free. Run: node tests/engine.test.mjs
import { createRequire } from 'node:module';
import { evaluateFormula, EngineError } from '../js/engine.js';

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

// ---- summary ----
if (failures.length === 0) {
  console.log(`ALL TESTS PASS (${passed})`);
  process.exit(0);
} else {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
