// report.md: a plain rendering of report.json. Every number is formatted from the
// JSON; nothing is computed or reordered here.

import type { Section } from "../agents/explainer.ts";
import type { ReportJson } from "./build.ts";

const n = (x: number | null | undefined, d = 2): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
  return x.toFixed(a >= 100 ? 0 : d);
};
const q3 = (q: number[]) => `${n(q[0])} / ${n(q[1])} / ${n(q[2])}`;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** LLM prose, clearly labelled; every number in it was filled in by code. */
function explanation(o: string[], r: ReportJson, key: Section): void {
  const t = r.explanations?.texts[key];
  if (!t) return;
  o.push("");
  o.push(`> **Explanation** (written by ${r.explanations!.model}; numbers filled in by code)  `);
  o.push(`> ${t.replace(/\n+/g, " ")}`);
  o.push("");
}

export function reportMarkdown(r: ReportJson): string {
  const o: string[] = [];
  o.push(`# ${r.title}`);
  o.push("");
  o.push(`Status **${r.status}** after iteration ${r.iteration}. τ = ${r.settings.tau}, ε = ${r.settings.epsilon}, β = ${r.settings.beta}, ${r.settings.particles} particles (ESS ${n(r.settings.ess, 0)}), zone rule \`${r.settings.zone_rule}\`.`);
  o.push("");
  o.push("> Every input number in this run is illustrative (fixture data). Option names are generic patterns, not vendors.");
  o.push("");

  o.push("## 1. Recommended solutions");
  explanation(o, r, "recommended");
  if (r.recommended.length === 0) o.push("No candidate reaches the zone with probability τ; see section 3 for the relaxations that would admit one.");
  for (const [i, rec] of r.recommended.entries()) {
    o.push("");
    o.push(`### ${i + 1}. \`${rec.id}\``);
    o.push(`P(in zone) **${n(rec.p_zone, 3)}** (90% Monte Carlo interval ${n(rec.p_interval[0], 3)}–${n(rec.p_interval[1], 3)}); spend q05/q50/q95 ${q3(rec.cost_q)} USD/month.`);
    o.push("");
    o.push(table(["root", "metric q05 / q50 / q95", "unit", "slack q05 / q50 / q95"], rec.metrics.map((m) => [m.root, q3(m.q), m.unit ?? "", q3(m.slack_q)])));
  }
  o.push("");
  o.push(`Goldilocks set (${r.goldilocks.G.length}): ${r.goldilocks.G.map((g) => `\`${g}\``).join(", ") || "empty"}. ${r.goldilocks.qualified} candidates reach P ≥ τ; the cheapest costs ${n(r.goldilocks.cheapest_cost)} USD/month.`);

  o.push("");
  o.push("## 2. Solution map");
  explanation(o, r, "solution_map");
  const m = r.solution_map;
  o.push(`${m.families.length} families (k chosen by silhouette${m.silhouette === null ? ", degenerate curves" : ` = ${n(m.silhouette, 3)}`}). FPCA explains ${m.fpca.explained.map(pct).join(" + ")} of curve variance. Axis multipliers: ${m.multipliers.join(", ")}.`);
  o.push("");
  o.push("![FPCA solution map](fpca.svg)");
  o.push("");
  o.push(table(["family", "members", "status", "most-binding constraint", "mean P(in zone) along the axis"], m.families.map((f) => [`F${f.id + 1}`, String(f.members.length), f.in_goldilocks ? "has Goldilocks pick" : "rejected", f.most_binding ?? "–", f.mean_curve.map((v) => n(v, 2)).join(" → ")])));

  o.push("");
  o.push("## 3. Minimum requirements");
  explanation(o, r, "requirements");
  o.push(table(["root", "band", "weight", "binding?", `relax by ${r.requirements.relaxations[0]?.step ?? 0.25} slack units admits`, "cheapest after", "restores non-empty G at"], r.requirements.relaxations.map((x) => {
    const root = r.requirements.roots.find((y) => y.id === x.root)!;
    const band = root.sense === "upper" ? `≤ ${root.upper} (target ${root.target})` : root.sense === "lower" ? `≥ ${root.lower} (target ${root.target})` : `[${root.lower}, ${root.upper}]`;
    return [x.root, band, n(root.weight), x.binding ? "**binding**" : "slack", x.admits.length ? `${x.admits.length}: ${x.admits.slice(0, 3).map((a) => `\`${a}\``).join(", ")}${x.admits.length > 3 ? " …" : ""}` : "none", n(x.cheapest_after), x.restore_metric === null ? "–" : `+${n(x.restore_metric)}`];
  })));
  if (r.requirements.conflicts.length) o.push(`\nConflicting roots: ${r.requirements.conflicts.map(([a, b]) => `${a} × ${b}`).join("; ")}.`);
  const risk = r.upward.filter((u) => u.at_risk);
  o.push("");
  o.push(risk.length ? `Roots at risk (upward evidence): ${risk.map((u) => `${u.root} (best P ${n(u.best_p, 3)}; culprits ${u.culprits.map((c) => `${c.node} ${pct(c.mass_outside)} outside`).join(", ")})`).join("; ")}.` : "No root is at risk: each one is satisfiable on its own with probability ≥ τ.");

  o.push("");
  o.push("## 4. Parameter ledger");
  explanation(o, r, "ledger");
  o.push(table(["node", "source", "obs?", "measured", "prior q05 / q50 / q95", "posterior q05 / q50 / q95", "EVPPI (USD)", "EVPPI/cost"], r.ledger.map((l) => [l.id, l.source, l.observable ? "yes" : "no", String(l.measured), q3(l.prior_q), q3(l.posterior_q), n(l.evppi, 0), n(l.score, 2)])));
  o.push("");
  const g = r.llm_guess;
  o.push(`**Dependence on llm_guess priors.** ${g.nodes.length} llm_guess nodes carry ${pct(g.evppi_share)} of total EVPPI. Reweighting the posterior under alternative priors for them:`);
  o.push("");
  o.push(table(["scenario", "ESS", "recommendation", "Jaccard(G) vs base", "P(base pick)"], g.cases.map((c) => [c.scenario, n(c.ess, 0), c.recommended[0] ? `\`${c.recommended[0]}\`` : "none", n(c.jaccard_vs_base, 2), n(c.p_of_base_pick, 3)])));

  o.push("");
  o.push("## 5. Next measurements");
  explanation(o, r, "next_measurements");
  o.push(table(["node", "action", "EVPPI (USD)", "cost (USD)", "EVPPI/cost"], r.next_measurements.map((x) => [x.node, x.action, n(x.evppi, 0), n(x.cost, 0), n(x.score, 2)])));
  o.push("");
  if (r.flips.length) {
    o.push("What would flip the recommendation:");
    for (const f of r.flips) o.push(`- if **${f.node}** is in [${n(f.lo)}, ${n(f.hi)}] (${pct(f.mass)} of posterior mass), the pick becomes ${f.pick ? `\`${f.pick}\`` : "nothing (empty set)"}`);
  } else o.push("No single bin of a top-EVPPI parameter changes the recommendation.");

  o.push("");
  o.push("## 6. Audit trail");
  o.push(`- Run \`${r.audit.run_id}\`, manifest SHA-256 \`${r.audit.manifest_sha256}\``);
  o.push(`- Events: [${r.audit.events}](${r.audit.events}); final snapshot \`${r.audit.final_snapshot}\``);
  o.push(`- Iterations: ${r.history.map((h) => `${h.iter}:${h.action.kind}${h.action.node ? `(${h.action.node})` : ""}`).join(" → ")}`);
  if (r.flags.length) {
    o.push("");
    o.push("Critic flags:");
    for (const f of r.flags) o.push(`- [${f.severity}] ${f.message}`);
  }
  const ag = r.agents;
  if (ag.decompositions.length || ag.options.length) {
    o.push("");
    o.push("Accepted agent proposals (checked by code before use):");
    for (const d of ag.decompositions) o.push(`- decomposition of ${d.parent} into ${d.children.map((c) => c.id).join(", ")}`);
    for (const p of ag.options) o.push(`- hybrid option ${p.option.id} in ${p.dimension}, a variant of ${p.based_on}`);
  }
  if (r.advice) {
    const a = r.advice;
    o.push("");
    o.push(`Critic advice (written by ${a.model} at iteration ${a.iter}; advisory only, it cannot change any result):`);
    o.push(`- ${a.advice.summary}`);
    for (const c of a.advice.concerns) o.push(`- ${c.flag}: ${c.explanation} Suggestion: ${c.suggestion}`);
    for (const m of a.advice.missing_parameters) o.push(`- possibly missing: ${m.name} (under ${m.attach_to}): ${m.why}`);
  }
  return o.join("\n") + "\n";
}
