/** Parser for Factorio noise-expression strings.
 *
 *  Grammar and precedence follow the prototype docs for `NoiseExpression`:
 *  `^` binds tightest and is right-associative, then the unary operators,
 *  then `* / % %%`, `+ -`, comparisons, equality, `&`, `~` (xor), `|`.
 *  Calls take positional `f(a, b)` or named `f{a = 1, b = 2}` arguments. */

export type Ast =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; name: string }
  | { t: "un"; op: "-" | "+" | "~"; a: Ast }
  | { t: "bin"; op: BinOp; a: Ast; b: Ast }
  | { t: "call"; name: string; pos: Ast[] | null; named: Record<string, Ast> | null };

export type BinOp =
  | "^" | "*" | "/" | "%" | "%%" | "+" | "-"
  | "<" | "<=" | ">" | ">=" | "==" | "~=" | "&" | "~" | "|";

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string }
  | { k: "end" };

const NUMBER = /^(0x[0-9a-fA-F]+|([0-9]+\.?[0-9]*|\.[0-9]+)(e[-+]?[0-9]+)?)/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_:]*/;
const OPERATORS = ["%%", "<=", ">=", "==", "~=", "!=", "^", "*", "/", "%", "+", "-", "<", ">", "&", "~", "|", "(", ")", "{", "}", ",", "="];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`unterminated string in noise expression: ${src}`);
      out.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num) {
      out.push({ k: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (!op) throw new Error(`unexpected '${c}' at ${i} in noise expression: ${src}`);
    out.push({ k: "op", v: op === "!=" ? "~=" : op });
    i += op.length;
  }
  out.push({ k: "end" });
  return out;
}

/** Binary precedence, higher binds tighter. `^` is handled separately. */
const BINARY: Record<string, number> = {
  "|": 1,
  "~": 2,
  "&": 3,
  "==": 4, "~=": 4,
  "<": 5, "<=": 5, ">": 5, ">=": 5,
  "+": 6, "-": 6,
  "*": 7, "/": 7, "%": 7, "%%": 7,
};

export function parseExpression(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok => toks[p]!;
  const isOp = (v: string): boolean => {
    const t = peek();
    return t.k === "op" && t.v === v;
  };
  const expect = (v: string): void => {
    if (!isOp(v)) throw new Error(`expected '${v}' in noise expression: ${src}`);
    p++;
  };

  function binary(minPrec: number): Ast {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t.k !== "op") break;
      const prec = BINARY[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = binary(prec + 1);
      left = { t: "bin", op: t.v as BinOp, a: left, b: right };
    }
    return left;
  }

  function unary(): Ast {
    const t = peek();
    if (t.k === "op" && (t.v === "-" || t.v === "+" || t.v === "~")) {
      p++;
      return { t: "un", op: t.v, a: unary() };
    }
    return power();
  }

  // `^` binds tighter than unary minus on its left (-x^2 is -(x^2)) but its
  // right operand may itself carry a unary operator (2^-x).
  function power(): Ast {
    const base = primary();
    if (isOp("^")) {
      p++;
      return { t: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  }

  function primary(): Ast {
    const t = peek();
    if (t.k === "num") {
      p++;
      return { t: "num", v: t.v };
    }
    if (t.k === "str") {
      p++;
      return { t: "str", v: t.v };
    }
    if (t.k === "id") {
      p++;
      if (isOp("(")) {
        p++;
        const pos: Ast[] = [];
        if (!isOp(")")) {
          do pos.push(binary(1));
          while (isOp(",") && ++p);
        }
        expect(")");
        return { t: "call", name: t.v, pos, named: null };
      }
      if (isOp("{")) {
        p++;
        const named: Record<string, Ast> = {};
        while (!isOp("}")) {
          const key = peek();
          if (key.k !== "id") throw new Error(`expected argument name in noise expression: ${src}`);
          p++;
          expect("=");
          named[key.v] = binary(1);
          if (isOp(",")) p++;
        }
        expect("}");
        return { t: "call", name: t.v, pos: null, named };
      }
      return { t: "id", name: t.v };
    }
    if (isOp("(")) {
      p++;
      const inner = binary(1);
      expect(")");
      return inner;
    }
    throw new Error(`unexpected token ${JSON.stringify(t)} in noise expression: ${src}`);
  }

  const ast = binary(1);
  if (peek().k !== "end") throw new Error(`trailing input in noise expression: ${src}`);
  return ast;
}
