// Hybrid proposals for the generator, asked for only when G is empty or every member
// sits within 0.05 of τ. A hybrid is a variant of an existing catalog option: it
// inherits every fixed attribute of its base option (so it cannot claim to pass a
// gate or to cost less by assertion) and may only re-estimate ranged attributes,
// which become wide llm_guess priors. Code scores, ranks and selects as usual.

import { T, type Static } from "../model/schema.ts";
import type { CatalogFile } from "../model/types.ts";
import type { LlmClient } from "./llm.ts";

export const HybridOutSchema = T.Object({
  options: T.Array(
    T.Object({
      dimension: T.String(),
      based_on: T.String(),
      id: T.String(),
      label: T.String(),
      rationale: T.String(),
      overrides: T.Array(T.Object({ attribute: T.String(), lo: T.Number(), hi: T.Number(), dist: T.Enum(["uniform", "lognormal"] as const) }), { minItems: 1 }),
    }),
    { minItems: 1 },
  ),
});
export type HybridOut = Static<typeof HybridOutSchema>;

type CatalogOption = CatalogFile["dimensions"][number]["options"][number];

export interface ProposedOption {
  dimension: string;
  based_on: string;
  rationale: string;
  option: CatalogOption;
}

export const HYBRIDS_SYSTEM = `You are the hybrid-proposal agent inside an engineering decision engine.
No catalog combination currently reaches the target confidence comfortably, so you may
PROPOSE up to three new option variants. Code decides whether any of them is used.

Rules:
- Each proposal is a variant of one existing option ("based_on") in the same dimension.
  It inherits all of that option's fixed attributes unchanged.
- You may only re-estimate ranged attributes of the base option ("overrides"), giving a
  new range [lo, hi] and a dist (uniform, or lognormal where the range is a 90% interval).
  Your ranges are guesses tagged llm_guess, so keep them honestly wide (see the width rule).
- New ids are snake_case and must not collide with existing option ids.
- Explain the engineering idea behind each variant in "rationale" without numbers.
- Do not state facts about real vendors, products or prices. Use generic patterns.
Answer with JSON that matches the schema exactly.`;

const ID_RE = /^[a-z][a-z0-9_]*$/;

export function convertHybrids(raw: HybridOut, catalog: CatalogFile, minRelWidth: number): { ok: true; value: ProposedOption[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (raw.options.length > 3) errors.push(`propose at most 3 options (got ${raw.options.length})`);
  const taken = new Set(catalog.dimensions.flatMap((d) => d.options.map((o) => o.id)));
  const out: ProposedOption[] = [];
  raw.options.forEach((p, i) => {
    const where = `options[${i}] (${p.id})`;
    const dim = catalog.dimensions.find((d) => d.id === p.dimension);
    if (!dim) return void errors.push(`${where}: unknown dimension ${p.dimension}`);
    const base = dim.options.find((o) => o.id === p.based_on);
    if (!base) return void errors.push(`${where}: ${p.based_on} is not an option of ${p.dimension}`);
    if (!ID_RE.test(p.id)) errors.push(`${where}: id must be snake_case`);
    if (taken.has(p.id)) errors.push(`${where}: option id already exists`);
    taken.add(p.id);
    if (/\d/.test(p.rationale)) errors.push(`${where}: rationale must not contain numbers`);
    const attributes: CatalogOption["attributes"] = structuredClone(base.attributes);
    const seen = new Set<string>();
    for (const o of p.overrides) {
      const spec = base.attributes[o.attribute];
      if (seen.has(o.attribute)) errors.push(`${where}: ${o.attribute} overridden twice`);
      seen.add(o.attribute);
      if (!spec) {
        errors.push(`${where}: ${p.based_on} has no attribute ${o.attribute}`);
        continue;
      }
      if ("value" in spec) {
        errors.push(`${where}: ${o.attribute} is a fixed attribute of ${p.based_on} and cannot be overridden`);
        continue;
      }
      if (!(o.hi > o.lo)) errors.push(`${where}: ${o.attribute} needs hi > lo`);
      if (o.dist === "lognormal" && !(o.lo > 0)) errors.push(`${where}: ${o.attribute} lognormal range must be positive`);
      const rel = (o.hi - o.lo) / Math.max(1e-12, Math.abs((o.hi + o.lo) / 2));
      const width = o.dist === "uniform" ? 0.9 * rel : rel; // uniform: the 90% interval is 90% of the range
      if (width < minRelWidth) errors.push(`${where}: ${o.attribute} range is too narrow for an llm_guess (relative width ${width.toFixed(2)} < ${minRelWidth})`);
      attributes[o.attribute] = { ...spec, range: [o.lo, o.hi], dist: o.dist, source: "llm_guess", rationale: `hybrid estimate: ${p.rationale}` };
    }
    out.push({ dimension: p.dimension, based_on: p.based_on, rationale: p.rationale, option: { id: p.id, label: `${p.label} (LLM-proposed variant of ${p.based_on})`, attributes } });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export interface HybridContext {
  catalog: CatalogFile;
  roots: { id: string; description: string; band: string }[];
  status: string; // why hybrids were requested
  top: { id: string; p: number; binding: string }[];
  min_rel_width: number;
}

export function hybridsPrompt(c: HybridContext): string {
  const cat = c.catalog.dimensions
    .map(
      (d) =>
        `${d.id} (${d.label}):\n` +
        d.options
          .map((o) => `  - ${o.id}: ${o.label}; ` + Object.entries(o.attributes).map(([k, a]) => ("value" in a ? `${k}=${a.value}` : `${k}~[${a.range[0]}, ${a.range[1]}]`)).join(", "))
          .join("\n"),
    )
    .join("\n");
  return [
    `<status>\n${c.status}\n</status>`,
    `<requirements>\n${c.roots.map((r) => `- ${r.id}: ${r.description} (${r.band})`).join("\n")}\n</requirements>`,
    `<closest_candidates>\n${c.top.map((t) => `- ${t.id}: P(in zone)=${t.p.toFixed(3)}, most binding: ${t.binding}`).join("\n")}\n</closest_candidates>`,
    `<catalog>\n${cat}\n</catalog>`,
    `<width_rule>\nEach overridden range needs (hi - lo) / |(hi + lo) / 2| of at least ${c.min_rel_width} (uniform ranges count 90% of their width).\n</width_rule>`,
    "Propose up to three variants that could relieve the most binding requirements.",
  ].join("\n\n");
}

export async function proposeHybrids(client: LlmClient, model: string, c: HybridContext): Promise<{ options: ProposedOption[]; key: string }> {
  const r = await client.ask({
    agent: "hybrids",
    model,
    system: HYBRIDS_SYSTEM,
    user: hybridsPrompt(c),
    schema: HybridOutSchema,
    max_tokens: 2500,
    accept: (raw) => convertHybrids(raw, c.catalog, c.min_rel_width),
  });
  return { options: r.value, key: r.key };
}
