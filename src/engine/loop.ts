// The iteration driver. Each iteration: take the planned action (MEASURE, EXPAND or
// hold), update the posterior, evaluate the pool, select the Goldilocks set, plan the
// next action, run the code critic, and emit a snapshot. Every random stream is named
// by (module, iteration, purpose), so a resumed run is bit-identical to an
// uninterrupted one.
//
// LLM agents only propose: decompositions (EXPAND, and drivers a root needs) and
// hybrid options enter the model after code checks, and are part of the snapshot so
// resume and replay rebuild the same tree. Critic advice never enters a snapshot.

import { agentSettings, modelFor, type AgentSettings } from "../agents/index.ts";
import { critique, type CriticAdvice } from "../agents/critic_llm.ts";
import { decompose, type DecomposeTarget } from "../agents/decomposer.ts";
import { proposeHybrids, type ProposedOption } from "../agents/hybrids.ts";
import type { LlmClient } from "../agents/llm.ts";
import { freeVars, parse } from "../core/expr.ts";
import { exp } from "../core/fmath.ts";
import { Streams } from "../core/rng.ts";
import { jaccard, wquantiles, wilson } from "../core/stats.ts";
import { bytesToFloat64, canonicalJsonPretty, float64Bytes, hashValue, sha256 } from "../io/canon.ts";
import type { Inputs } from "../model/load.ts";
import { buildModel, type Model, type TreeInputs } from "../model/tree.ts";
import type { Candidate, CatalogFile, Config, Decomposition, Evidence, ParamNode, Root } from "../model/types.ts";
import { critic, type CriticFlag } from "./critic.ts";
import { compilePool, evaluate, type CompiledPool, type Evaluation } from "./evaluator.ts";
import { generateCandidates, type Pool } from "./generator.ts";
import type { Oracle } from "./oracle.ts";
import { plan, type Plan } from "./planner.ts";
import { goldilocks, upwardEvidence, type Goldilocks, type UpwardFlag } from "./selector.ts";
import { applyEvidence, drawPrior, type Particles, type UpdateReport } from "./updater.ts";

export const SNAPSHOT_FORMAT = "gde-snapshot/2";

export interface EventRecord {
  iter: number;
  kind: "init" | "approve" | "expand" | "measure" | "update" | "evaluate" | "plan" | "hold" | "pause" | "stop" | "snapshot" | "propose" | "advice";
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  detail?: Record<string, unknown>;
}

export interface HistoryEntry {
  iter: number;
  action: { kind: "init" | "measure" | "expand" | "hold"; node: string | null; evidence: string | null };
  G: string[];
  max_score: number;
  jaccard: number | null;
  stop_condition: boolean;
}

/** Accepted agent proposals: part of the model state, so they live in snapshots. */
export interface Extras {
  decompositions: Decomposition[];
  options: ProposedOption[];
  hybrid_calls: number;
}

export interface Snapshot {
  format: string;
  iter: number;
  status: "running" | "converged" | "budget_spent" | "awaiting_evidence";
  config_hash: string;
  inputs_hash: string;
  model: { hash: string; expanded: string[]; nodes: ParamNode[] };
  agents: Extras;
  evidence_applied: Evidence[];
  particles: { N: number; nB: number; file: string; sha256: string; ess: number };
  candidates: { total: number; passing: number; ids: string[]; llm_proposed: string[] };
  scores: { id: string; P: number; P_lo: number; P_hi: number; cost_mean: number; binding: string }[];
  goldilocks: { qualified: string[]; G: string[]; recommended: string[]; cheapest_cost: number | null };
  plan: Plan;
  upward: UpwardFlag[];
  flags: CriticFlag[];
  updates: UpdateReport[];
  history: HistoryEntry[];
  awaiting: { node: string; measurement: ParamNode["measurement"] } | null;
}

export interface State {
  iter: number;
  model: Model;
  parts: Particles;
  applied: Evidence[];
  pool: CompiledPool;
  candidates: Pool;
  extras: Extras;
  ev: Evaluation;
  gl: Goldilocks;
  plan: Plan;
  upward: UpwardFlag[];
  flags: CriticFlag[];
  history: HistoryEntry[];
  status: Snapshot["status"];
}

export interface LoopHooks {
  event(e: EventRecord): void;
  snapshot(iter: number, json: string, particleBytes: Uint8Array, snap: Snapshot): void;
  advice?(iter: number, advice: CriticAdvice, key: string): void;
}

export interface LoopOptions {
  inputs: Inputs;
  config: Config;
  oracle: Oracle | null;
  hooks: LoopHooks;
  llm?: LlmClient | null;
  resume?: { snapshot: Snapshot; particleBytes: Uint8Array };
  /** Approved evidence supplied on resume (live mode), consumed when MEASURE asks for it. */
  extraEvidence?: Evidence[];
  /** Stop after this iteration, as if interrupted (tests). */
  haltAfter?: number;
}

export const NO_EXTRAS: Extras = { decompositions: [], options: [], hybrid_calls: 0 };

export function mergedCatalog(base: CatalogFile, options: ProposedOption[]): CatalogFile {
  const cat = structuredClone(base);
  for (const p of options) cat.dimensions.find((d) => d.id === p.dimension)!.options.push(structuredClone(p.option));
  return cat;
}

export function treeInputs(inp: Inputs, extras: Extras = NO_EXTRAS): TreeInputs {
  return { roots: inp.roots.roots, catalog: mergedCatalog(inp.catalog, extras.options), decompositions: [...inp.decompositions, ...extras.decompositions] };
}

export function inputsHash(inp: Inputs): string {
  return hashValue(inp.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
}

export function guessWidthErrors(model: Model, parts: Particles, cfg: Config, only?: Set<string>): string[] {
  const errs: string[] = [];
  for (const n of model.nodes) {
    if (n.spec.source !== "llm_guess" || n.base < 0 || (only && !only.has(n.id))) continue;
    const xs = new Float64Array(parts.N);
    for (let p = 0; p < parts.N; p++) xs[p] = parts.vals[p * model.nV + n.index];
    const [lo, hi] = wquantiles(xs, parts.w, [0.05, 0.95]);
    const rel = (hi - lo) / Math.max(1e-12, Math.abs((hi + lo) / 2));
    if (rel < cfg.llm_guess_min_rel_width)
      errs.push(`llm_guess node ${n.id} has a prior that is too narrow: 90% interval [${lo}, ${hi}] has relative width ${rel.toFixed(3)} < ${cfg.llm_guess_min_rel_width}`);
  }
  return errs;
}

function checkGuessWidth(model: Model, parts: Particles, cfg: Config): void {
  const errs = guessWidthErrors(model, parts, cfg);
  if (errs.length) throw new Error(errs[0]);
}

function particleBytes(parts: Particles): Uint8Array {
  const all = new Float64Array(parts.base.length + parts.logw.length);
  all.set(parts.base, 0);
  all.set(parts.logw, parts.base.length);
  return float64Bytes(all);
}

function quantilesOf(model: Model, parts: Particles, id: string): number[] {
  const n = model.node(id);
  const xs = new Float64Array(parts.N);
  for (let p = 0; p < parts.N; p++) xs[p] = parts.vals[p * model.nV + n.index];
  return wquantiles(xs, parts.w, [0.05, 0.5, 0.95]);
}

/** Names a root's metric reads that are neither catalog attributes nor existing nodes. */
export function missingDrivers(model: Model, root: Root): string[] {
  return freeVars(parse(root.metric)).filter((v) => !(v.includes(".") && !v.includes("@")) && !model.byId.has(v));
}

export async function runLoop(o: LoopOptions): Promise<State> {
  const { inputs, config: cfg, hooks } = o;
  const settings: AgentSettings = agentSettings(cfg);
  const llm = o.llm ?? null;
  if ((settings.decomposer === "llm" || settings.hybrids || settings.critic) && !llm) throw new Error("config turns LLM agents on but no LLM client was provided");
  const expandAny = settings.decomposer === "llm";
  const streams = new Streams(cfg.seed);
  const cfgHash = hashValue(cfg);
  const inHash = inputsHash(inputs);
  const pool: Evidence[] = [...inputs.evidence, ...(o.extraEvidence ?? [])];
  const evHash = (e: Evidence) => hashValue(e);
  const candidatesFor = (x: Extras) => generateCandidates(mergedCatalog(inputs.catalog, x.options), inputs.problem.gates, new Set(x.options.map((p) => p.option.id)));
  const build = (x: Extras, expanded: string[]) => buildModel(treeInputs(inputs, x), expanded, { expandAny });
  const decomposeCtx = (model: Model) => ({
    problem_title: inputs.problem.title,
    objectives: inputs.problem.objectives,
    existing_ids: model.nodes.map((n) => n.id),
    min_rel_width: cfg.llm_guess_min_rel_width,
  });

  let st: State;
  let initUpdates: UpdateReport[] = [];
  const analyse = (model: Model, parts: Particles, applied: Evidence[], iter: number, history: HistoryEntry[], extras: Extras, cands: Pool): State => {
    const cp = compilePool(model, inputs.roots.roots, cands.passing, cfg);
    const ev = evaluate(cp, parts.vals, model.nV, parts.w, cfg);
    const gl = goldilocks(ev.P, ev.costMean, cfg.tau, cfg.epsilon);
    hooks.event({ iter, kind: "evaluate", inputs: { model: model.hash, particles: sha256(particleBytes(parts)) }, outputs: { scores: hashValue(Array.from(ev.P)), goldilocks: hashValue(gl.G) }, detail: { G: gl.G.map((c) => cp.cands[c].id), ess: ev.ess } });
    const pl = plan(model, parts, ev, cp, cfg, streams, iter);
    hooks.event({ iter, kind: "plan", inputs: { scores: hashValue(Array.from(ev.P)) }, outputs: { plan: hashValue(pl) }, detail: { next: pl.next, max_score: pl.max_score } });
    const upward = upwardEvidence(ev, cp, model, parts, cfg);
    const flags = critic({ model, parts, applied, gl, relax: null, upward, ess: ev.ess, cfg, streams, iter });
    return { iter, model, parts, applied, pool: cp, candidates: cands, extras, ev, gl, plan: pl, upward, flags, history, status: "running" };
  };

  /** Fresh prior for a changed tree, then every applied observation again (tempered). */
  const rebuild = (model: Model, applied: Evidence[], tag: string, updates: UpdateReport[]): { parts: Particles; applied: Evidence[] } => {
    const parts = drawPrior(model, cfg.particles, streams.get(`${tag}/prior/struct=${model.hash.slice(0, 16)}`));
    checkGuessWidth(model, parts, cfg);
    const reapplied: Evidence[] = [];
    for (const e of applied) updates.push(applyEvidence(model, parts, reapplied, e, cfg, streams, `${tag}/ev=${e.id}`));
    return { parts, applied: reapplied };
  };

  /** Code checks on a proposed decomposition: it builds, its guesses are wide, and the node keeps its meaning. */
  const decompositionCheck = (model: Model, extras: Extras, node: string | null, iter: number) => (dec: Decomposition): string[] => {
    const errs: string[] = [];
    let m2: Model;
    try {
      m2 = build({ ...extras, decompositions: [...extras.decompositions, dec] }, node ? [...model.expanded, node] : model.expanded);
    } catch (e) {
      return [`the proposal does not fit the tree: ${(e as Error).message}`];
    }
    const after = drawPrior(m2, 3000, streams.get(`decomposer/iter=${iter}/check/${dec.parent}/after`));
    errs.push(...guessWidthErrors(m2, after, cfg, new Set(dec.children.map((c) => c.id))));
    if (node) {
      const before = drawPrior(model, 3000, streams.get(`decomposer/iter=${iter}/check/${dec.parent}/before`));
      const [l1, m1, h1] = quantilesOf(model, before, node);
      const [l2, mm2, h2] = quantilesOf(m2, after, node);
      const ratio = Math.abs(mm2) / Math.max(1e-12, Math.abs(m1));
      if (!(ratio >= 0.5 && ratio <= 2)) errs.push(`the decomposition moves the median of ${node} from ${m1.toPrecision(3)} to ${mm2.toPrecision(3)}; keep it within a factor of two`);
      if (l2 > h1 || l1 > h2) errs.push(`the decomposition's 90% interval for ${node} [${l2.toPrecision(3)}, ${h2.toPrecision(3)}] does not overlap the current one [${l1.toPrecision(3)}, ${h1.toPrecision(3)}]`);
    }
    return errs;
  };

  const emitSnapshot = (s: State, updates: UpdateReport[], awaiting: Snapshot["awaiting"]): Snapshot => {
    const bytes = particleBytes(s.parts);
    const ids = (xs: number[]) => xs.map((c) => s.pool.cands[c].id);
    const snap: Snapshot = {
      format: SNAPSHOT_FORMAT,
      iter: s.iter,
      status: s.status,
      config_hash: cfgHash,
      inputs_hash: inHash,
      model: { hash: s.model.hash, expanded: s.model.expanded, nodes: s.model.nodes.map((n) => n.spec) },
      agents: s.extras,
      evidence_applied: s.applied,
      particles: { N: s.parts.N, nB: s.model.nB, file: `iter_${s.iter}.particles.bin`, sha256: sha256(bytes), ess: s.ev.ess },
      candidates: { total: s.candidates.all.length, passing: s.candidates.passing.length, ids: s.candidates.passing.map((c) => c.id), llm_proposed: s.candidates.passing.filter((c) => c.origin === "llm_proposed").map((c) => c.id) },
      scores: s.pool.cands.map((c, i) => {
        const [lo, hi] = wilson(s.ev.P[i], s.ev.ess);
        return { id: c.id, P: s.ev.P[i], P_lo: lo, P_hi: hi, cost_mean: s.ev.costMean[i], binding: s.pool.roots[s.ev.binding[i]].id };
      }),
      goldilocks: { qualified: ids(s.gl.qualified), G: ids(s.gl.G), recommended: ids(s.gl.recommended), cheapest_cost: s.gl.cheapestCost },
      plan: s.plan,
      upward: s.upward,
      flags: s.flags,
      updates,
      history: s.history,
      awaiting,
    };
    const json = canonicalJsonPretty(snap);
    hooks.snapshot(s.iter, json, bytes, snap);
    hooks.event({ iter: s.iter, kind: "snapshot", inputs: {}, outputs: { snapshot: sha256(json), particles: snap.particles.sha256 } });
    return snap;
  };

  const historyEntry = (s: State, action: HistoryEntry["action"], prevG: string[] | null): HistoryEntry => {
    const G = s.gl.G.map((c) => s.pool.cands[c].id);
    const j = prevG === null ? null : jaccard(G, prevG);
    return { iter: s.iter, action, G, max_score: s.plan.max_score, jaccard: j, stop_condition: j !== null && s.plan.max_score < 1 && j >= 0.99 };
  };

  /** Generator, LLM half: hybrids only when G is empty or every member is within 0.05 of τ. */
  const maybeHybrids = async (s: State, updates: UpdateReport[]): Promise<State> => {
    if (!settings.hybrids || !llm || s.extras.hybrid_calls >= settings.max_hybrid_calls) return s;
    const empty = s.gl.G.length === 0;
    if (!empty && !s.gl.G.every((c) => s.ev.P[c] < cfg.tau + 0.05)) return s;
    const top = [...s.pool.cands.keys()].sort((a, b) => s.ev.P[b] - s.ev.P[a] || a - b).slice(0, 8);
    const res = await proposeHybrids(llm, modelFor(cfg, "hybrids"), {
      catalog: mergedCatalog(inputs.catalog, s.extras.options),
      roots: inputs.roots.roots.map((r) => ({ id: r.id, description: r.description, band: r.sense === "upper" ? `<= ${r.upper}` : r.sense === "lower" ? `>= ${r.lower}` : `[${r.lower}, ${r.upper}]` })),
      status: empty ? "No candidate reaches the zone with the required probability." : "Every candidate in the set sits within 0.05 of the required probability.",
      top: top.map((c) => ({ id: s.pool.cands[c].id, p: s.ev.P[c], binding: s.pool.roots[s.ev.binding[c]].id })),
      min_rel_width: cfg.llm_guess_min_rel_width,
    });
    const extras: Extras = { ...s.extras, options: [...s.extras.options, ...res.options], hybrid_calls: s.extras.hybrid_calls + 1 };
    const model = build(extras, s.model.expanded);
    const rb = rebuild(model, s.applied, `hybrids/iter=${s.iter}`, updates);
    hooks.event({ iter: s.iter, kind: "propose", inputs: { llm_request: res.key, model: s.model.hash }, outputs: { model: model.hash }, detail: { agent: "hybrids", options: res.options.map((p) => p.option.id) } });
    return analyse(model, rb.parts, rb.applied, s.iter, s.history, extras, candidatesFor(extras));
  };

  const maybeAdvice = async (s: State) => {
    if (!settings.critic || !llm || (s.flags.length === 0 && s.status === "running")) return;
    const res = await critique(llm, modelFor(cfg, "critic"), {
      iteration: s.iter,
      flags: s.flags.map((f) => ({ kind: f.kind, severity: f.severity, message: f.message })),
      recommended: s.gl.recommended.map((c) => s.pool.cands[c].id),
      goldilocks: s.gl.G.map((c) => s.pool.cands[c].id),
      top_values: s.plan.values.slice(0, 5).map((v) => ({ node: v.node, action: v.action })),
      roots: inputs.roots.roots.map((r) => ({ id: r.id, description: r.description })),
      node_ids: s.model.nodes.map((n) => n.id),
      candidate_ids: s.pool.cands.map((c) => c.id),
    });
    hooks.advice?.(s.iter, res.advice, res.key);
    hooks.event({ iter: s.iter, kind: "advice", inputs: { llm_request: res.key }, outputs: { advice: hashValue(res.advice) }, detail: { agent: "critic" } });
  };

  if (o.resume) {
    const snap = o.resume.snapshot;
    if (snap.format !== SNAPSHOT_FORMAT) throw new Error(`unsupported snapshot format ${snap.format}`);
    if (snap.config_hash !== cfgHash) throw new Error("config differs from the snapshot's; use rerun for changed inputs");
    const extras = snap.agents;
    const model = build(extras, snap.model.expanded);
    if (model.hash !== snap.model.hash) throw new Error("rebuilt parameter tree does not match the snapshot");
    if (sha256(o.resume.particleBytes) !== snap.particles.sha256) throw new Error("particle file hash does not match the snapshot");
    const flat = bytesToFloat64(o.resume.particleBytes);
    const N = snap.particles.N;
    const base = flat.slice(0, N * model.nB);
    const logw = flat.slice(N * model.nB);
    const w = new Float64Array(N);
    for (let p = 0; p < N; p++) w[p] = exp(logw[p]);
    const parts: Particles = { N, base, vals: model.forwardAll(base, N), logw, w };
    st = analyse(model, parts, [...snap.evidence_applied], snap.iter, snap.history, extras, candidatesFor(extras));
  } else {
    hooks.event({ iter: 0, kind: "approve", inputs: { roots: hashValue(inputs.roots) }, outputs: {}, detail: { what: "roots", ...inputs.roots.approval, bound_to_content: inputs.roots.approval.content_sha256 ?? null } });
    let extras: Extras = { ...NO_EXTRAS };
    let model = build(extras, []);
    // Roots generate children: drivers a root's metric needs and nothing defines yet.
    for (const r of inputs.roots.roots) {
      const missing = missingDrivers(model, r);
      if (missing.length === 0) continue;
      if (settings.decomposer !== "llm" || !llm) throw new Error(`root ${r.id} reads ${missing.join(", ")}, which no decomposition defines`);
      const target: DecomposeTarget = { kind: "root", id: r.id, description: r.description, unit: r.unit ?? null, current_prior: null, inputs: [], required_ids: missing, read_by: [r.id] };
      const res = await decompose(llm, modelFor(cfg, "decomposer"), target, decomposeCtx(model), decompositionCheck(model, extras, null, 0));
      extras = { ...extras, decompositions: [...extras.decompositions, res.decomposition] };
      const next = build(extras, []);
      hooks.event({ iter: 0, kind: "propose", inputs: { llm_request: res.key, model: model.hash }, outputs: { model: next.hash }, detail: { agent: "decomposer", root: r.id, children: res.decomposition.children.map((c) => c.id) } });
      model = next;
    }
    const cands = candidatesFor(extras);
    hooks.event({ iter: 0, kind: "init", inputs: { inputs: inHash, config: cfgHash }, outputs: { model: model.hash }, detail: { nodes: model.nV, candidates: cands.all.length, passing: cands.passing.length } });
    const parts = drawPrior(model, cfg.particles, streams.get(`prior/struct=${model.hash.slice(0, 16)}`));
    checkGuessWidth(model, parts, cfg);
    const applied: Evidence[] = [];
    const updates: UpdateReport[] = [];
    for (const e of [...inputs.evidence].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      hooks.event({ iter: 0, kind: "approve", inputs: { evidence: evHash(e) }, outputs: {}, detail: { what: e.id, approved_by: e.approved_by, approved_at: e.approved_at ?? null, bound_to_content: e.approval_sha256 ?? null } });
      const before = sha256(particleBytes(parts));
      updates.push(applyEvidence(model, parts, applied, e, cfg, streams, `init/ev=${e.id}`));
      hooks.event({ iter: 0, kind: "update", inputs: { particles: before, evidence: evHash(e) }, outputs: { particles: sha256(particleBytes(parts)) }, detail: { evidence: e.id } });
    }
    st = analyse(model, parts, applied, 0, [], extras, cands);
    st = await maybeHybrids(st, updates);
    st.history = [historyEntry(st, { kind: "init", node: null, evidence: null }, null)];
    initUpdates = updates;
  }

  const consumed = () => new Set(st.applied.map((e) => e.id));
  // Decide whether the state just analysed ends the run; the snapshot carries the status.
  const settle = (s: State) => {
    const h = s.history;
    const last = h[h.length - 1];
    const prev = h.length >= 2 ? h[h.length - 2] : null;
    if (last?.stop_condition && prev?.stop_condition) {
      s.status = "converged";
      hooks.event({ iter: s.iter, kind: "stop", inputs: {}, outputs: {}, detail: { reason: "max EVPPI/cost < 1 and Jaccard >= 0.99 for 2 consecutive iterations" } });
    } else if (s.iter >= cfg.iteration_budget) {
      s.status = "budget_spent";
      hooks.event({ iter: s.iter, kind: "stop", inputs: {}, outputs: {}, detail: { reason: "iteration budget spent" } });
    }
  };
  if (!o.resume) {
    settle(st);
    await maybeAdvice(st);
    emitSnapshot(st, initUpdates, null);
  } else settle(st);

  for (let k = st.iter + 1; st.status === "running"; k++) {
    if (o.haltAfter !== undefined && st.iter >= o.haltAfter) break;
    const last = st.history[st.history.length - 1];
    const prevG = last.G;
    const next = st.plan.max_score >= 1 ? st.plan.next : null;
    let model = st.model;
    let parts = st.parts;
    let applied = [...st.applied];
    let extras = st.extras;
    const updates: UpdateReport[] = [];
    let action: HistoryEntry["action"] = { kind: "hold", node: null, evidence: null };

    if (next?.action === "measure") {
      let evd: Evidence | undefined;
      if (o.oracle) evd = o.oracle.measure(next.node, k, model);
      else evd = pool.filter((e) => e.target_node === next.node && !consumed().has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (!evd) {
        st.status = "awaiting_evidence";
        const node = model.node(next.node).spec;
        hooks.event({ iter: st.iter, kind: "pause", inputs: {}, outputs: {}, detail: { measure: next.node, measurement: node.measurement ?? null } });
        await maybeAdvice(st);
        emitSnapshot(st, [], { node: next.node, measurement: node.measurement });
        return st;
      }
      hooks.event({ iter: k, kind: "measure", inputs: { evidence: evHash(evd) }, outputs: {}, detail: { node: next.node, evidence: evd.id, score: next.score } });
      hooks.event({ iter: k, kind: "approve", inputs: { evidence: evHash(evd) }, outputs: {}, detail: { what: evd.id, approved_by: evd.approved_by, approved_at: evd.approved_at ?? null, bound_to_content: evd.approval_sha256 ?? null } });
      const before = sha256(particleBytes(parts));
      updates.push(applyEvidence(model, parts, applied, evd, cfg, streams, `update/iter=${k}/ev=${evd.id}`));
      hooks.event({ iter: k, kind: "update", inputs: { particles: before, evidence: evHash(evd) }, outputs: { particles: sha256(particleBytes(parts)) }, detail: { evidence: evd.id } });
      action = { kind: "measure", node: next.node, evidence: evd.id };
    } else if (next?.action === "expand") {
      const before = model.hash;
      let source = "fixture decompositions (Phase 1 stub)";
      const fixtureHas = inputs.decompositions.some((d) => d.parent === next.node);
      if (settings.decomposer === "llm" && llm && !fixtureHas) {
        const spec = model.node(next.node).spec;
        const [q05, q50, q95] = quantilesOf(model, parts, next.node);
        const target: DecomposeTarget = {
          kind: "node",
          id: next.node,
          description: spec.rationale,
          unit: spec.unit ?? null,
          current_prior: `${spec.distribution.type}(${Object.entries(spec.distribution.params).map(([a, b]) => `${a}=${b}`).join(", ")}); current 90% interval [${q05.toPrecision(3)}, ${q95.toPrecision(3)}], median ${q50.toPrecision(3)}`,
          inputs: spec.parent_ids,
          required_ids: [],
          read_by: inputs.roots.roots.filter((r) => st.pool.refs.get(r.id)?.has(next.node)).map((r) => `${r.id}: ${r.description}`),
        };
        const res = await decompose(llm, modelFor(cfg, "decomposer"), target, decomposeCtx(model), decompositionCheck(model, extras, next.node, k));
        extras = { ...extras, decompositions: [...extras.decompositions, res.decomposition] };
        source = `decomposer agent (${res.key.slice(0, 12)})`;
      }
      model = build(extras, [...model.expanded, next.node]);
      const rb = rebuild(model, applied, `rebuild/iter=${k}`, updates);
      parts = rb.parts;
      applied = rb.applied;
      hooks.event({ iter: k, kind: "expand", inputs: { model: before }, outputs: { model: model.hash, particles: sha256(particleBytes(parts)) }, detail: { node: next.node, score: next.score, source } });
      action = { kind: "expand", node: next.node, evidence: null };
    } else {
      hooks.event({ iter: k, kind: "hold", inputs: {}, outputs: {}, detail: { max_score: st.plan.max_score } });
    }

    const history = st.history;
    st = analyse(model, parts, applied, k, history, extras, extras === st.extras ? st.candidates : candidatesFor(extras));
    st = await maybeHybrids(st, updates);
    st.history = [...history, historyEntry(st, action, prevG)];
    settle(st);
    await maybeAdvice(st);
    emitSnapshot(st, updates, null);
  }
  return st;
}
