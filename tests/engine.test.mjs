// Engine test suite — framework-free. Run: node tests/engine.test.mjs
import { createRequire } from 'node:module';
import { evaluateFormula, EngineError, buildFunctionTable, formatValue, evaluateResponse } from '../js/engine.js';

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

// ---- formatting ----
equal('format currency', formatValue(47633.35837716), '47,633.36');
equal('format small = rate/ratio', formatValue(0.12682503), '0.1268 (12.68%)');
equal('format negative currency', formatValue(-864.0967), '-864.10');
equal('format 5%', formatValue(0.05), '0.0500 (5.00%)');
equal('format small integer', formatValue(4), '4.00');
equal('format zero as plain number', formatValue(0), '0.00');

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

// Erosion (cannibalization): Heavenly Cookie practice problem.
// Erosion = lost cookie margin; net change = brownie margin - erosion.
const erosion = evaluateResponse(
  [
    'Erosion Cost [EROSION_COST]:',
    '=112000*(0.80-0.21)+38000*(0.47-0.19)+25000*(0.53-0.18)+7000*(0.45-0.25)+10000*(0.56-0.31)',
    'Net Change in Annual Margin:',
    '=225000*(0.92-0.75)-[EROSION_COST]',
  ].join('\n'),
  FNS,
);
equal('erosion: cost', erosion[1].value, '89,370.00');
equal('erosion: net margin change', erosion[3].value, '-51,120.00');

// Opportunity cost: Revolution Records practice problem.
// Land enters at current market value (opportunity cost), not sunk historical cost.
const oppCost = evaluateResponse(
  'Adjusted NPV (studio NPV minus land market value):\n=560000-760000',
  FNS,
);
equal('opportunity cost: adjusted NPV', oppCost[1].value, '-200,000.00');

// Working capital: Cool Water inventory practice problem.
// Look-ahead convention: month's ending inventory covers NEXT month's sales.
// Cash flow = -pct*(next month sales - current month sales)*cost.
const inventory = evaluateResponse(
  [
    'January Inventory Cash Flow:',
    '=-11%*(2100000-2100000)*0.007',
    'February Inventory Cash Flow:',
    '=-11%*(2900000-2100000)*0.007',
    'March Inventory Cash Flow:',
    '=-11%*(3000000-2900000)*0.007',
  ].join('\n'),
  FNS,
);
equal('inventory: flat January is 0.00 (not -0.00)', inventory[1].value, '0.00');
equal('inventory: February use of cash', inventory[3].value, '-616.00');
equal('inventory: March use of cash', inventory[5].value, '-77.00');
equal('format normalizes -0', formatValue(-0), '0.00');

// Depreciation: Richardses' Tree Farm practice problem.
// SL half-year convention chains off [SL_ANNUAL]; MACRS uses table percents.
const depreciation = evaluateResponse(
  [
    'Straight-Line Annual Depreciation [SL_ANNUAL]:',
    '=94000/7',
    'Year 1 and Final Year (half-year convention):',
    '=[SL_ANNUAL]/2',
    'MACRS Year 1:',
    '=94000*14.29%',
    'MACRS Year 1 Tax Shield:',
    '=94000*14.29%*40%',
  ].join('\n'),
  FNS,
);
equal('depreciation: SL annual', depreciation[1].value, '13,428.57');
equal('depreciation: SL half-year', depreciation[3].value, '6,714.29');
equal('depreciation: MACRS year 1', depreciation[5].value, '13,432.60');
equal('depreciation: MACRS year 1 tax shield', depreciation[7].value, '5,373.04');

// Cost recovery: Richardses' Tree Farm sale practice problem.
// ATCF = price - (price - book value) * tax rate; loss yields a tax credit.
const costRecovery = evaluateResponse(
  [
    'Book Value After 4 Years [BOOK_VALUE]:',
    '=82000*(1-(14.29%+24.49%+17.49%+12.49%))',
    'After-Tax Cash Flow if Sold at 30000:',
    '=30000-(30000-[BOOK_VALUE])*40%',
    'After-Tax Cash Flow if Sold at 25616.80:',
    '=25616.80-(25616.80-[BOOK_VALUE])*40%',
    'After-Tax Cash Flow if Sold at 22000:',
    '=22000-(22000-[BOOK_VALUE])*40%',
  ].join('\n'),
  FNS,
);
equal('cost recovery: book value', costRecovery[1].value, '25,616.80');
equal('cost recovery: gain sale', costRecovery[3].value, '28,246.72');
equal('cost recovery: at-book sale', costRecovery[5].value, '25,616.80');
equal('cost recovery: loss sale (tax credit)', costRecovery[7].value, '23,446.72');

// OCF series + project NPV: Miglietti Restaurants practice problem.
// Ten chained OCF years (MACRS dies after year 8), salvage in the NPV call.
const migliettiDep = ['14.29%', '24.49%', '17.49%', '12.49%', '8.93%', '8.93%', '8.93%', '4.45%'];
const migliettiLines = [];
for (let t = 1; t <= 10; t++) {
  migliettiLines.push(`Year ${t} OCF [OCF${t}]:`);
  const margin = `(1-55%)*30000*43*(1.04*1.02)^${t - 1}`;
  migliettiLines.push(t <= 8
    ? `=(${margin}-360000-2200000*${migliettiDep[t - 1]})*(1-38%)+2200000*${migliettiDep[t - 1]}`
    : `=(${margin}-360000)*(1-38%)`);
}
migliettiLines.push('Project NPV:');
migliettiLines.push('=-2200000+NPV(8%,[OCF1],[OCF2],[OCF3],[OCF4],[OCF5],[OCF6],[OCF7],[OCF8],[OCF9],[OCF10]+130000*(1-38%))');
const miglietti = evaluateResponse(migliettiLines.join('\n'), FNS);
equal('OCF series: year 1', miglietti[1].value, '256,174.40');
equal('OCF series: year 2 (peak MACRS)', miglietti[3].value, '363,328.93');
equal('OCF series: year 9 (no depreciation)', miglietti[17].value, '353,914.52');
equal('OCF series: year 10', miglietti[19].value, '389,003.08');
equal('OCF series: project NPV', miglietti[21].value, '58,274.64');

// Incremental cash flows + IRR: Classic Autos practice problem.
// Exercises placeholders and expressions inside an IRR array literal.
const classicDep = ['20%', '32%', '19.2%', '11.52%', '11.52%'];
const classicQty = [250, 290, 340, 360, 320];
const classicLines = [];
for (let t = 1; t <= 5; t++) {
  classicLines.push(`Year ${t} OCF [OCF${t}]:`);
  classicLines.push(`=((27000-20000)*${classicQty[t - 1]}-1100000-4500000*${classicDep[t - 1]})*(1-30%)+4500000*${classicDep[t - 1]}`);
}
classicLines.push(
  'Book Value End of Year 5 [BOOK_VALUE]:',
  '=4500000*5.76%',
  'After-Tax Salvage [SALVAGE]:',
  '=500000-(500000-[BOOK_VALUE])*30%',
  'Project IRR:',
  '=IRR({-4500000-600000,[OCF1],[OCF2],[OCF3],[OCF4],[OCF5]+[SALVAGE]+600000})',
);
const classic = evaluateResponse(classicLines.join('\n'), FNS);
equal('incremental: year 1 OCF', classic[1].value, '725,000.00');
equal('incremental: year 5 OCF', classic[9].value, '953,520.00');
equal('incremental: book value at sale', classic[11].value, '259,200.00');
equal('incremental: after-tax salvage', classic[13].value, '427,760.00');
equal('incremental: IRR with placeholder array', classic[15].value, '0.0542 (5.42%)');

// Crossover rate: two-computer practice problem. Crossover = IRR of the
// year-by-year differential cash flows; choice = higher NPV at the firm's rate.
const crossover = evaluateResponse(
  [
    'Crossover Rate:',
    '=IRR({-890-(-710),106-490,314-282,969-108})',
    'Computer A NPV [NPV_A]:',
    '=-890+NPV(12%,106,314,969)',
    'Computer B NPV [NPV_B]:',
    '=-710+NPV(12%,490,282,108)',
  ].join('\n'),
  FNS,
);
equal('crossover: differential IRR', crossover[1].value, '0.2210 (22.10%)');
equal('crossover: NPV A at 12%', crossover[3].value, '144.68');
equal('crossover: NPV B at 12%', crossover[5].value, '29.18');

// WACC: Eric's all-debt funding practice problem.
const wacc = evaluateResponse(
  'WACC:\n=(2906*8%+1861*10%+1233*16%)/(2906+1861+1233)',
  FNS,
);
equal('WACC: all-debt weighted average', wacc[1].value, '0.1026 (10.26%)');

// Book value adjusted WACC: Trout, Inc. practice problem.
// Current liabilities excluded; weights = LT liabilities and owners' equity.
const troutWacc = evaluateResponse(
  'Book Value Adjusted WACC:\n=(7417504*7.2%+3300529*11.82%)/(7417504+3300529)',
  FNS,
);
equal('WACC: book value adjusted (Trout)', troutWacc[1].value, '0.0862 (8.62%)');

// Market value WACC: Salmon Enterprises practice problem.
// Debt = bonds * price; equity = shares * price, computed inside the weights.
const salmonWacc = evaluateResponse(
  'Market Value WACC:\n=(3000*933.94*7.2%+260000*38.11*11.82%)/(3000*933.94+260000*38.11)',
  FNS,
);
equal('WACC: market value (Salmon)', salmonWacc[1].value, '0.1080 (10.80%)');

// Three-component WACC (debt + preferred + common): DMI practice problem.
const dmiWacc = evaluateResponse(
  [
    'Book Value Adjusted WACC:',
    '=(60000*11.7%+14000*15.61%+23000*19.96%)/(60000+14000+23000)',
    'Market Value WACC:',
    '=(60000*1047.22*11.7%+140000*95.65*15.61%+920000*32.53*19.96%)/(60000*1047.22+140000*95.65+920000*32.53)',
  ].join('\n'),
  FNS,
);
equal('WACC: three-component book value (DMI)', dmiWacc[1].value, '0.1422 (14.22%)');
equal('WACC: three-component market value (DMI)', dmiWacc[3].value, '0.1452 (14.52%)');

// Cost of preferred stock with flotation fee: Kyle practice problem.
const preferred = evaluateResponse(
  'Cost of Preferred Stock:\n=95*6.2%/(66.38*(1-2%))',
  FNS,
);
equal('preferred: cost with flotation fee', preferred[1].value, '0.0905 (9.05%)');

// SML / CAPM cost of equity: Stan practice problem. Beta 0.95 lands on a
// float artifact (0.13254999...) that the Excel-style 15-digit scrub fixes.
const sml = evaluateResponse(
  [
    'Cost of Equity (beta 0.52):',
    '=4.8%+0.52*(13.7%-4.8%)',
    'Cost of Equity (beta 0.95):',
    '=4.8%+0.95*(13.7%-4.8%)',
    'Cost of Equity (beta 0.99):',
    '=4.8%+0.99*(13.7%-4.8%)',
    'Cost of Equity (beta 1.36):',
    '=4.8%+1.36*(13.7%-4.8%)',
  ].join('\n'),
  FNS,
);
equal('SML: beta 0.52', sml[1].value, '0.0943 (9.43%)');
equal('SML: beta 0.95 rounds like Excel', sml[3].value, '0.1326 (13.26%)');
equal('SML: beta 0.99', sml[5].value, '0.1361 (13.61%)');
equal('SML: beta 1.36', sml[7].value, '0.1690 (16.90%)');
equal('format scrubs float artifact', formatValue(0.048 + 0.95 * (0.137 - 0.048)), '0.1326 (13.26%)');

// Reverse SML (solve for beta): Magellan practice problem.
const projectBeta = evaluateResponse(
  'Project Beta:\n=(17.2%-3.1%)/(12.2%-3.1%)',
  FNS,
);
equal('SML: beta from expected return', projectBeta[1].value, '1.55');

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

// ---- MCQ two-call flow: marker extraction, transcript, answer parsing ----
import { extractMcq, buildTranscript, parseAnswers } from '../js/engine.js';

// Marker: a text line that is exactly "MCQ" flags the response and is stripped.
const mcqEval = evaluateResponse('Project NPV [NPV]:\n=100-985\nMCQ', FNS);
const mcqOut = extractMcq(mcqEval);
equal('mcq: marker detected', mcqOut.mcq, true);
equal('mcq: marker line stripped', mcqOut.lines.length, 2);
equal('mcq: kept lines intact', mcqOut.lines[1].value, '-885.00');

const noMcqOut = extractMcq(evaluateResponse('NPV:\n=2+2', FNS));
equal('mcq: absent marker → false', noMcqOut.mcq, false);
equal('mcq: lines unchanged without marker', noMcqOut.lines.length, 2);

// "MCQ" inside a longer label is not a marker.
const mcqLabel = extractMcq(evaluateResponse('MCQ analysis for exam:\n=2+2', FNS));
equal('mcq: substring label is not a marker', mcqLabel.mcq, false);

// Transcript: computed formulas carry "→ value"; text and failed lines verbatim.
const transcript = buildTranscript(
  evaluateResponse('Project NPV [NPV]:\n=100-985\nBad:\n=FOO(1)', FNS),
);
equal(
  'transcript: values appended, failures verbatim',
  transcript,
  'Project NPV [NPV]:\n=100-985 \u2192 -885.00\nBad:\n=FOO(1)',
);

// Answer parsing: second-call reply must contain at least one Answer line.
equal(
  'answers: single answer line kept',
  JSON.stringify(parseAnswers('Answer: B \u2014 reject; NPV is negative')),
  JSON.stringify(['Answer: B \u2014 reject; NPV is negative']),
);
equal(
  'answers: multi-question lines kept',
  JSON.stringify(parseAnswers('Q1 Answer: B \u2014 reject\n\nQ2 Answer: D \u2014 5,102\n')),
  JSON.stringify(['Q1 Answer: B \u2014 reject', 'Q2 Answer: D \u2014 5,102']),
);
equal('answers: NONE yields null', parseAnswers('NONE'), null);
equal('answers: empty reply yields null', parseAnswers('  \n '), null);

// ---- summary ----
if (failures.length === 0) {
  console.log(`ALL TESTS PASS (${passed})`);
  process.exit(0);
} else {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
