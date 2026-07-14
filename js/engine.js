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
