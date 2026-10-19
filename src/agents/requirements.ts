// Requirements agent: drafts roots.yaml from problem.yaml. The draft carries an empty
// approval record, which the strict schema refuses, so it cannot be used until a person
// approves it. Code fixes the source tag: a band whose numbers all appear in the
// problem statement is "document"; anything the agent chose itself is "llm_guess".

import { freeVars, parse } from "../core/expr.ts";
import { T, type Static } from "../model/schema.ts";
import type { CatalogFile, ProblemFile, Root, RootsFile } from "../model/types.ts";
import type { LlmClient } from "./llm.ts";
import { numbersIn } from "./prose.ts";

export const RequirementsOutSchema = T.Object({
  roots: T.Array(
    T.Object({
      id: T.String(),
      description: T.String(),
      sense: T.Enum(["upper", "lower", "band"] as const),
      target: T.Number(),
      lower: T.Nullable(T.Number()),
      upper: T.Nullable(T.Number()),
      weight: T.Number(),
      unit: T.String(),
      metric: T.String(),
      rationale: T.String(),
    }),
    { minItems: 1 },
  ),
  drivers: T.Array(T.Object({ id: T.String(), description: T.String() })),
  notes: T.String(),
});
export type RequirementsOut = Static<typeof RequirementsOutSchema>;

export const REQUIREMENTS_SYSTEM = `You are the requirements agent inside an engineering decision engine.
You PROPOSE quantified root requirements from a free-text problem statement. A person
must approve your draft before anything uses it, and code does all scoring.

Rules:
- Two to ten roots, snake_case ids. Each has a sense: "upper" (metric <= upper), "lower"
  (metric >= lower) or "band" (lower <= metric <= upper), a target strictly inside the
  allowed side, and a weight; weights sum to one.
- Use the numbers stated in the problem whenever it states them; when you must choose a
  number yourself, say so in the rationale.
- "metric" is a formula for the metric of a candidate. It may read <dimension>.<attribute>
  for attributes that every option of that dimension has (see the catalog), and plain
  snake_case driver ids for uncertain quantities that are not in the catalog (peak load,
  data volume and the like). List every driver you use in "drivers".
- Formulas use numbers, + - * / ^, min, max, abs, sqrt, exp, log, pow, clamp, if.
- Hard pass/fail properties belong in gates, not roots.
- Do not state facts about real vendors, products or prices.
Answer with JSON that matches the schema exactly.`;

const ID_RE = /^[a-z][a-z0-9_]*$/;

export function sharedAttributes(catalog: CatalogFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of catalog.dimensions) {
    const sets = d.options.map((o) => new Set(Object.keys(o.attributes)));
    out.set(d.id, new Set([...sets[0]].filter((a) => sets.every((s) => s.has(a)))));
  }
  return out;
}

export function convertRequirements(raw: RequirementsOut, problemText: string, catalog: CatalogFile): { ok: true; value: { roots: Root[]; drivers: RequirementsOut["drivers"]; notes: string } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (raw.roots.length < 2 || raw.roots.length > 10) errors.push(`propose two to ten roots (got ${raw.roots.length})`);
  const attrs = sharedAttributes(catalog);
  const drivers = new Set(raw.drivers.map((d) => d.id));
  for (const d of raw.drivers) {
    if (!ID_RE.test(d.id)) errors.push(`driver ${d.id}: id must be snake_case`);
    if (attrs.has(d.id)) errors.push(`driver ${d.id}: collides with a catalog dimension`);
  }
  const stated = new Set(numbersIn(problemText));
  const ids = new Set<string>();
  const usedDrivers = new Set<string>();
  const wsum = raw.roots.reduce((s, r) => s + r.weight, 0);
  if (Math.abs(wsum - 1) > 0.01) errors.push(`weights sum to ${wsum}, not one`);
  const roots: Root[] = raw.roots.map((r, i) => {
    const where = `roots[${i}] (${r.id})`;
    if (!ID_RE.test(r.id)) errors.push(`${where}: id must be snake_case`);
    if (ids.has(r.id)) errors.push(`${where}: duplicate id`);
    ids.add(r.id);
    if (!(r.weight > 0)) errors.push(`${where}: weight must be > 0`);
    if (r.sense === "upper" && !(r.upper !== null && r.lower === null && r.upper > r.target)) errors.push(`${where}: upper roots need upper > target and lower = null`);
    if (r.sense === "lower" && !(r.lower !== null && r.upper === null && r.lower < r.target)) errors.push(`${where}: lower roots need lower < target and upper = null`);
    if (r.sense === "band" && !(r.lower !== null && r.upper !== null && r.lower < r.target && r.target < r.upper)) errors.push(`${where}: band roots need lower < target < upper`);
    try {
      for (const v of freeVars(parse(r.metric))) {
        const dot = v.indexOf(".");
        if (dot > 0) {
          const dim = v.slice(0, dot);
          const attr = v.slice(dot + 1);
          if (!attrs.has(dim)) errors.push(`${where}: metric uses unknown dimension ${dim}`);
          else if (!attrs.get(dim)!.has(attr)) errors.push(`${where}: not every option of ${dim} has attribute ${attr}`);
        } else if (!drivers.has(v)) errors.push(`${where}: metric uses ${v}, which is not listed in drivers`);
        else usedDrivers.add(v);
      }
    } catch (e) {
      errors.push(`${where}: metric does not parse: ${(e as Error).message}`);
    }
    const band = [r.target, r.lower, r.upper].filter((x): x is number => x !== null);
    const root: Root = {
      id: r.id,
      description: r.description,
      sense: r.sense,
      target: r.target,
      weight: r.weight / wsum,
      metric: r.metric,
      unit: r.unit,
      source: band.every((x) => stated.has(x)) ? "document" : "llm_guess",
    };
    if (r.lower !== null) root.lower = r.lower;
    if (r.upper !== null) root.upper = r.upper;
    return root;
  });
  for (const d of drivers) if (!usedDrivers.has(d)) errors.push(`driver ${d} is listed but no metric uses it`);
  return errors.length ? { ok: false, errors } : { ok: true, value: { roots, drivers: raw.drivers, notes: raw.notes } };
}

export function requirementsPrompt(problem: ProblemFile, catalog: CatalogFile): string {
  const attrs = sharedAttributes(catalog);
  return [
    `<problem>\ntitle: ${problem.title}\nobjectives:\n${problem.objectives.map((o) => `- ${o}`).join("\n")}\nconstraints:\n${problem.constraints.map((o) => `- ${o}`).join("\n")}\ngates (already hard filters):\n${problem.gates.map((g) => `- ${g.id}: ${g.description}`).join("\n")}\n</problem>`,
    `<catalog_attributes>\n${[...attrs].map(([d, a]) => `${d}: ${[...a].sort().join(", ")}`).join("\n")}\n</catalog_attributes>`,
    "Draft the root requirements.",
  ].join("\n\n");
}

export async function draftRoots(client: LlmClient, model: string, problem: ProblemFile, problemRaw: string, catalog: CatalogFile): Promise<{ draft: RootsFile; drivers: RequirementsOut["drivers"]; notes: string; key: string }> {
  const r = await client.ask({
    agent: "requirements",
    model,
    system: REQUIREMENTS_SYSTEM,
    user: requirementsPrompt(problem, catalog),
    schema: RequirementsOutSchema,
    max_tokens: 4000,
    accept: (raw) => convertRequirements(raw, problemRaw, catalog),
  });
  const draft: RootsFile = {
    roots: r.value.roots,
    approval: { approved_by: "", approved_at: "", note: `DRAFT from the requirements agent (${model}). A person must review it and fill in approved_by before it can be used.` },
  };
  return { draft, drivers: r.value.drivers, notes: r.value.notes, key: r.key };
}
