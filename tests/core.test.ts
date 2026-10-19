import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exp, log, pow } from "../src/core/fmath.ts";
import { Rng, Streams, hash32 } from "../src/core/rng.ts";
import { compile, ExprError, freeVars, parse } from "../src/core/expr.ts";
import { canonicalJson, hashValue } from "../src/io/canon.ts";
import { jaccard, quantileBins, wquantiles, wilson } from "../src/core/stats.ts";
import { symmetricEigen } from "../src/core/linalg.ts";

function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const dv = new DataView(new ArrayBuffer(16));
  dv.setFloat64(0, a);
  dv.setFloat64(8, b);
  return Number(dv.getBigInt64(0) - dv.getBigInt64(8));
}

describe("fmath", () => {
  test("exp and log stay within 1 ulp of the engine across a wide range", () => {
    const rng = new Rng(7);
    let worst = 0;
    for (let i = 0; i < 200000; i++) {
      const x = (rng.next() - 0.5) * 1400;
      worst = Math.max(worst, Math.abs(ulps(exp(x), Math.exp(x))));
      const y = exp((rng.next() - 0.5) * 1400);
      if (y > 0 && Number.isFinite(y)) worst = Math.max(worst, Math.abs(ulps(log(y), Math.log(y))));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
  test("special values", () => {
    expect(exp(0)).toBe(1);
    expect(exp(-Infinity)).toBe(0);
    expect(exp(Infinity)).toBe(Infinity);
    expect(exp(800)).toBe(Infinity);
    expect(Number.isNaN(exp(NaN))).toBe(true);
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(-Infinity);
    expect(Number.isNaN(log(-1))).toBe(true);
    expect(log(Infinity)).toBe(Infinity);
    expect(Math.abs(log(5e-324) - Math.log(5e-324))).toBeLessThan(1e-12);
    expect(pow(2, 10)).toBe(1024);
    expect(pow(2, -2)).toBe(0.25);
    expect(Math.abs(pow(2, 0.5) - Math.SQRT2)).toBeLessThan(1e-15);
  });
});

describe("rng", () => {
  test("streams are reproducible and independent", () => {
    const a = new Streams(42).get("prior");
    const b = new Streams(42).get("prior");
    const c = new Streams(42).get("update/iter=1");
    const xa = Array.from({ length: 5 }, () => a.next());
    const xb = Array.from({ length: 5 }, () => b.next());
    const xc = Array.from({ length: 5 }, () => c.next());
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
    expect(hash32("abc")).toBe(hash32("abc"));
  });
  test("uniform and normal moments", () => {
    const r = new Streams(1).get("moments");
    let s = 0, s2 = 0, n = 200000;
    for (let i = 0; i < n; i++) {
      const z = r.normal();
      s += z;
      s2 += z * z;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.01);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.02);
  });
  test("no Math.random anywhere in src", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(import.meta.dir, "../src"));
    const offenders = files.filter((f) => /Math\.random\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("expr", () => {
  const vars: Record<string, number> = { a: 2, b: 3, "store.read_ms": 4, "read_ms@kv_log": 5 };
  const ev = (s: string) =>
    compile<null>(s, (n) => {
      if (!(n in vars)) throw new Error(`unknown ${n}`);
      const v = vars[n];
      return () => v;
    })(null);
  test("precedence and functions", () => {
    expect(ev("a + b * 2")).toBe(8);
    expect(ev("-a ^ 2")).toBe(-4);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("min(a, b, 1) + max(a, b)")).toBe(4);
    expect(ev("a < b ? store.read_ms : 0")).toBe(4);
    expect(ev("if(a > b, 1, read_ms@kv_log)")).toBe(5);
    expect(ev("clamp(a * 10, 0, 7) % 4")).toBe(3);
    expect(ev("!(a == 2) || b != 3")).toBe(0);
    expect(ev("1.5e2 / .5")).toBe(300);
  });
  test("rejects bad input", () => {
    expect(() => parse("a +")).toThrow(ExprError);
    expect(() => parse("eval(a)")).toThrow(/unknown function/);
    expect(() => parse("a; b")).toThrow(ExprError);
    expect(() => parse("constructor.constructor('x')()")).toThrow(ExprError);
    expect(() => ev("zz + 1")).toThrow(/unknown zz/);
    expect(() => parse("(".repeat(300) + "1" + ")".repeat(300))).toThrow(/deeply/);
  });
  test("free variables", () => {
    expect(freeVars(parse("a + store.read_ms * min(a, read_ms@kv_log)"))).toEqual(["a", "read_ms@kv_log", "store.read_ms"]);
  });
});

describe("canon, stats, linalg", () => {
  test("canonical json sorts keys and rejects non-finite numbers", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: -0, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":0}],"b":1}');
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/);
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });
  test("weighted quantiles, bins, jaccard, wilson", () => {
    const x = [5, 1, 3, 2, 4];
    const w = [1, 1, 1, 1, 1];
    expect(wquantiles(x, w, [0, 0.5, 1])).toEqual([1, 3, 5]);
    const bins = quantileBins([1, 2, 3, 4], [1, 1, 1, 1], 2);
    expect(Array.from(bins)).toEqual([0, 0, 1, 1]);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 12);
    const [lo, hi] = wilson(0.9, 400);
    expect(lo).toBeLessThan(0.9);
    expect(hi).toBeGreaterThan(0.9);
  });
  test("jacobi eigen recovers a known spectrum", () => {
    const { values, vectors } = symmetricEigen([[2, 1], [1, 2]]);
    expect(values[0]).toBeCloseTo(3, 10);
    expect(values[1]).toBeCloseTo(1, 10);
    expect(Math.abs(vectors[0][0])).toBeCloseTo(Math.SQRT1_2, 10);
  });
});
