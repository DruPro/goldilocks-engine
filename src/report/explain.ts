// Builds the explainer's context from report.json: section facts written with
// placeholder names, and a table of placeholder values formatted by code. The
// agent's text comes back with placeholders, and code fills them in.

import { explain, type ExplainContext, type Section } from "../agents/explainer.ts";
import type { LlmClient } from "../agents/llm.ts";
import { renderProse } from "../agents/prose.ts";
import type { ReportJson } from "./build.ts";

const f3 = (x: number | null) => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(3));
const f0 = (x: number | null) => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(0));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const ORDINAL = ["First", "Second", "Third"];

export function explainContext(r: ReportJson): ExplainContext {
  const v: Record<string, string> = {
    tau: String(r.settings.tau),
    epsilon: String(r.settings.epsilon),
    g_size: String(r.goldilocks.G.length),
    qualified_count: String(r.goldilocks.qualified),
    cheapest_cost: f0(r.goldilocks.cheapest_cost),
    families_count: String(r.solution_map.families.length),
    fpca_pc1: pct(r.solution_map.fpca.explained[0] ?? 0),
    fpca_pc2: pct(r.solution_map.fpca.explained[1] ?? 0),
    llm_guess_count: String(r.llm_guess.nodes.length),
    llm_guess_evppi_share: pct(r.llm_guess.evppi_share),
    binding_count: String(r.requirements.relaxations.filter((x) => x.binding).length),
    slack_count: String(r.requirements.relaxations.filter((x) => !x.binding).length),
  };
  const recFacts = r.recommended.map((rec, i) => {
    const k = `rec${i + 1}`;
    v[`${k}_p`] = f3(rec.p_zone);
    v[`${k}_p_lo`] = f3(rec.p_interval[0]);
    v[`${k}_p_hi`] = f3(rec.p_interval[1]);
    v[`${k}_cost`] = f0(rec.cost_q[1]);
    const tight = [...rec.metrics].sort((a, b) => a.slack_q[0] - b.slack_q[0])[0];
    return `${ORDINAL[i]} pick: ${rec.id}, P(in zone) {{${k}_p}} (interval {{${k}_p_lo}} to {{${k}_p_hi}}), median spend {{${k}_cost}} USD/month; its tightest root in a bad case: ${tight.root}.`;
  });
  r.solution_map.families.forEach((fam) => (v[`family${fam.id + 1}_size`] = String(fam.members.length)));
  const nextFacts = r.next_measurements.slice(0, 3).map((n, i) => {
    const k = `next${i + 1}`;
    v[`${k}_evppi`] = f0(n.evppi);
    v[`${k}_cost`] = f0(n.cost);
    v[`${k}_score`] = n.score.toFixed(2);
    return `${ORDINAL[i]} most valuable action: ${n.action} ${n.node}, EVPPI {{${k}_evppi}} USD against a cost of {{${k}_cost}} USD (ratio {{${k}_score}}).`;
  });
  const facts: Record<Section, string> = {
    recommended: [`Goldilocks set: {{g_size}} candidates; {{qualified_count}} reach P >= {{tau}}; cheapest qualifying spend {{cheapest_cost}} USD/month; the cost band is one plus {{epsilon}} times that.`, ...recFacts].join("\n"),
    solution_map: [
      `{{families_count}} families of P(in zone) curves along the volume axis; the first two components explain {{fpca_pc1}} and {{fpca_pc2}}.`,
      ...r.solution_map.families.map((fam) => `F${fam.id + 1}: {{family${fam.id + 1}_size}} candidates; ${fam.in_goldilocks ? "contains a Goldilocks pick" : `rejected, most binding ${fam.most_binding}`}.`),
    ].join("\n"),
    requirements: [
      `{{binding_count}} binding roots and {{slack_count}} roots with slack.`,
      ...r.requirements.relaxations.map((x) => `${x.root}: ${x.binding ? "binding" : "slack"}; relaxing it admits ${x.admits.length ? x.admits.slice(0, 3).join(", ") : "nothing new"}.`),
      ...r.upward.filter((u) => u.at_risk).map((u) => `${u.root} is at risk; culprits ${u.culprits.map((c) => c.node).join(", ")}.`),
    ].join("\n"),
    ledger: [
      `{{llm_guess_count}} parameters rest on llm_guess priors and carry {{llm_guess_evppi_share}} of the total EVPPI.`,
      ...r.llm_guess.cases.map((c) => `${c.scenario}: recommendation ${c.recommended[0] ?? "none"}.`),
    ].join("\n"),
    next_measurements: [...nextFacts, ...r.flips.slice(0, 3).map((fl) => `If ${fl.node} lies in its bin, the pick becomes ${fl.pick ?? "nothing"}.`)].join("\n") || "No measurement is worth its cost.",
  };
  const ids = [
    ...r.ledger.map((l) => l.id),
    ...r.requirements.roots.map((x) => x.id),
    ...Object.keys(r.solution_map.assignment),
    ...r.recommended.map((x) => x.id),
    ...r.solution_map.families.map((fam) => `F${fam.id + 1}`),
  ];
  return { title: r.title, facts, values: v, ids };
}

export async function addExplanations(r: ReportJson, client: LlmClient, model: string): Promise<void> {
  const ctx = explainContext(r);
  const res = await explain(client, model, ctx);
  const texts: Partial<Record<Section, string>> = {};
  for (const [s, t] of Object.entries(res.texts)) texts[s as Section] = renderProse(t!, ctx.values);
  r.explanations = { model, request: res.key, texts };
}
