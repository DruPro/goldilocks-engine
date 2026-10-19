// Distributions in non-centred form. Every stochastic node owns one base variable:
// "z" (standard normal) or "u" (uniform on (0,1)). Its value is a deterministic
// transform of that base and, for child nodes, of a location computed from the
// parents. The prior over base variables is therefore a product of independent
// standard densities, which keeps prior sampling, MCMC moves and prior-sensitivity
// reweighting simple and exact.

import { exp, log, sigmoid, softplus } from "./fmath.ts";
import type { Rng } from "./rng.ts";

export type DistType = "normal" | "lognormal" | "uniform" | "triangular" | "logitnormal" | "deterministic";
export type BaseKind = "z" | "u" | "none";

export interface DistSpec {
  type: DistType;
  params: Record<string, number>;
}

export function baseKind(type: DistType): BaseKind {
  if (type === "deterministic") return "none";
  if (type === "uniform" || type === "triangular") return "u";
  return "z";
}

/** Required parameter names for parentless nodes and for nodes with a location formula. */
export const PARAMS: Record<DistType, { free: string[]; located: string[] | null }> = {
  normal: { free: ["mean", "sd"], located: ["sd"] },
  lognormal: { free: ["median", "sigma"], located: ["sigma"] },
  uniform: { free: ["lo", "hi"], located: null },
  triangular: { free: ["lo", "mode", "hi"], located: null },
  logitnormal: { free: ["mu", "sigma"], located: ["sigma"] },
  deterministic: { free: [], located: [] },
};

export function checkParams(spec: DistSpec, located: boolean): string | null {
  const want = located ? PARAMS[spec.type].located : PARAMS[spec.type].free;
  if (want === null) return `${spec.type} cannot take a dependency formula`;
  const have = Object.keys(spec.params).sort();
  const need = [...want].sort();
  if (have.join(",") !== need.join(",")) return `${spec.type} needs params {${need.join(", ")}}, got {${have.join(", ")}}`;
  for (const k of need) if (!Number.isFinite(spec.params[k])) return `param ${k} must be a finite number`;
  const p = spec.params;
  if ("sd" in p && !(p.sd > 0)) return "sd must be > 0";
  if ("sigma" in p && !(p.sigma > 0)) return "sigma must be > 0";
  if (spec.type === "lognormal" && !located && !(p.median > 0)) return "median must be > 0";
  if (spec.type === "uniform" && !(p.hi > p.lo)) return "uniform needs hi > lo";
  if (spec.type === "triangular" && !(p.lo <= p.mode && p.mode <= p.hi && p.hi > p.lo)) return "triangular needs lo <= mode <= hi, lo < hi";
  return null;
}

/** Value of a node from its base variable; `loc` is the dependency value (NaN if none). */
export function transform(spec: DistSpec, base: number, loc: number): number {
  const p = spec.params;
  switch (spec.type) {
    case "deterministic":
      return loc;
    case "normal":
      return (Number.isNaN(loc) ? p.mean : loc) + p.sd * base;
    case "lognormal":
      return (Number.isNaN(loc) ? p.median : loc) * exp(p.sigma * base);
    case "logitnormal":
      return sigmoid((Number.isNaN(loc) ? p.mu : logit(loc)) + p.sigma * base);
    case "uniform":
      return p.lo + (p.hi - p.lo) * base;
    case "triangular": {
      const { lo, mode, hi } = p;
      const fc = (mode - lo) / (hi - lo);
      return base < fc ? lo + Math.sqrt(base * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - base) * (hi - lo) * (hi - mode));
    }
  }
}

export function logit(p: number): number {
  return log(p / (1 - p));
}

/** Log density of a base variable under its standard prior (constants dropped). */
export function baseLogPrior(kind: BaseKind, b: number): number {
  if (kind === "z") return -0.5 * b * b;
  if (kind === "u") return b > 0 && b < 1 ? 0 : -Infinity;
  return 0;
}

export function sampleBase(kind: BaseKind, rng: Rng): number {
  if (kind === "z") return rng.normal();
  if (kind === "u") return rng.open();
  return 0;
}

/** Reflect a proposal back into (0,1); keeps a symmetric random walk symmetric. */
export function reflectUnit(u: number): number {
  let x = u;
  for (let i = 0; i < 8 && (x <= 0 || x >= 1); i++) x = x <= 0 ? -x : 2 - x;
  return x <= 0 || x >= 1 ? 0.5 : x;
}

// ------------------------------------------------------------------ likelihoods

export type LikelihoodType = "normal" | "lognormal" | "binomial" | "interval";

export type Observation =
  | { values: number[] } // normal / lognormal replicates
  | { k: number; n: number } // binomial
  | { lo: number; hi: number }; // interval

/** Log-likelihood of an observation given the node value theta (constants dropped). */
export function logLik(type: LikelihoodType, obs: Observation, noise: number, theta: number): number {
  switch (type) {
    case "normal": {
      let s = 0;
      for (const y of (obs as { values: number[] }).values) {
        const d = (y - theta) / noise;
        s -= 0.5 * d * d;
      }
      return s;
    }
    case "lognormal": {
      if (!(theta > 0)) return -Infinity;
      const lt = log(theta);
      let s = 0;
      for (const y of (obs as { values: number[] }).values) {
        const d = (log(y) - lt) / noise;
        s -= 0.5 * d * d;
      }
      return s;
    }
    case "binomial": {
      const { k, n } = obs as { k: number; n: number };
      if (!(theta > 0 && theta < 1)) return -Infinity;
      return k * log(theta) + (n - k) * log(1 - theta);
    }
    case "interval": {
      const { lo, hi } = obs as { lo: number; hi: number };
      return -softplus(-(theta - lo) / noise) - softplus(-(hi - theta) / noise);
    }
  }
}

/** Simulate an observation of theta (used by the synthetic oracle and predictive checks). */
export function simulateObs(type: LikelihoodType, noise: number, theta: number, rng: Rng, replicates = 1): Observation {
  if (type === "normal") return { values: Array.from({ length: replicates }, () => theta + noise * rng.normal()) };
  if (type === "lognormal") return { values: Array.from({ length: replicates }, () => theta * exp(noise * rng.normal())) };
  if (type === "binomial") {
    let k = 0;
    for (let i = 0; i < replicates; i++) if (rng.next() < theta) k++;
    return { k, n: replicates };
  }
  const y = theta + noise * rng.normal();
  return { lo: y - 2 * noise, hi: y + 2 * noise };
}
