// Selection: the Goldilocks set, root relaxations, upward evidence and the
// sensitivity of the answer to llm_guess priors. Everything here is code; nothing
// an LLM writes can reorder these results.

import { exp } from "../core/fmath.ts";
import { ess, quantileBins, jaccard } from "../core/stats.ts";
import type { Model } from "../model/tree.ts";
import type { Config } from "../model/types.ts";
import { zoneWithDelta, type CompiledPool, type Evaluation } from "./evaluator.ts";
import type { Particles } from "./updater.ts";

export interface Goldilocks {
  qualified: number[];
  G: number[];
  cheapestCost: number | null;
  recommended: number[];
}

/** Order: cost ascending, then P descending, then candidate index. */
function byCost(P: ArrayLike<number>, cost: ArrayLike<number>) {
  return (a: number, b: number) => cost[a] - cost[b] || P[b] - P[a] || a - b;
}

export function goldilocks(P: ArrayLike<number>, cost: ArrayLike<number>, tau: number, eps: number): Goldilocks {
  const qualified: number[] = [];
  for (let c = 0; c < P.length; c++) if (P[c] >= tau) qualified.push(c);
  qualified.sort(byCost(P, cost));
  if (qualified.length === 0) return { qualified, G: [], cheapestCost: null, recommended: [] };
  const cheapest = cost[qualified[0]];
  const G = qualified.filter((c) => cost[c] <= (1 + eps) * cheapest);
  return { qualified, G, cheapestCost: cheapest, recommended: G.slice(0, 3) };
}

function pWithDelta(ev: Evaluation, pool: CompiledPool, w: Float64Array, delta: Float64Array, cfg: Config): Float64Array {
  const out = new Float64Array(ev.C);
  const z = new Uint8Array(ev.N);
  for (let c = 0; c < ev.C; c++) {
    zoneWithDelta(ev, pool, delta, cfg, c, z);
    let s = 0;
    for (let p = 0; p < ev.N; p++) s += w[p] * z[p];
    out[c] = s;
  }
  return out;
}

export interface Relaxation {
  root: string;
  binding: boolean;
  step: number; // relaxation tried, in slack units
  step_metric: number; // the same step in the root's own unit
  admits: string[]; // candidates newly qualified by the step
  cheapest_after: number | null;
  restore_delta: number | null; // smallest single-root relaxation that makes G non-empty (only when G is empty)
  restore_metric: number | null;
}

export interface RelaxationReport {
  relaxations: Relaxation[];
  conflicts: [string, string][];
}

export function relaxations(ev: Evaluation, pool: CompiledPool, w: Float64Array, cfg: Config, gl: Goldilocks, step = 0.25): RelaxationReport {
  const R = pool.roots.length;
  const nonEmpty = (d: Float64Array) => goldilocks(pWithDelta(ev, pool, w, d, cfg), ev.costMean, cfg.tau, cfg.epsilon).G.length > 0;
  const qualifiedBefore = new Set(gl.qualified);
  const out: Relaxation[] = [];
  for (let i = 0; i < R; i++) {
    const d = new Float64Array(R);
    d[i] = step;
    const g2 = goldilocks(pWithDelta(ev, pool, w, d, cfg), ev.costMean, cfg.tau, cfg.epsilon);
    const admits = g2.qualified.filter((c) => !qualifiedBefore.has(c)).map((c) => pool.cands[c].id);
    let restore: number | null = null;
    if (gl.G.length === 0) {
      const big = new Float64Array(R);
      big[i] = 3;
      if (nonEmpty(big)) {
        let lo = 0;
        let hi = 3;
        for (let it = 0; it < 12; it++) {
          const mid = (lo + hi) / 2;
          const dm = new Float64Array(R);
          dm[i] = mid;
          if (nonEmpty(dm)) hi = mid;
          else lo = mid;
        }
        restore = hi;
      }
    }
    const cheaper = g2.cheapestCost !== null && (gl.cheapestCost === null || g2.cheapestCost < gl.cheapestCost * (1 - 1e-9));
    out.push({
      root: pool.roots[i].id,
      binding: cheaper || restore !== null,
      step,
      step_metric: step * pool.scales[i],
      admits,
      cheapest_after: g2.cheapestCost,
      restore_delta: restore,
      restore_metric: restore === null ? null : restore * pool.scales[i],
    });
  }
  const conflicts: [string, string][] = [];
  if (gl.G.length === 0 && out.every((r) => r.restore_delta === null)) {
    for (let i = 0; i < R; i++)
      for (let j = i + 1; j < R; j++) {
        const d = new Float64Array(R);
        d[i] = 3;
        d[j] = 3;
        if (nonEmpty(d)) conflicts.push([pool.roots[i].id, pool.roots[j].id]);
      }
  }
  return { relaxations: out, conflicts };
}

export interface UpwardFlag {
  root: string;
  best_p: number; // max over candidates of P(root satisfied)
  at_risk: boolean;
  culprits: { node: string; mass_outside: number; implied_lo: number | null; implied_hi: number | null }[];
  restore_delta: number | null;
}

/**
 * Upward evidence: a root is at risk when no candidate satisfies it alone with
 * probability ≥ τ. For each node its metric reads, the "implied range" is the set of
 * node values (weighted-quantile bins) under which some candidate still satisfies the
 * root with probability ≥ τ; posterior mass outside that range points at the culprit.
 */
export function upwardEvidence(ev: Evaluation, pool: CompiledPool, model: Model, parts: Particles, cfg: Config, bins = 10): UpwardFlag[] {
  const { C, R, N } = ev;
  const w = parts.w;
  const out: UpwardFlag[] = [];
  for (let i = 0; i < R; i++) {
    const ok = (c: number, p: number, d = 0) => ev.raw[(c * R + i) * N + p] + d >= 0;
    const bestP = (d: number) => {
      let best = 0;
      for (let c = 0; c < C; c++) {
        let s = 0;
        for (let p = 0; p < N; p++) if (ok(c, p, d)) s += w[p];
        if (s > best) best = s;
      }
      return best;
    };
    const b0 = bestP(0);
    const flag: UpwardFlag = { root: pool.roots[i].id, best_p: b0, at_risk: b0 < cfg.tau, culprits: [], restore_delta: null };
    if (flag.at_risk) {
      for (const id of [...pool.refs.get(pool.roots[i].id)!].sort()) {
        const idx = model.node(id).index;
        const x = new Float64Array(N);
        for (let p = 0; p < N; p++) x[p] = parts.vals[p * model.nV + idx];
        const bin = quantileBins(x, w, bins);
        const wb = new Float64Array(bins);
        const sat = new Float64Array(bins * C);
        for (let p = 0; p < N; p++) {
          wb[bin[p]] += w[p];
          for (let c = 0; c < C; c++) if (ok(c, p)) sat[bin[p] * C + c] += w[p];
        }
        let outside = 0;
        let lo: number | null = null;
        let hi: number | null = null;
        for (let b = 0; b < bins; b++) {
          let best = 0;
          for (let c = 0; c < C; c++) best = Math.max(best, wb[b] > 0 ? sat[b * C + c] / wb[b] : 0);
          if (best < cfg.tau) outside += wb[b];
          else
            for (let p = 0; p < N; p++)
              if (bin[p] === b) {
                lo = lo === null ? x[p] : Math.min(lo, x[p]);
                hi = hi === null ? x[p] : Math.max(hi, x[p]);
              }
        }
        flag.culprits.push({ node: id, mass_outside: outside, implied_lo: lo, implied_hi: hi });
      }
      flag.culprits.sort((a, b) => b.mass_outside - a.mass_outside || (a.node < b.node ? -1 : 1));
      flag.culprits = flag.culprits.slice(0, 3);
      if (bestP(3) >= cfg.tau) {
        let lo = 0;
        let hi = 3;
        for (let it = 0; it < 12; it++) {
          const mid = (lo + hi) / 2;
          if (bestP(mid) >= cfg.tau) hi = mid;
          else lo = mid;
        }
        flag.restore_delta = hi;
      }
    }
    out.push(flag);
  }
  return out;
}

export interface SensitivityCase {
  scenario: string;
  ess: number;
  recommended: string[];
  G: string[];
  jaccard_vs_base: number;
  p_of_base_pick: number | null;
}

/**
 * How much the answer leans on llm_guess priors: reweight the posterior particles by
 * alternative/current prior density on the base variables of llm_guess nodes
 * (exact importance reweighting, no re-run), then redo the selection.
 */
export function priorSensitivity(ev: Evaluation, pool: CompiledPool, model: Model, parts: Particles, cfg: Config, base: Goldilocks): { nodes: string[]; cases: SensitivityCase[] } {
  const guess = model.nodes.filter((n) => n.spec.source === "llm_guess" && n.base >= 0);
  const scenarios: [string, (kind: string, b: number) => number][] = [
    ["llm_guess priors 1.5x wider", (k, b) => (k === "z" ? exp(-(b * b) / 4.5 + (b * b) / 2) / 1.5 : 1)],
    ["llm_guess priors shifted up", (k, b) => (k === "z" ? exp(0.5 * b - 0.125) : 2 * b)],
    ["llm_guess priors shifted down", (k, b) => (k === "z" ? exp(-0.5 * b - 0.125) : 2 * (1 - b))],
  ];
  const baseIds = base.G.map((c) => pool.cands[c].id);
  const cases: SensitivityCase[] = [];
  for (const [name, ratio] of scenarios) {
    const w2 = new Float64Array(parts.N);
    let s = 0;
    for (let p = 0; p < parts.N; p++) {
      let r = parts.w[p];
      for (const n of guess) r *= ratio(n.baseKind, parts.base[p * model.nB + n.base]);
      w2[p] = r;
      s += r;
    }
    for (let p = 0; p < parts.N; p++) w2[p] /= s;
    const P = new Float64Array(ev.C);
    const cm = new Float64Array(ev.C);
    for (let c = 0; c < ev.C; c++)
      for (let p = 0; p < ev.N; p++) {
        P[c] += w2[p] * ev.zone[c * ev.N + p];
        cm[c] += w2[p] * ev.cost[c * ev.N + p];
      }
    const g = goldilocks(P, cm, cfg.tau, cfg.epsilon);
    const G = g.G.map((c) => pool.cands[c].id);
    cases.push({
      scenario: name,
      ess: ess(w2),
      recommended: g.recommended.map((c) => pool.cands[c].id),
      G,
      jaccard_vs_base: jaccard(G, baseIds),
      p_of_base_pick: base.recommended.length ? P[base.recommended[0]] : null,
    });
  }
  return { nodes: guess.map((n) => n.id), cases };
}
