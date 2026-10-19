// Reporter (numbers only in Phase 1). Builds report.json from the final state; the
// markdown and SVG renderers only format what is here. No LLM text, no reordering.

import type { Streams } from "../core/rng.ts";
import { wquantiles, wilson } from "../core/stats.ts";
import { cluster, curves, type ClusterResult } from "../engine/clusterer.ts";
import { clip, rawSlack, type MCtx } from "../engine/evaluator.ts";
import { flips, type Flip } from "../engine/planner.ts";
import { priorSensitivity, relaxations, type RelaxationReport } from "../engine/selector.ts";
import { drawPrior } from "../engine/updater.ts";
import type { State } from "../engine/loop.ts";
import type { Inputs } from "../model/load.ts";
import type { Config } from "../model/types.ts";
import type { CriticAdvice } from "../agents/critic_llm.ts";
import type { Section } from "../agents/explainer.ts";
import type { Extras } from "../engine/loop.ts";

const Q = [0.05, 0.5, 0.95];

export interface ReportJson {
  format: "gde-report/1";
  title: string;
  status: string;
  iteration: number;
  settings: { tau: number; epsilon: number; beta: number; particles: number; ess: number; zone_rule: string; iteration_budget: number };
  recommended: {
    id: string;
    picks: Record<string, string>;
    p_zone: number;
    p_interval: [number, number];
    cost_q: number[];
    metrics: { root: string; unit: string | null; q: number[]; slack_q: number[] }[];
  }[];
  goldilocks: { G: string[]; qualified: number; cheapest_cost: number | null };
  solution_map: ClusterResult;
  requirements: RelaxationReport & { roots: { id: string; sense: string; target: number; lower: number | null; upper: number | null; weight: number; source: string }[] };
  upward: State["upward"];
  ledger: { id: string; kind: string; source: string; observable: boolean; measured: number; prior_q: number[]; posterior_q: number[]; evppi: number; score: number; action: string | null }[];
  next_measurements: { node: string; action: string; evppi: number; cost: number; score: number }[];
  flips: Flip[];
  llm_guess: ReturnType<typeof priorSensitivity> & { evppi_share: number };
  flags: State["flags"];
  history: State["history"];
  agents: Extras;
  /** LLM prose, kept apart from the numbers above; placeholders already filled by code. */
  explanations: { model: string; request: string; texts: Partial<Record<Section, string>> } | null;
  advice: { iter: number; model: string; request: string; advice: CriticAdvice } | null;
  /** Approvals the run used, from its event log (who, when, and whether bound to a content hash). */
  approvals: { what: string; approved_by: string; approved_at: string | null; bound: string | null }[] | null;
  audit: { run_id: string; manifest_sha256: string; events: string; final_snapshot: string };
}

export function buildReport(st: State, inp: Inputs, cfg: Config, streams: Streams, audit: ReportJson["audit"]): ReportJson {
  const { model, parts, pool, ev, gl } = st;
  const N = parts.N;
  const ctx: MCtx = { v: parts.vals, o: 0 };
  const metricQ = (c: number, i: number) => {
    const xs = new Float64Array(N);
    for (let p = 0; p < N; p++) {
      ctx.o = p * model.nV;
      xs[p] = pool.metrics[c][i](ctx);
    }
    return xs;
  };
  const recommended = gl.recommended.map((c) => {
    const cand = pool.cands[c];
    const metrics = pool.roots.map((r, i) => {
      const g = metricQ(c, i);
      const s = g.map((x) => clip(rawSlack(r, pool.scales[i], x)));
      return { root: r.id, unit: r.unit ?? null, q: wquantiles(g, parts.w, Q), slack_q: wquantiles(s, parts.w, Q) };
    });
    const cost = new Float64Array(N);
    for (let p = 0; p < N; p++) cost[p] = ev.cost[c * N + p];
    return { id: cand.id, picks: cand.picks, p_zone: ev.P[c], p_interval: wilson(ev.P[c], ev.ess), cost_q: wquantiles(cost, parts.w, Q), metrics };
  });

  const ids = pool.cands.map((c) => c.id);
  const cv = curves(model, parts, pool, cfg, streams, `report/iter=${st.iter}`);
  const binding: Record<string, string> = {};
  ids.forEach((id, c) => (binding[id] = pool.roots[ev.binding[c]].id));
  const map = cluster(ids, cv.curves, cv.mult, streams, `report/iter=${st.iter}`, new Set(gl.G.map((c) => ids[c])), binding);

  const relax = relaxations(ev, pool, parts.w, cfg, gl);

  const prior = drawPrior(model, cfg.particles, streams.get(`report/iter=${st.iter}/prior`));
  const measured = new Map<string, number>();
  for (const e of st.applied) measured.set(e.target_node, (measured.get(e.target_node) ?? 0) + 1);
  const values = new Map(st.plan.values.map((v) => [v.node, v]));
  const ledger = model.nodes.map((n) => {
    const px = new Float64Array(prior.N);
    for (let p = 0; p < prior.N; p++) px[p] = prior.vals[p * model.nV + n.index];
    const qx = new Float64Array(N);
    for (let p = 0; p < N; p++) qx[p] = parts.vals[p * model.nV + n.index];
    const v = values.get(n.id)!;
    return {
      id: n.id,
      kind: n.spec.kind,
      source: n.spec.source,
      observable: n.spec.observable,
      measured: measured.get(n.id) ?? 0,
      prior_q: wquantiles(px, prior.w, Q),
      posterior_q: wquantiles(qx, parts.w, Q),
      evppi: v.evppi,
      score: v.score,
      action: v.action,
    };
  });

  const next = st.plan.values.filter((v) => v.action !== null && v.evppi > 0).slice(0, 8).map((v) => ({ node: v.node, action: v.action!, evppi: v.evppi, cost: v.cost!, score: v.score }));
  const pick = gl.recommended.length ? ids[gl.recommended[0]] : null;
  const flipList = st.plan.values.filter((v) => v.evppi > 0).slice(0, 3).flatMap((v) => flips(model, parts, ev, pool, cfg, v.node, pick));

  const sens = priorSensitivity(ev, pool, model, parts, cfg, gl);
  const totalEvppi = st.plan.values.reduce((s, v) => s + v.evppi, 0);
  const guessIds = new Set(sens.nodes);
  const guessEvppi = st.plan.values.filter((v) => guessIds.has(v.node)).reduce((s, v) => s + v.evppi, 0);

  return {
    format: "gde-report/1",
    title: inp.problem.title,
    status: st.status,
    iteration: st.iter,
    settings: { tau: cfg.tau, epsilon: cfg.epsilon, beta: cfg.beta, particles: N, ess: ev.ess, zone_rule: cfg.zone_rule ?? "softmin", iteration_budget: cfg.iteration_budget },
    recommended,
    goldilocks: { G: gl.G.map((c) => ids[c]), qualified: gl.qualified.length, cheapest_cost: gl.cheapestCost },
    solution_map: map,
    requirements: {
      ...relax,
      roots: inp.roots.roots.map((r) => ({ id: r.id, sense: r.sense, target: r.target, lower: r.lower ?? null, upper: r.upper ?? null, weight: r.weight, source: r.source })),
    },
    upward: st.upward,
    ledger,
    next_measurements: next,
    flips: flipList,
    llm_guess: { ...sens, evppi_share: totalEvppi > 0 ? guessEvppi / totalEvppi : 0 },
    flags: st.flags,
    history: st.history,
    agents: st.extras,
    explanations: null,
    advice: null,
    approvals: null,
    audit,
  };
}
