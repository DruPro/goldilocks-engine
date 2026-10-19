// Planner: EVPPI for every node, in dollars, and the next action.
//
//   U(x, Θ) = -horizon · spend(x, Θ) - miss_penalty · 1(x out of zone)
//   EVPPI(n) = E_{θn}[ max_x E[U | θn] ] - max_x E[U]
//
// estimated by binning the particles into weighted-quantile bins of θn. The binning
// estimator is biased upwards (a max over noisy bin means), so the same estimate is
// computed with particles assigned to bins at random (true EVPPI 0) and that null
// level is subtracted. Score = EVPPI / cost; MEASURE if observable, else EXPAND.

import { quantileBins, wvar } from "../core/stats.ts";
import type { Streams } from "../core/rng.ts";
import type { Model } from "../model/tree.ts";
import type { Config } from "../model/types.ts";
import type { CompiledPool, Evaluation } from "./evaluator.ts";
import { goldilocks } from "./selector.ts";
import type { Particles } from "./updater.ts";

export interface NodeValue {
  node: string;
  evppi_raw: number;
  evppi_null: number;
  evppi: number;
  action: "measure" | "expand" | null;
  cost: number | null;
  score: number;
}

export interface Plan {
  baseline: number; // max_x E[U], USD
  best_eu: string; // candidate maximising expected utility
  values: NodeValue[]; // sorted by score, then evppi, then id
  next: { action: "measure" | "expand"; node: string; score: number } | null;
  max_score: number;
}

export function utility(ev: Evaluation, cfg: Config): Float64Array {
  const U = new Float64Array(ev.C * ev.N);
  const H = cfg.utility.horizon_months;
  const L = cfg.utility.miss_penalty_usd;
  for (let i = 0; i < U.length; i++) U[i] = -H * ev.cost[i] - L * (1 - ev.zone[i]);
  return U;
}

function binnedMax(Uw: Float64Array, C: number, N: number, bins: Int32Array, B: number): number {
  const S = new Float64Array(B * C);
  for (let c = 0; c < C; c++) {
    const off = c * N;
    for (let p = 0; p < N; p++) S[bins[p] * C + c] += Uw[off + p];
  }
  let total = 0;
  for (let b = 0; b < B; b++) {
    let m = -Infinity;
    for (let c = 0; c < C; c++) if (S[b * C + c] > m) m = S[b * C + c];
    total += m;
  }
  return total;
}

export function plan(model: Model, parts: Particles, ev: Evaluation, pool: CompiledPool, cfg: Config, streams: Streams, iter: number): Plan {
  const { C, N } = ev;
  const w = parts.w;
  const U = utility(ev, cfg);
  const Uw = new Float64Array(C * N);
  let baseline = -Infinity;
  let bestC = 0;
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (let p = 0; p < N; p++) {
      Uw[c * N + p] = w[p] * U[c * N + p];
      s += Uw[c * N + p];
    }
    if (s > baseline) {
      baseline = s;
      bestC = c;
    }
  }
  const B = cfg.evppi.bins;
  // Null level: the same estimator with particles binned at random. It depends on the
  // bin structure and the weights, not on the node, so it is computed once.
  let nullLevel = 0;
  if (cfg.evppi.null_permutations > 0) {
    const rng = streams.get(`planner/iter=${iter}/null`);
    const keys = new Float64Array(N);
    for (let k = 0; k < cfg.evppi.null_permutations; k++) {
      for (let p = 0; p < N; p++) keys[p] = rng.next();
      nullLevel += binnedMax(Uw, C, N, quantileBins(keys, w, B), B) - baseline;
    }
    nullLevel /= cfg.evppi.null_permutations;
  }
  const values: NodeValue[] = [];
  const x = new Float64Array(N);
  for (const n of model.nodes) {
    for (let p = 0; p < N; p++) x[p] = parts.vals[p * model.nV + n.index];
    const constant = !(wvar(x, w) > 1e-24);
    const raw = constant ? 0 : binnedMax(Uw, C, N, quantileBins(x, w, B), B) - baseline;
    const nul = constant ? 0 : nullLevel;
    // Differences below 1e-9 of the baseline are summation rounding, not information.
    const tol = 1e-9 * Math.max(1, Math.abs(baseline));
    const evppi = raw - nul > tol ? raw - nul : 0;
    let action: NodeValue["action"] = null;
    let cost: number | null = null;
    if (n.spec.observable) {
      action = "measure";
      cost = n.spec.measure_cost!;
    } else if (model.expandable.has(n.id)) {
      action = "expand";
      cost = cfg.expand_cost_usd;
    }
    const score = action && cost! > 0 ? evppi / cost! : 0;
    values.push({ node: n.id, evppi_raw: raw, evppi_null: nul, evppi, action, cost, score });
  }
  values.sort((a, b) => b.score - a.score || b.evppi - a.evppi || (a.node < b.node ? -1 : 1));
  const top = values.find((v) => v.action !== null && v.score > 0) ?? null;
  return {
    baseline,
    best_eu: pool.cands[bestC].id,
    values,
    next: top ? { action: top.action!, node: top.node, score: top.score } : null,
    max_score: top ? top.score : 0,
  };
}

export interface Flip {
  node: string;
  lo: number;
  hi: number;
  mass: number;
  pick: string | null; // the Goldilocks pick if θn were known to lie in [lo, hi]
}

/** "What would flip the recommendation": conditional Goldilocks picks per bin of θn. */
export function flips(model: Model, parts: Particles, ev: Evaluation, pool: CompiledPool, cfg: Config, node: string, currentPick: string | null, B = 5): Flip[] {
  const { C, N } = ev;
  const idx = model.node(node).index;
  const x = new Float64Array(N);
  for (let p = 0; p < N; p++) x[p] = parts.vals[p * model.nV + idx];
  const bins = quantileBins(x, parts.w, B);
  const out: Flip[] = [];
  for (let b = 0; b < B; b++) {
    let wb = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const P = new Float64Array(C);
    const cm = new Float64Array(C);
    for (let p = 0; p < N; p++) {
      if (bins[p] !== b) continue;
      wb += parts.w[p];
      lo = Math.min(lo, x[p]);
      hi = Math.max(hi, x[p]);
      for (let c = 0; c < C; c++) {
        P[c] += parts.w[p] * ev.zone[c * N + p];
        cm[c] += parts.w[p] * ev.cost[c * N + p];
      }
    }
    if (wb === 0) continue;
    for (let c = 0; c < C; c++) {
      P[c] /= wb;
      cm[c] /= wb;
    }
    const g = goldilocks(P, cm, cfg.tau, cfg.epsilon);
    const pick = g.recommended.length ? pool.cands[g.recommended[0]].id : null;
    if (pick !== currentPick) out.push({ node, lo, hi, mass: wb, pick });
  }
  return out;
}
