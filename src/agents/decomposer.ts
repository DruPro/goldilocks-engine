// Decomposer agent: proposes how a node (or a root's missing drivers) breaks down
// into finer sub-parameters. It only proposes. Code checks the proposal (schema,
// ids, formulas, distributions, llm_guess width, consistency with the node's current
// prior) and the engine decides whether expanding is worth it (EVPPI/cost).

import { checkParams, type DistSpec } from "../core/dist.ts";
import { freeVars, parse } from "../core/expr.ts";
import { T, type Static } from "../model/schema.ts";
import type { Decomposition, ParamNode } from "../model/types.ts";
import type { LlmClient } from "./llm.ts";

const ParamKV = T.Object({ name: T.String(), value: T.Number() });
const ChildOut = T.Object({
  id: T.String({ description: "new snake_case id" }),
  unit: T.String(),
  distribution: T.Object({ type: T.Enum(["normal", "lognormal", "uniform", "triangular", "logitnormal"] as const), params: T.Array(ParamKV, { minItems: 1 }) }),
  observable: T.Boolean(),
  measure_cost_usd: T.Nullable(T.Number()),
  measurement: T.Nullable(T.Object({ likelihood: T.Enum(["normal", "lognormal", "binomial", "interval"] as const), noise: T.Number(), replicates: T.Integer() })),
  rationale: T.String(),
});
export const DecompositionOutSchema = T.Object({
  rationale: T.String(),
  replace: T.Nullable(T.Object({ type: T.Enum(["deterministic", "normal", "lognormal"] as const), noise: T.Nullable(T.Number()), dependency: T.String() })),
  children: T.Array(ChildOut, { minItems: 1 }),
});
export type DecompositionOut = Static<typeof DecompositionOutSchema>;

export interface DecomposeTarget {
  kind: "node" | "root";
  id: string;
  description: string;
  unit: string | null;
  current_prior: string | null;
  inputs: string[]; // existing inputs the dependency may also use
  required_ids: string[]; // roots only: drivers the metric reads that do not exist yet
  read_by: string[];
}

export interface DecomposeContext {
  problem_title: string;
  objectives: string[];
  existing_ids: string[];
  min_rel_width: number;
}

export const DECOMPOSER_SYSTEM = `You are the decomposer agent inside an engineering decision engine.
Your only job is to PROPOSE how one uncertain quantity breaks down into a few finer
sub-parameters that are easier to estimate or measure. Code validates your proposal and
decides whether to use it. You never rank, choose or score solutions.

Rules:
- Propose 1 to 6 children with new snake_case ids that do not collide with existing ids.
- Give each child a prior: lognormal {median, sigma} for positive quantities, normal
  {mean, sd}, uniform {lo, hi}, triangular {lo, mode, hi}, or logitnormal {mu, sigma} for
  probabilities. Params are a list of {name, value}.
- Your numbers are guesses and will be tagged llm_guess, so make them honestly wide: the
  90% interval must be at least as wide (relative to its midpoint) as the rule states.
- For a node, "replace" says how the node is computed from its children: usually
  "deterministic" with a dependency formula; "normal"/"lognormal" add residual noise
  (noise = sd or sigma). Formulas use the child ids (and the listed existing inputs),
  numbers, + - * / ^, min, max, abs, sqrt, exp, log, pow, clamp, if. For a root, set
  "replace" to null and include every required child id.
- The quantity implied by your children must stay consistent with the node's current
  prior: same order of magnitude, overlapping 90% intervals.
- At least one child of a node decomposition must be observable: the point of
  decomposing is to reach something measurable.
- Mark a child observable only if someone could measure it directly; then give
  measure_cost_usd and a measurement {likelihood, noise, replicates}; otherwise set both
  to null.
- Do not state facts about real vendors, products or prices. Use generic patterns.
Answer with JSON that matches the schema exactly.`;

const ID_RE = /^[a-z][a-z0-9_]*$/;

function toParams(kvs: { name: string; value: number }[], where: string, errors: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name, value } of kvs) {
    if (name in out) errors.push(`${where}: parameter ${name} given twice`);
    out[name] = value;
  }
  return out;
}

export function convertDecomposition(raw: DecompositionOut, target: DecomposeTarget, ctx: DecomposeContext): { ok: true; value: Decomposition } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (raw.children.length > 6) errors.push(`propose at most 6 children (got ${raw.children.length})`);
  const ids = new Set<string>();
  const existing = new Set(ctx.existing_ids);
  const children: ParamNode[] = raw.children.map((c, i) => {
    const where = `children[${i}] (${c.id})`;
    if (!ID_RE.test(c.id)) errors.push(`${where}: id must be snake_case (^[a-z][a-z0-9_]*$)`);
    if (ids.has(c.id)) errors.push(`${where}: duplicate id`);
    if (existing.has(c.id) && !target.required_ids.includes(c.id)) errors.push(`${where}: id already exists in the model`);
    ids.add(c.id);
    const dist: DistSpec = { type: c.distribution.type, params: toParams(c.distribution.params, where, errors) };
    const derr = checkParams(dist, false);
    if (derr) errors.push(`${where}: ${derr}`);
    const node: ParamNode = { id: c.id, parent_ids: [], kind: "sub", distribution: dist, observable: c.observable, unit: c.unit, source: "llm_guess", rationale: `${c.rationale} (proposed by the decomposer agent)` };
    if (c.observable) {
      if (c.measure_cost_usd === null || !(c.measure_cost_usd >= 0)) errors.push(`${where}: observable children need measure_cost_usd >= 0`);
      if (!c.measurement) errors.push(`${where}: observable children need a measurement`);
      else {
        if (!(c.measurement.noise > 0)) errors.push(`${where}: measurement noise must be > 0`);
        if (!(c.measurement.replicates >= 1 && c.measurement.replicates <= 100)) errors.push(`${where}: replicates must be between 1 and 100`);
        node.measurement = { likelihood: c.measurement.likelihood, noise: c.measurement.noise, replicates: c.measurement.replicates };
      }
      node.measure_cost = c.measure_cost_usd ?? 0;
    } else if (c.measure_cost_usd !== null || c.measurement !== null) errors.push(`${where}: unobservable children must set measure_cost_usd and measurement to null`);
    return node;
  });
  for (const req of target.required_ids) if (!ids.has(req)) errors.push(`missing required child ${req}`);
  // Expanding a node only pays off if it opens a measurement; otherwise the planner would
  // keep buying expansions that cannot reduce any uncertainty.
  if (target.kind === "node" && !raw.children.some((c) => c.observable)) errors.push("at least one child must be observable: a decomposition with nothing to measure cannot reduce uncertainty");

  let replace: Decomposition["replace"];
  if (target.kind === "root") {
    if (raw.replace !== null) errors.push("a root is not replaced; set replace to null");
  } else if (raw.replace === null) errors.push("a node decomposition must say how the node is computed (replace)");
  else {
    const r = raw.replace;
    try {
      const vars = freeVars(parse(r.dependency));
      const allowed = new Set([...ids, ...target.inputs]);
      for (const v of vars) if (!allowed.has(v)) errors.push(`replace.dependency uses ${v}, which is neither a child nor an existing input`);
      if (!vars.some((v) => ids.has(v))) errors.push("replace.dependency must use at least one child");
    } catch (e) {
      errors.push(`replace.dependency does not parse: ${(e as Error).message}`);
    }
    if (r.type === "deterministic") {
      if (r.noise !== null) errors.push("deterministic replacements take noise: null");
      replace = { distribution: { type: "deterministic", params: {} }, dependency: r.dependency };
    } else {
      if (r.noise === null || !(r.noise > 0)) errors.push(`${r.type} replacements need noise > 0`);
      replace = { distribution: { type: r.type, params: r.type === "normal" ? { sd: r.noise ?? 0 } : { sigma: r.noise ?? 0 } }, dependency: r.dependency };
    }
  }
  if (errors.length) return { ok: false, errors };
  const dec: Decomposition = { parent: target.id, rationale: `${raw.rationale} (proposed by the decomposer agent)`, children };
  if (replace) dec.replace = replace;
  return { ok: true, value: dec };
}

export function decomposerPrompt(target: DecomposeTarget, ctx: DecomposeContext): string {
  return [
    `<problem>\n${ctx.problem_title}\n${ctx.objectives.map((o) => `- ${o}`).join("\n")}\n</problem>`,
    `<target>\nkind: ${target.kind}\nid: ${target.id}\ndescription: ${target.description}\nunit: ${target.unit ?? "(none)"}\ncurrent prior: ${target.current_prior ?? "(root requirement; no prior)"}\nexisting inputs it may also use: ${target.inputs.join(", ") || "(none)"}\nread by: ${target.read_by.join("; ") || "(nothing yet)"}\n</target>`,
    target.required_ids.length ? `<required_children>\n${target.required_ids.join(", ")}\n</required_children>` : "",
    `<existing_ids>\n${ctx.existing_ids.join(", ")}\n</existing_ids>`,
    `<width_rule>\nFor every child, (q95 - q05) / |(q95 + q05) / 2| of its prior must be at least ${ctx.min_rel_width}.\n</width_rule>`,
    "Propose the decomposition.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function decompose(client: LlmClient, model: string, target: DecomposeTarget, ctx: DecomposeContext, check: (d: Decomposition) => string[]): Promise<{ decomposition: Decomposition; key: string }> {
  const r = await client.ask({
    agent: "decomposer",
    model,
    system: DECOMPOSER_SYSTEM,
    user: decomposerPrompt(target, ctx),
    schema: DecompositionOutSchema,
    max_tokens: 4000,
    accept: (raw) => {
      const conv = convertDecomposition(raw, target, ctx);
      if (!conv.ok) return conv;
      const more = check(conv.value);
      return more.length ? { ok: false, errors: more } : conv;
    },
  });
  return { decomposition: r.value, key: r.key };
}
