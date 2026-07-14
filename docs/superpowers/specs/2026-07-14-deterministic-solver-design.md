# Deterministic Solver (FormulaEngine) - Design Specification

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Builds on:** SPEC.md (Finance Solver PWA, revised 2026-07-13)

## Problem

The app shows Excel formulas produced by Claude, and those formulas are correct.
But Claude sometimes also states a numeric answer, and LLM mental arithmetic is
unreliable — the stated numbers are wrong. The user wants the app itself to
compute the answer accurately, in code.

## Goal

For every formula Claude returns, the app computes the numeric result
deterministically in client-side JavaScript and displays it beneath the formula.
Claude does what it is good at (reading the photo, choosing the formula); code
does the arithmetic. The app never displays a number computed by the LLM.

## Decision: evaluate Claude's Excel formulas in-app

Approaches considered:

| Approach | Verdict |
|---|---|
| **A. Evaluate Claude's Excel formulas in-app** | **Chosen.** Excel formulas are already the intermediate representation; smallest change; covers the whole course. |
| B. Structured JSON extraction + typed solver per problem type | Rejected: requires a schema for every problem type in a full business-finance course (ratios, TVM, bonds, stocks, capital budgeting, WACC, forex...); brittle for anything outside the schema. |
| C. Calculator/code tool-use loop with Claude | Rejected: multiple API round trips, more client complexity, and the LLM still assembles the final answer — weakest determinism guarantee. |

## Scope

All topics of a business finance college course: financial statements and
ratios, time value of money, interest rates, bond valuation, stock valuation,
risk and return (CAPM), capital budgeting, cash flow estimation, cost of
capital (WACC), firm performance, raising capital, international financial
management. Anything expressible as a self-contained Excel formula is
computable.

## Architecture

Existing five-state machine, camera, image pipeline, and API client are
unchanged. One new module is added after the API response:

```
<video> → canvas → ImageProcessor → ClaudeAPIClient → raw text
                                                        │
                                          FormulaEngine (js/engine.js)
                                          parses each "=" line, computes value,
                                          resolves [VARIABLE] placeholders
                                                        │
                                          RESULTS state: formula + computed answer
```

New files:

- `js/engine.js` — formula parser + evaluator (our code)
- `js/vendor/formulajs.min.js` — vendored single-file copy of formulajs
  (Excel-matching implementations of NPV, IRR, MIRR, PMT, PV, FV, RATE, NPER,
  EFFECT, NOMINAL, ...). No npm, no build step; committed like any other file.

Properties:

- Evaluation is entirely client-side, after the API response. No extra API
  calls; no change to cost or latency.
- If the engine cannot evaluate a line, the formula still displays — without a
  computed value. Evaluation failure never blocks the app.

## FormulaEngine (js/engine.js)

**Input:** Claude's raw response text.
**Output:** the response's non-empty lines in order, each annotated:
`{ text, kind: 'formula' | 'text', value: string | null }` — `value` is the
formatted computed result for formula lines that evaluated successfully.
This preserves the existing verbatim line-by-line rendering.

### Response parsing

Same line rules the results screen already uses: lines starting with `=` are
formulas; the nearest preceding non-formula line is the label; other lines are
notes.

### Formula grammar (restricted, controlled by our own skill prompt)

- Numbers (`1000`, `2.5`), percentages (`10%` → `0.10`)
- Operators `+ - * / ^` with standard precedence; parentheses
- Function calls, nested allowed: `NPV(...)`, `IRR({...})`
- Array literals: `{-100000, 50000, 60000}`
- Placeholders: `[NPV_STEP1]`

Deliberately NOT a full Excel parser: no cell references, ranges, strings, or
named ranges. The skill prompt forbids Claude from emitting them.

### Evaluation

Recursive-descent parser producing an AST evaluated directly: arithmetic in
JS; function calls dispatched to vendored formulajs. `^` is exponentiation,
`%` divides by 100, matching Excel. Plain-arithmetic formulas (e.g. ratio
problems, `=45000/300000`) evaluate without any Excel function.

### Variable resolution

Formulas evaluate top-to-bottom. Each step's computed value is stored under
the name declared in its label; a later `[NAME]` placeholder substitutes the
stored value. Binding is unambiguous because the skill prompt requires the
label line to declare the name (see prompt contract below).

### Failure containment

Every formula evaluates inside try/catch. Parse error, unknown function,
unresolvable placeholder, or a formulajs error result (e.g. IRR
non-convergence) → `value: null` for that block only; remaining blocks still
compute. Principle: **the app never shows a number it isn't sure of.**

### Number formatting

Explicit rule: if `|value| < 1`, display 4 decimals with the percent
equivalent alongside (e.g. `0.1372 (13.72%)`) — this covers rates and ratios.
Otherwise display with thousands separators and 2 decimals
(e.g. `12,434.26`).

## Skill prompt contract changes (finance-solver-skill.txt)

Additive tightening; the human-readable format is unchanged:

1. **Self-contained formulas only** — literal numbers, whitelisted functions,
   arithmetic, `{...}` arrays, `[PLACEHOLDER]`s. Never cell references,
   ranges, strings, or named ranges.
2. **Whitelisted functions** — the skill lists the functions the engine
   supports: NPV, IRR, MIRR, PMT, PV, FV, RATE, NPER, EFFECT, NOMINAL,
   AVERAGE, STDEV.S, STDEV.P, SUM, SQRT, ABS, ROUND, MAX, MIN, plus plain
   arithmetic. Claude must prefer these; others still display but get no
   computed value. Bond problems must be solved with per-period
   PV/RATE/PMT/FV/NPER — never PRICE/YIELD, which require dates (the grammar
   has no dates or strings).
3. **Placeholder discipline** — a placeholder must exactly match an earlier
   step's declared name. The step label line ends with the name in brackets:
   `Step 1 - NPV [NPV_STEP1]:`.
4. **No numeric answers from Claude** — Claude must never state a computed
   result; the app computes. (Removes the observed failure mode.)
5. **`ERROR:` sentinel unchanged.**

## Results screen

Per solved problem:

```
Project A NPV:                      ← label, gray (as today)
=NPV(10%,50000,60000,70000)-100000  ← formula, white monospace (as today)
→ 12,434.26                         ← computed answer, NEW: large, white
Note: NPV > 0 means accept          ← note, gray (as today)
```

If a value could not be computed, the `→` line is simply absent — no error
text in the results. ASCII-minimalism palette/typography unchanged.

## Error handling

App-state-level handling (ERROR state, 401 → Setup, network errors) is
unchanged. Evaluation failures are not app errors:

| Failure | Behavior |
|---|---|
| Formula fails to parse | Block shows formula without value; others unaffected |
| Unknown/unsupported function | Same |
| Unresolvable `[PLACEHOLDER]` | Same |
| formulajs error result (e.g. IRR non-convergence) | Same |
| Vendored formulajs fails to load | Engine disabled; app behaves exactly like today (formulas only) |

## Testing

The engine is pure logic and gets real tests:

- `tests/engine.test.mjs` — framework-free, run with `node tests/engine.test.mjs`
  (the vendored formulajs UMD bundle loads in Node as well as the browser):
  assertions comparing engine output against Excel-verified expected values
  for each supported function, operator precedence, `%` handling, array
  literals, placeholder chaining, and each failure mode. Exit code 0 = pass.
- Golden cases across course topics: TVM lump sum, annuity due, bond
  price/YTM, DDM stock value, CAPM, WACC, NPV/IRR/MIRR/PI/payback chains,
  a ratio problem.
- End-to-end (manual): photograph real homework; confirm the computed value
  matches Excel when the same formula is pasted.

## Out of scope

- Full Excel grammar (cell references, ranges, strings)
- Server-side computation, extra API calls, streaming
- Changing camera, capture, setup, or state-machine behavior
