// Updater: posterior ∝ likelihood × prior as importance reweighting of N particles.
// Each new piece of evidence is applied in tempered steps (likelihood^Δ), choosing
// each Δ so the effective sample size never falls below ess_fraction × N in one go.
// Whenever a step stops at that floor, the particles are resampled (systematic) and
// rejuvenated with Metropolis moves that target prior × all applied likelihoods.

import { baseLogPrior, logLik, reflectUnit, sampleBase, type LikelihoodType, type Observation } from "../core/dist.ts";
import { exp, log } from "../core/fmath.ts";
import type { Rng, Streams } from "../core/rng.ts";
import type { Model } from "../model/tree.ts";
import type { Config, Evidence } from "../model/types.ts";

export interface Particles {
  N: number;
  base: Float64Array; // [p * nB + j]
  vals: Float64Array; // [p * nV + i]
  logw: Float64Array; // normalised: sum(exp(logw)) = 1
  w: Float64Array;
}

export interface UpdateStep {
  lambda: number;
  ess: number;
  resampled: boolean;
  accept: number | null;
}

export interface UpdateReport {
  evidence: string;
  target: string;
  steps: UpdateStep[];
  ess_final: number;
}

export function drawPrior(model: Model, N: number, rng: Rng): Particles {
  const base = new Float64Array(N * model.nB);
  for (let p = 0; p < N; p++) for (const n of model.nodes) if (n.base >= 0) base[p * model.nB + n.base] = sampleBase(n.baseKind, rng);
  const vals = model.forwardAll(base, N);
  const logw = new Float64Array(N).fill(-log(N));
  const w = new Float64Array(N).fill(1 / N);
  return { N, base, vals, logw, w };
}

function normaliseLog(lw: Float64Array, w: Float64Array): void {
  let m = -Infinity;
  for (let i = 0; i < lw.length; i++) if (lw[i] > m) m = lw[i];
  if (m === -Infinity) throw new Error("every particle has zero weight: the evidence is incompatible with the prior");
  let s = 0;
  for (let i = 0; i < lw.length; i++) s += exp(lw[i] - m);
  const ls = m + log(s);
  for (let i = 0; i < lw.length; i++) {
    lw[i] -= ls;
    w[i] = exp(lw[i]);
  }
}

function essAfter(logw: Float64Array, ll: Float64Array, delta: number): number {
  let m = -Infinity;
  for (let i = 0; i < logw.length; i++) {
    const x = logw[i] + delta * ll[i];
    if (x > m) m = x;
  }
  if (m === -Infinity) return 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < logw.length; i++) {
    const e = exp(logw[i] + delta * ll[i] - m);
    s1 += e;
    s2 += e * e;
  }
  return (s1 * s1) / s2;
}

function systematicResample(parts: Particles, model: Model, rng: Rng): void {
  const { N, w } = parts;
  const u = rng.next() / N;
  const idx = new Int32Array(N);
  let c = w[0];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const pos = u + i / N;
    while (pos > c && j < N - 1) c += w[++j];
    idx[i] = j;
  }
  const nB = model.nB;
  const nV = model.nV;
  const base = new Float64Array(N * nB);
  const vals = new Float64Array(N * nV);
  for (let i = 0; i < N; i++) {
    base.set(parts.base.subarray(idx[i] * nB, idx[i] * nB + nB), i * nB);
    vals.set(parts.vals.subarray(idx[i] * nV, idx[i] * nV + nV), i * nV);
  }
  parts.base = base;
  parts.vals = vals;
  parts.logw.fill(-log(N));
  parts.w.fill(1 / N);
}

interface Term {
  type: LikelihoodType;
  obs: Observation;
  noise: number;
  index: number;
  scale: number; // tempering exponent (1 for fully applied evidence)
}

function termsLL(terms: Term[], vals: Float64Array, off: number): number {
  let s = 0;
  for (const t of terms) {
    if (t.scale === 0) continue;
    s += t.scale * logLik(t.type, t.obs, t.noise, vals[off + t.index]);
  }
  return s;
}

/** Base coordinates that can change at least one evidence target's value. */
function influencing(model: Model, targets: Set<number>): Uint8Array {
  const kids = new Map<string, string[]>();
  for (const n of model.nodes) for (const p of n.spec.parent_ids) kids.set(p, [...(kids.get(p) ?? []), n.id]);
  const out = new Uint8Array(model.nB);
  for (const n of model.nodes) {
    if (n.base < 0) continue;
    const stack = [n.id];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (targets.has(model.node(id).index)) {
        out[n.base] = 1;
        break;
      }
      for (const k of kids.get(id) ?? []) stack.push(k);
    }
  }
  return out;
}

/** Metropolis-within-Gibbs rejuvenation targeting prior × exp(sum of tempered terms). */
function move(parts: Particles, model: Model, terms: Term[], cfg: Config, rng: Rng): number {
  const { N } = parts;
  const nB = model.nB;
  const nV = model.nV;
  const infl = influencing(model, new Set(terms.map((t) => t.index)));
  const kinds = new Array(nB);
  for (const n of model.nodes) if (n.base >= 0) kinds[n.base] = n.baseKind;
  const scale = new Float64Array(nB);
  for (let j = 0; j < nB; j++) {
    let m = 0;
    let m2 = 0;
    for (let p = 0; p < N; p++) {
      const b = parts.base[p * nB + j];
      m += b;
      m2 += b * b;
    }
    const sd = Math.sqrt(Math.max(0, m2 / N - (m / N) * (m / N)));
    const floor = kinds[j] === "u" ? 0.005 : 0.02;
    const cap = kinds[j] === "u" ? 0.25 : 1;
    scale[j] = Math.min(cap, Math.max(floor, cfg.smc.step_scale * sd));
  }
  const prop = new Float64Array(nB);
  const pv = new Float64Array(nV);
  let tried = 0;
  let acc = 0;
  for (let p = 0; p < N; p++) {
    const bo = p * nB;
    const vo = p * nV;
    let llCur = termsLL(terms, parts.vals, vo);
    for (let step = 0; step < cfg.smc.move_steps; step++) {
      for (let j = 0; j < nB; j++) {
        prop.set(parts.base.subarray(bo, bo + nB));
        const cur = prop[j];
        if (!infl[j]) {
          prop[j] = sampleBase(kinds[j], rng); // exact Gibbs draw: no evidence depends on it
        } else {
          const cand = cur + scale[j] * rng.normal();
          prop[j] = kinds[j] === "u" ? reflectUnit(cand) : cand;
        }
        model.forward(prop, 0, pv, 0);
        const llNew = termsLL(terms, pv, 0);
        let accept = true;
        if (infl[j]) {
          tried++;
          const la = baseLogPrior(kinds[j], prop[j]) - baseLogPrior(kinds[j], cur) + (llNew - llCur);
          accept = la >= 0 || rng.next() < exp(la);
          if (accept) acc++;
        }
        if (accept) {
          parts.base[bo + j] = prop[j];
          parts.vals.set(pv, vo);
          llCur = llNew;
        }
      }
    }
  }
  return tried ? acc / tried : 1;
}

export function evidenceTerms(model: Model, evs: Evidence[]): Term[] {
  return evs.map((e) => ({ type: e.likelihood, obs: e.observation as Observation, noise: e.noise, index: model.node(e.target_node).index, scale: 1 }));
}

export function applyEvidence(model: Model, parts: Particles, applied: Evidence[], ev: Evidence, cfg: Config, streams: Streams, prefix: string): UpdateReport {
  if (!model.byId.has(ev.target_node)) throw new Error(`evidence ${ev.id} targets unknown node ${ev.target_node}`);
  const target = model.node(ev.target_node).index;
  const { N } = parts;
  const ll = new Float64Array(N);
  let anyFinite = false;
  for (let p = 0; p < N; p++) {
    ll[p] = logLik(ev.likelihood, ev.observation as Observation, ev.noise, parts.vals[p * model.nV + target]);
    if (ll[p] > -Infinity) anyFinite = true;
  }
  if (!anyFinite) throw new Error(`evidence ${ev.id} has zero likelihood under every particle`);
  const thr = cfg.smc.ess_fraction * N;
  const terms = evidenceTerms(model, applied);
  const newTerm: Term = { type: ev.likelihood, obs: ev.observation as Observation, noise: ev.noise, index: target, scale: 0 };
  const steps: UpdateStep[] = [];
  let lambda = 0;
  for (let k = 0; lambda < 1 && k < 200; k++) {
    let delta = 1 - lambda;
    if (essAfter(parts.logw, ll, delta) < thr) {
      let lo = 0;
      let hi = delta;
      for (let it = 0; it < 50; it++) {
        const mid = (lo + hi) / 2;
        if (essAfter(parts.logw, ll, mid) >= thr) lo = mid;
        else hi = mid;
      }
      delta = Math.max(lo, 1e-6);
    }
    for (let p = 0; p < N; p++) parts.logw[p] += delta * ll[p];
    normaliseLog(parts.logw, parts.w);
    lambda = Math.min(1, lambda + delta);
    if (1 - lambda < 1e-12) lambda = 1;
    const e = essAfter(parts.logw, ll, 0);
    let accept: number | null = null;
    const resample = e < thr * (1 + 1e-9) || lambda < 1;
    if (resample) {
      systematicResample(parts, model, streams.get(`${prefix}/step=${k}/resample`));
      newTerm.scale = lambda;
      accept = move(parts, model, [...terms, newTerm], cfg, streams.get(`${prefix}/step=${k}/move`));
      for (let p = 0; p < N; p++) ll[p] = logLik(ev.likelihood, ev.observation as Observation, ev.noise, parts.vals[p * model.nV + target]);
    }
    steps.push({ lambda, ess: e, resampled: resample, accept });
  }
  applied.push(ev);
  return { evidence: ev.id, target: ev.target_node, steps, ess_final: essAfter(parts.logw, ll, 0) };
}
