/**
 * @file Safe math formula evaluator for calculation blocks and interactive quotes.
 *
 * Strictly parses and evaluates basic arithmetic expressions (+, -, *, /, parens, numbers)
 * without using eval() or Function(), ensuring zero vulnerability surface.
 */

/**
 * Tokenize a math expression into numbers, operators, and parentheses.
 * @param {string} expr
 * @returns {string[]}
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push(num);
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    // Ignore any unrecognized token
    i++;
  }
  return tokens;
}

/**
 * Parse and evaluate an arithmetic token stream using shunting-yard / recursive descent.
 * @param {string[]} tokens
 * @returns {number}
 */
function evaluateTokens(tokens) {
  let pos = 0;

  /** @returns {number} */
  function parsePrimary() {
    if (pos >= tokens.length) return 0;
    const token = tokens[pos];
    if (token === "(") {
      pos++; // consume '('
      const val = parseExpression();
      if (tokens[pos] === ")") pos++; // consume ')'
      return val;
    }
    if (token === "-") {
      pos++;
      return -parsePrimary();
    }
    if (token === "+") {
      pos++;
      return parsePrimary();
    }
    const num = parseFloat(token);
    pos++;
    return Number.isNaN(num) ? 0 : num;
  }

  /** @returns {number} */
  function parseMultiplicative() {
    let left = parsePrimary();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos];
      pos++;
      const right = parsePrimary();
      if (op === "*") left *= right;
      else if (op === "/") left = right === 0 ? 0 : left / right;
    }
    return left;
  }

  /** @returns {number} */
  function parseExpression() {
    let left = parseMultiplicative();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos];
      pos++;
      const right = parseMultiplicative();
      if (op === "+") left += right;
      else if (op === "-") left -= right;
    }
    return left;
  }

  return parseExpression();
}

/**
 * Safely evaluates a math formula string where answers have been piped in.
 * e.g. evaluateFormula("10 * 50 + 100") -> 600
 *
 * @param {string} formula
 * @returns {number}
 */
export function evaluateFormula(formula) {
  if (!formula || typeof formula !== "string") return 0;
  // Strip anything that isn't digits, operators, dots, or parens
  const sanitized = formula.replace(/[^0-9.+\-*/() ]/g, "");
  const tokens = tokenize(sanitized);
  return evaluateTokens(tokens);
}
