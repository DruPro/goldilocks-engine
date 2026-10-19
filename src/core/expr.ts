// Safe formula evaluator. Formulas are parsed into an AST and compiled into closures;
// nothing is ever passed to eval() or new Function(). Identifiers are resolved at
// compile time by a caller-supplied resolver, so an unknown name is a compile error,
// not a runtime surprise. Booleans are numbers (1 = true, 0 = false).
//
// Grammar (lowest to highest precedence):
//   ternary: or ("?" ternary ":" ternary)?
//   or: and ("||" and)*      and: cmp ("&&" cmp)*
//   cmp: add (("<"|"<="|">"|">="|"=="|"!=") add)?
//   add: mul (("+"|"-") mul)*  mul: unary (("*"|"/"|"%") unary)*
//   unary: ("-"|"+"|"!") unary | power     power: primary ("^" unary)?
//   primary: number | name | name "(" args ")" | "(" ternary ")"
//   name: segment (("."|"@") segment)*   e.g. peak_tps, store.read_ms, read_ms@kv_log

import { exp as fexp, log as flog, pow as fpow } from "./fmath.ts";

export type Ast =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "un"; op: "-" | "+" | "!"; a: Ast }
  | { t: "bin"; op: string; a: Ast; b: Ast }
  | { t: "cond"; c: Ast; a: Ast; b: Ast }
  | { t: "call"; fn: string; args: Ast[] };

export class ExprError extends Error {
  constructor(msg: string, readonly src: string, readonly pos: number) {
    super(`${msg} at position ${pos} in "${src}"`);
  }
}

type Tok = { k: "num" | "name" | "op" | "end"; v: string; pos: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "<", ">", "!", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError("bad number", src, i);
      out.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:[.@][A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
      out.push({ k: "name", v: m![0], pos: i });
      i += m![0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character '${c}'`, src, i);
    out.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  out.push({ k: "end", v: "", pos: src.length });
  return out;
}

const FUNCS: Record<string, { arity: number | "variadic"; fn: (...a: number[]) => number }> = {
  min: { arity: "variadic", fn: (...a) => a.reduce((x, y) => (y < x ? y : x)) },
  max: { arity: "variadic", fn: (...a) => a.reduce((x, y) => (y > x ? y : x)) },
  abs: { arity: 1, fn: (x) => Math.abs(x) },
  sqrt: { arity: 1, fn: (x) => Math.sqrt(x) },
  exp: { arity: 1, fn: (x) => fexp(x) },
  log: { arity: 1, fn: (x) => flog(x) },
  pow: { arity: 2, fn: (x, y) => fpow(x, y) },
  floor: { arity: 1, fn: (x) => Math.floor(x) },
  ceil: { arity: 1, fn: (x) => Math.ceil(x) },
  clamp: { arity: 3, fn: (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x) },
  if: { arity: 3, fn: (c, a, b) => (c !== 0 ? a : b) },
};

export function parse(src: string): Ast {
  if (typeof src !== "string" || src.trim() === "") throw new ExprError("empty formula", String(src), 0);
  if (src.length > 2000) throw new ExprError("formula too long", src.slice(0, 40) + "…", 0);
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p].k === "op" && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected '${v}'`, src, toks[p].pos);
    p++;
  };
  const guard = () => {
    if (++depth > 200) throw new ExprError("formula nested too deeply", src, toks[p].pos);
  };

  function ternary(): Ast {
    guard();
    const c = or();
    if (isOp("?")) {
      p++;
      const a = ternary();
      expect(":");
      const b = ternary();
      depth--;
      return { t: "cond", c, a, b };
    }
    depth--;
    return c;
  }
  function or(): Ast {
    let a = and();
    while (isOp("||")) {
      p++;
      a = { t: "bin", op: "||", a, b: and() };
    }
    return a;
  }
  function and(): Ast {
    let a = cmp();
    while (isOp("&&")) {
      p++;
      a = { t: "bin", op: "&&", a, b: cmp() };
    }
    return a;
  }
  function cmp(): Ast {
    const a = add();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (isOp(op)) {
        p++;
        return { t: "bin", op, a, b: add() };
      }
    }
    return a;
  }
  function add(): Ast {
    let a = mul();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      a = { t: "bin", op, a, b: mul() };
    }
    return a;
  }
  function mul(): Ast {
    let a = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++].v;
      a = { t: "bin", op, a, b: unary() };
    }
    return a;
  }
  function unary(): Ast {
    if (isOp("-") || isOp("+") || isOp("!")) {
      guard();
      const op = toks[p++].v as "-" | "+" | "!";
      const a = unary();
      depth--;
      return { t: "un", op, a };
    }
    return power();
  }
  function power(): Ast {
    const a = primary();
    if (isOp("^")) {
      p++;
      return { t: "bin", op: "^", a, b: unary() };
    }
    return a;
  }
  function primary(): Ast {
    const tk = peek();
    if (tk.k === "num") {
      p++;
      const v = Number(tk.v);
      if (!Number.isFinite(v)) throw new ExprError("number out of range", src, tk.pos);
      return { t: "num", v };
    }
    if (tk.k === "name") {
      p++;
      if (isOp("(")) {
        const f = FUNCS[tk.v];
        if (!f) throw new ExprError(`unknown function '${tk.v}'`, src, tk.pos);
        p++;
        const args: Ast[] = [];
        if (!isOp(")")) {
          args.push(ternary());
          while (isOp(",")) {
            p++;
            args.push(ternary());
          }
        }
        expect(")");
        if (f.arity === "variadic" ? args.length < 1 : args.length !== f.arity)
          throw new ExprError(`wrong number of arguments to ${tk.v}`, src, tk.pos);
        return { t: "call", fn: tk.v, args };
      }
      return { t: "var", name: tk.v };
    }
    if (isOp("(")) {
      p++;
      const e = ternary();
      expect(")");
      return e;
    }
    throw new ExprError(tk.k === "end" ? "unexpected end of formula" : `unexpected '${tk.v}'`, src, tk.pos);
  }

  const ast = ternary();
  if (peek().k !== "end") throw new ExprError(`unexpected '${peek().v}'`, src, peek().pos);
  return ast;
}

export function freeVars(ast: Ast, acc = new Set<string>()): string[] {
  switch (ast.t) {
    case "var":
      acc.add(ast.name);
      break;
    case "un":
      freeVars(ast.a, acc);
      break;
    case "bin":
      freeVars(ast.a, acc);
      freeVars(ast.b, acc);
      break;
    case "cond":
      freeVars(ast.c, acc);
      freeVars(ast.a, acc);
      freeVars(ast.b, acc);
      break;
    case "call":
      for (const a of ast.args) freeVars(a, acc);
      break;
  }
  return [...acc].sort();
}

export type Getter<C> = (ctx: C) => number;
export type Resolver<C> = (name: string) => Getter<C>;

export function compileAst<C>(ast: Ast, resolve: Resolver<C>): Getter<C> {
  switch (ast.t) {
    case "num": {
      const v = ast.v;
      return () => v;
    }
    case "var":
      return resolve(ast.name);
    case "un": {
      const a = compileAst(ast.a, resolve);
      if (ast.op === "-") return (c) => -a(c);
      if (ast.op === "!") return (c) => (a(c) === 0 ? 1 : 0);
      return a;
    }
    case "cond": {
      const k = compileAst(ast.c, resolve);
      const a = compileAst(ast.a, resolve);
      const b = compileAst(ast.b, resolve);
      return (c) => (k(c) !== 0 ? a(c) : b(c));
    }
    case "call": {
      const args = ast.args.map((x) => compileAst(x, resolve));
      if (ast.fn === "if") {
        const [k, a, b] = args;
        return (c) => (k(c) !== 0 ? a(c) : b(c));
      }
      const f = FUNCS[ast.fn].fn;
      if (args.length === 1) {
        const [a] = args;
        return (c) => f(a(c));
      }
      if (args.length === 2) {
        const [a, b] = args;
        return (c) => f(a(c), b(c));
      }
      return (c) => f(...args.map((g) => g(c)));
    }
    case "bin": {
      const a = compileAst(ast.a, resolve);
      const b = compileAst(ast.b, resolve);
      switch (ast.op) {
        case "+": return (c) => a(c) + b(c);
        case "-": return (c) => a(c) - b(c);
        case "*": return (c) => a(c) * b(c);
        case "/": return (c) => a(c) / b(c);
        case "%": return (c) => a(c) % b(c);
        case "^": return (c) => fpow(a(c), b(c));
        case "<": return (c) => (a(c) < b(c) ? 1 : 0);
        case "<=": return (c) => (a(c) <= b(c) ? 1 : 0);
        case ">": return (c) => (a(c) > b(c) ? 1 : 0);
        case ">=": return (c) => (a(c) >= b(c) ? 1 : 0);
        case "==": return (c) => (a(c) === b(c) ? 1 : 0);
        case "!=": return (c) => (a(c) !== b(c) ? 1 : 0);
        case "&&": return (c) => (a(c) !== 0 && b(c) !== 0 ? 1 : 0);
        case "||": return (c) => (a(c) !== 0 || b(c) !== 0 ? 1 : 0);
      }
      throw new Error(`unknown operator ${ast.op}`);
    }
  }
}

export function compile<C>(src: string, resolve: Resolver<C>): Getter<C> {
  return compileAst(parse(src), resolve);
}
