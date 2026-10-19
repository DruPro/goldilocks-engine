// Evaluator: candidates × particles → raw slacks, soft-min fitness f, zone
// membership and cost. Root metrics are compiled once per candidate into closures
// that read node values straight out of the particle matrix.
//
//   slack (two-sided band)  s = min(g - L, U - g) / ((U - L) / 2)
//   slack (one-sided upper) s = (U - g) / (U - target)      → 1 at target, 0 at bound
//   slack (one-sided lower) s = (g - L) / (target - L)
//   s is clipped to [-3, 1];  f = -(1/β) ln Σ w_i exp(-β s_i)
//   zone: f ≥ 0  (zone_rule "softmin_and_all" also requires every s_i ≥ 0)

import { compile, freeVars, parse, type Getter } from "../core/expr.ts";
import { exp, log } from "../core/fmath.ts";
import { ess } from "../core/stats.ts";
import type { Model } from "../model/tree.ts";
import type { Candidate, Config, Root } from "../model/types.ts";

export interface MCtx {
  v: Float64Array;
  o: number;
}

export interface CompiledPool {
  cands: Candidate[];
  roots: Root[];
  weights: number[];
  scales: number[];
  metrics: Getter<MCtx>[][]; // [candidate][root]; closures are shared within a group
  /** Per root: one getter per distinct combination of the picks it reads, and each candidate's group. */
  groups: { getters: Getter<MCtx>[]; of: Int32Array; constant: boolean }[];
  spendRoot: number;
  /** Node ids each root's metric can read, over all candidates. */
  refs: Map<string, Set<string>>;
}

export function rootScale(r: Root): number {
  if (r.sense === "upper") {
    if (r.upper === undefined || !(r.upper > r.target)) throw new Error(`root ${r.id}: upper roots need upper > target`);
    return r.upper - r.target;
  }
  if (r.sense === "lower") {
    if (r.lower === undefined || !(r.target > r.lower)) throw new Error(`root ${r.id}: lower roots need target > lower`);
    return r.target - r.lower;
  }
  if (r.lower === undefined || r.upper === undefined || !(r.upper > r.lower)) throw new Error(`root ${r.id}: band roots need lower < upper`);
  if (r.target < r.lower || r.target > r.upper) throw new Error(`root ${r.id}: target must sit inside the band`);
  return (r.upper - r.lower) / 2;
}

export function rawSlack(r: Root, scale: number, g: number): number {
  if (r.sense === "upper") return (r.upper! - g) / scale;
  if (r.sense === "lower") return (g - r.lower!) / scale;
  return Math.min(g - r.lower!, r.upper! - g) / scale;
}

export const clip = (s: number) => (s < -3 ? -3 : s > 1 ? 1 : s);

/** Soft-min of clipped slacks, computed stably around the minimum. */
export function softmin(s: ArrayLike<number>, w: ArrayLike<number>, beta: number): number {
  let m = Infinity;
  for (let i = 0; i < s.length; i++) if (s[i] < m) m = s[i];
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc += w[i] * exp(-beta * (s[i] - m));
  return m - log(acc) / beta;
}

export function compilePool(model: Model, roots: Root[], cands: Candidate[], cfg: Config): CompiledPool {
  const wsum = roots.reduce((a, r) => a + r.weight, 0);
  if (Math.abs(wsum - 1) > 1e-9) throw new Error(`root weights must sum to 1 (they sum to ${wsum})`);
  const spendRoot = roots.findIndex((r) => r.id === cfg.utility.spend_root);
  if (spendRoot < 0) throw new Error(`utility.spend_root ${cfg.utility.spend_root} is not a root`);
  const scales = roots.map(rootScale);
  const refs = new Map(roots.map((r) => [r.id, new Set<string>()]));
  const asts = roots.map((r) => parse(r.metric));
  const nodeGetter = (id: string): Getter<MCtx> => {
    const i = model.node(id).index;
    return (c) => c.v[c.o + i];
  };
  // Candidates that agree on every dimension a root reads share one compiled metric.
  const dimsOf = asts.map((a) => [...new Set(freeVars(a).filter((v) => v.includes(".") && !v.includes("@")).map((v) => v.slice(0, v.indexOf("."))))].sort());
  const compileFor = (cand: Candidate, r: Root, ri: number) =>
      compile<MCtx>(r.metric, (name) => {
        if (model.byId.has(name)) {
          refs.get(r.id)!.add(name);
          return nodeGetter(name);
        }
        const dot = name.indexOf(".");
        if (dot > 0 && !name.includes("@")) {
          const dim = name.slice(0, dot);
          const attr = name.slice(dot + 1);
          const opt = cand.picks[dim];
          if (opt === undefined) throw new Error(`root ${r.id}: unknown dimension "${dim}" in ${name}`);
          const fx = model.fixedAttrs.get(`${opt}.${attr}`);
          if (fx) {
            const v = fx.value;
            return () => v;
          }
          const nid = `${attr}@${opt}`;
          if (model.byId.has(nid)) {
            refs.get(r.id)!.add(nid);
            return nodeGetter(nid);
          }
          throw new Error(`root ${r.id}: option ${opt} has no attribute ${attr}`);
        }
        throw new Error(`root ${r.id}: unknown name "${name}" (metric vars: ${freeVars(asts[ri]).join(", ")})`);
      });
  const groups = roots.map((r, ri) => {
    const keys = new Map<string, number>();
    const getters: Getter<MCtx>[] = [];
    const of = new Int32Array(cands.length);
    cands.forEach((cand, c) => {
      const key = dimsOf[ri].map((d) => cand.picks[d]).join("|");
      let g = keys.get(key);
      if (g === undefined) {
        g = getters.length;
        keys.set(key, g);
        getters.push(compileFor(cand, r, ri));
      }
      of[c] = g;
    });
    return { getters, of, constant: refs.get(r.id)!.size === 0 };
  });
  const metrics = cands.map((_, c) => roots.map((_, ri) => groups[ri].getters[groups[ri].of[c]]));
  return { cands, roots, weights: roots.map((r) => r.weight), scales, metrics, groups, spendRoot, refs };
}

/**
 * Zone membership without computing f when the answer is already decided:
 * f ≥ min_i s_i (so all s_i ≥ 0 ⇒ in zone) and f ≤ Σ w_i s_i (Jensen, so a negative
 * weighted mean ⇒ out of zone). Otherwise the soft-min is evaluated exactly.
 */
export function inZone(s: Float64Array, w: number[], beta: number, rule: Config["zone_rule"], minS: number): boolean {
  if (minS >= 0) return true;
  if (rule === "softmin_and_all") return false;
  let mean = 0;
  for (let i = 0; i < s.length; i++) mean += w[i] * s[i];
  if (mean < 0) return false;
  return softmin(s, w, beta) >= 0;
}

export interface Evaluation {
  C: number;
  R: number;
  N: number;
  raw: Float64Array; // [(c * R + i) * N + p] raw slack
  zone: Uint8Array; // [c * N + p]
  cost: Float64Array; // [c * N + p] spend metric
  P: Float64Array; // weighted P(in zone) per candidate
  costMean: Float64Array;
  binding: Int32Array; // root index that is most often the minimum slack
  ess: number;
}

export function evaluate(pool: CompiledPool, vals: Float64Array, nV: number, w: Float64Array, cfg: Config): Evaluation {
  const C = pool.cands.length;
  const R = pool.roots.length;
  const N = w.length;
  const ctx: MCtx = { v: vals, o: 0 };
  // Stage 1: raw slack of every root for every distinct pick combination it reads.
  const groupRaw: Float64Array[] = [];
  let spendVals = new Float64Array(0);
  pool.groups.forEach((grp, i) => {
    const r = pool.roots[i];
    const buf = new Float64Array(grp.getters.length * N);
    const keep = i === pool.spendRoot ? new Float64Array(grp.getters.length * N) : null;
    grp.getters.forEach((get, g) => {
      const span = grp.constant ? 1 : N;
      for (let p = 0; p < span; p++) {
        ctx.o = p * nV;
        const v = get(ctx);
        if (!Number.isFinite(v)) throw new Error(`metric ${r.id} is not finite (group ${g}, particle ${p})`);
        buf[g * N + p] = rawSlack(r, pool.scales[i], v);
        if (keep) keep[g * N + p] = v;
      }
      if (grp.constant) {
        buf.fill(buf[g * N], g * N + 1, (g + 1) * N);
        if (keep) keep.fill(keep[g * N], g * N + 1, (g + 1) * N);
      }
    });
    groupRaw.push(buf);
    if (keep) spendVals = keep;
  });
  // Stage 2: per candidate, assemble slacks, decide zone membership, accumulate.
  const raw = new Float64Array(C * R * N);
  const zone = new Uint8Array(C * N);
  const cost = new Float64Array(C * N);
  const P = new Float64Array(C);
  const costMean = new Float64Array(C);
  const binding = new Int32Array(C);
  const s = new Float64Array(R);
  const argminW = new Float64Array(R);
  const spendGroup = pool.groups[pool.spendRoot].of;
  for (let c = 0; c < C; c++) {
    argminW.fill(0);
    const offs = pool.groups.map((grp) => grp.of[c] * N);
    const so = spendGroup[c] * N;
    let pz = 0;
    let cm = 0;
    for (let p = 0; p < N; p++) {
      let minS = Infinity;
      let arg = 0;
      for (let i = 0; i < R; i++) {
        const rs = groupRaw[i][offs[i] + p];
        raw[(c * R + i) * N + p] = rs;
        s[i] = clip(rs);
        if (s[i] < minS) {
          minS = s[i];
          arg = i;
        }
      }
      const z = inZone(s, pool.weights, cfg.beta, cfg.zone_rule, minS) ? 1 : 0;
      zone[c * N + p] = z;
      const k = spendVals[so + p];
      cost[c * N + p] = k;
      pz += w[p] * z;
      cm += w[p] * k;
      argminW[arg] += w[p];
    }
    P[c] = pz;
    costMean[c] = cm;
    let b = 0;
    for (let i = 1; i < R; i++) if (argminW[i] > argminW[b]) b = i;
    binding[c] = b;
  }
  return { C, R, N, raw, zone, cost, P, costMean, binding, ess: ess(w) };
}

/** Zone indicators after shifting the raw slacks of some roots by delta (relaxation). */
export function zoneWithDelta(ev: Evaluation, pool: CompiledPool, delta: Float64Array, cfg: Config, c: number, out: Uint8Array): void {
  const { R, N } = ev;
  const s = new Float64Array(R);
  for (let p = 0; p < N; p++) {
    let minS = Infinity;
    for (let i = 0; i < R; i++) {
      s[i] = clip(ev.raw[(c * R + i) * N + p] + delta[i]);
      if (s[i] < minS) minS = s[i];
    }
    out[p] = inZone(s, pool.weights, cfg.beta, cfg.zone_rule, minS) ? 1 : 0;
  }
}
