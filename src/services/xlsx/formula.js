// Numeric Excel subset. Parsed references drive both fill translation and calculation.
const {fail} = require('../files/validation');
const {column} = require('./policy');

const invalid = () => { throw fail('XLSX_FORMULA_UNSUPPORTED'); };
const numeric = n => {
  if (!Number.isFinite(n)) throw fail('XLSX_FORMULA_NUMERIC_ERROR');
  return n;
};
function colName(n) {
  let name = '';
  while (n) { n--; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26); }
  return name;
}
const reference = /^(?:(('(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!))?(\$?)([A-Z]{1,3})(\$?)([1-9]\d{0,6})(?![\p{L}\p{N}_.$])/iu;
function parse(input, dc = 0, dr = 0) {
  if (typeof input !== 'string' || input.length > 1024) invalid();
  const source = input.trim().replace(/^=/, '');
  let pos = 0, count = 0, depth = 0, expression = '';
  function skip() { while (source[pos] === ' ') pos++; }
  function take(s) {
    skip();
    if (!source.startsWith(s, pos)) return false;
    pos += s.length; expression += s; return true;
  }
  function ref() {
    skip();
    const match = reference.exec(source.slice(pos));
    if (!match) invalid();
    const [, prefix, quoted, fixedCol, letters, fixedRow, digits] = match;
    const c = column(letters.toUpperCase()) + (fixedCol ? 0 : dc);
    const r = Number(digits) + (fixedRow ? 0 : dr);
    if (c < 1 || c > 16384 || r < 1 || r > 1048576) throw fail('XLSX_FORMULA_REFERENCE');
    const sheet = quoted?.startsWith("'") ? quoted.slice(1,-1).replace(/''/g,"'") : quoted;
    expression += (prefix || '') + fixedCol + colName(c) + fixedRow + r;
    pos += match[0].length;
    return {kind:'ref', sheet, c, r};
  }
  function atom() {
    if (++count > 256 || ++depth > 40) throw fail('XLSX_FORMULA_LIMIT');
    let node;
    skip();
    if (take('+') || take('-')) {
      const op = expression.at(-1);
      node = {kind:'unary', op, child:atom()};
    } else if (take('(')) {
      node = binary(0); if (!take(')')) invalid();
    } else {
      const rest = source.slice(pos);
      const fn = /^(SUMPRODUCT|ROUND|SUM)\s*\(/i.exec(rest);
      const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
      if (fn) {
        const name = fn[1].toUpperCase();
        pos += fn[0].length; expression += name + '(';
        const args = [binary(0)];
        while (take(',')) args.push(binary(0));
        if (!take(')') || (name === 'ROUND' && args.length !== 2) || (name === 'SUMPRODUCT' && args.length !== 1)) invalid();
        node = {kind:'call', name, args};
      } else if (num) {
        pos += num[0].length; expression += num[0];
        node = {kind:'number', value:numeric(Number(num[0]))};
      } else {
        node = ref();
        if (take(':')) {
          const end = ref();
          if (end.sheet && end.sheet !== node.sheet) invalid();
          node = {kind:'range', from:node, to:end};
        }
      }
    }
    depth--;
    return node;
  }
  function binary(level) {
    if (level === 2) return atom();
    let left = binary(level + 1);
    const ops = level === 0 ? ['+','-'] : ['*','/'];
    while (true) {
      const op = ops.find(take);
      if (!op) return left;
      left = {kind:'binary', op, left, right:binary(level + 1)};
    }
  }
  const tree = binary(0); skip();
  if (pos !== source.length) invalid();
  return {expression, tree};
}

function scalar(value) {
  if (value === null) return 0;
  if (typeof value !== 'number') throw fail('XLSX_FORMULA_NON_NUMERIC');
  return value;
}
function rounded(value, places) {
  if (!Number.isInteger(places) || Math.abs(places) > 15) invalid();
  // Normalize binary products to 15 significant decimal digits before rounding a midpoint.
  const [mantissa, exp] = Math.abs(value).toExponential(14).split('e');
  const digits = BigInt(mantissa.replace('.', ''));
  const shift = Number(exp) - 14 + places;
  if (shift >= 0) return value;
  const divisor = 10n ** BigInt(-shift);
  const integer = digits / divisor + (digits % divisor * 2n >= divisor ? 1n : 0n);
  return numeric(Math.sign(value) * Number(integer.toString() + 'e' + -places));
}
function evaluate(tree, read, vectorRound = false) {
  switch (tree.kind) {
    case 'number': return tree.value;
    case 'ref': return read(tree);
    case 'range': {
      const {from,to} = tree, values = [];
      for (let r = Math.min(from.r,to.r); r <= Math.max(from.r,to.r); r++)
        for (let c = Math.min(from.c,to.c); c <= Math.max(from.c,to.c); c++)
          values.push(read({sheet:from.sheet,c,r}));
      return values;
    }
    case 'unary': {
      const value = scalar(evaluate(tree.child,read));
      return tree.op === '-' ? -value : value;
    }
    case 'binary': {
      const a = scalar(evaluate(tree.left,read)), b = scalar(evaluate(tree.right,read));
      if (tree.op === '/') { if (b === 0) throw fail('XLSX_FORMULA_DIV_ZERO'); return numeric(a/b); }
      if (tree.op === '*') return numeric(a*b);
      return numeric(tree.op === '+' ? a+b : a-b);
    }
    case 'call': {
      const values = tree.args.map(arg => evaluate(arg,read,tree.name === 'SUMPRODUCT'));
      if (tree.name === 'ROUND') {
        const [value, places] = values;
        const round = n => rounded(scalar(n),scalar(places));
        if (Array.isArray(value) && !vectorRound) invalid();
        return Array.isArray(value) ? value.map(round) : round(value);
      }
      let total = 0, correction = 0;
      for (const group of values) for (const value of Array.isArray(group) ? group : [group]) {
        if (typeof value !== 'number') continue;
        const next = numeric(total + value);
        correction += Math.abs(total) >= Math.abs(value) ? (total-next)+value : (value-next)+total;
        total = next;
      }
      return numeric(total+correction);
    }
    default: return invalid();
  }
}

module.exports = {parse, evaluate, scalar, colName};
