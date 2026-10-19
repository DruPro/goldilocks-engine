// Critic (code half; the LLM half arrives in Phase 2): posterior predictive checks
// on every applied observation, empty Goldilocks set, root conflicts, roots at risk
// from upward evidence, and low effective sample size.

import { log } from "../core/fmath.ts";
import { simulateObs, type Observation } from "../core/dist.ts";
import type { Streams } from "../core/rng.ts";
import type { Model } from "../model/tree.ts";
import type { Config, Evidence } from "../model/types.ts";
import type { Goldilocks, RelaxationReport, UpwardFlag } from "./selector.ts";
import type { Particles } from "./updater.ts";

export interface CriticFlag {
  kind: "ppc_misfit" | "empty_goldilocks" | "root_conflict" | "root_at_risk" | "suspected_missing_parameter" | "low_ess";
  severity: "info" | "warn" | "error";
  message: string;
  detail: Record<string, unknown>;
}

function statistic(ev: Evidence, obs: Observation): number {
  if ("values" in obs) {
    const xs = ev.likelihood === "lognormal" ? obs.values.map((v) => log(v)) : obs.values;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }
  if ("k" in obs) return obs.k;
  return (obs.lo + obs.hi) / 2;
}

/** Two-sided posterior predictive p-value of each applied observation. */
export function predictiveChecks(model: Model, parts: Particles, applied: Evidence[], streams: Streams, iter: number): { evidence: string; p: number }[] {
  return applied.map((ev) => {
    const idx = model.node(ev.target_node).index;
    const obs = ev.observation as Observation;
    const reps = "values" in obs ? obs.values.length : "k" in obs ? obs.n : 1;
    const t0 = statistic(ev, obs);
    const rng = streams.get(`critic/iter=${iter}/ppc/${ev.id}`);
    let hiMass = 0;
    let eqMass = 0;
    for (let p = 0; p < parts.N; p++) {
      const theta = parts.vals[p * model.nV + idx];
      const t = statistic(ev, simulateObs(ev.likelihood, ev.noise, theta, rng, reps));
      if (t > t0) hiMass += parts.w[p];
      else if (t === t0) eqMass += parts.w[p];
    }
    const upper = hiMass + eqMass / 2;
    return { evidence: ev.id, p: Math.min(1, 2 * Math.min(upper, 1 - upper)) };
  });
}

export function critic(args: {
  model: Model;
  parts: Particles;
  applied: Evidence[];
  gl: Goldilocks;
  relax: RelaxationReport | null;
  upward: UpwardFlag[];
  ess: number;
  cfg: Config;
  streams: Streams;
  iter: number;
}): CriticFlag[] {
  const flags: CriticFlag[] = [];
  for (const { evidence, p } of predictiveChecks(args.model, args.parts, args.applied, args.streams, args.iter)) {
    if (p < 0.01) {
      const ev = args.applied.find((e) => e.id === evidence)!;
      flags.push({ kind: "ppc_misfit", severity: "warn", message: `Observation ${evidence} is surprising under the posterior (p = ${p.toFixed(4)}).`, detail: { evidence, p, node: ev.target_node } });
      const node = args.model.node(ev.target_node);
      if (node.spec.parent_ids.length === 0)
        flags.push({ kind: "suspected_missing_parameter", severity: "info", message: `${ev.target_node} may be missing structure: its prior and the data disagree and it has no inputs to explain the gap.`, detail: { node: ev.target_node } });
    }
  }
  if (args.gl.G.length === 0) flags.push({ kind: "empty_goldilocks", severity: "error", message: "No candidate reaches the zone with probability τ.", detail: {} });
  for (const [a, b] of args.relax?.conflicts ?? [])
    flags.push({ kind: "root_conflict", severity: "error", message: `Roots ${a} and ${b} conflict: neither relaxation alone restores a non-empty set, both together do.`, detail: { roots: [a, b] } });
  for (const u of args.upward)
    if (u.at_risk)
      flags.push({
        kind: "root_at_risk",
        severity: "warn",
        message: `Root ${u.root} is at risk: the best candidate satisfies it with probability ${u.best_p.toFixed(3)} < τ.`,
        detail: { ...u },
      });
  if (args.ess < 0.1 * args.parts.N)
    flags.push({ kind: "low_ess", severity: "warn", message: `Effective sample size is ${args.ess.toFixed(0)} of ${args.parts.N}.`, detail: { ess: args.ess } });
  return flags;
}
