// Diff of two briefs (rerun --with): what changed in the answer, and where the two
// runs stopped being identical. Pure functions over report.json and snapshot hashes.

import type { ReportJson } from "./build.ts";

export interface RunDiff {
  changed_inputs: { path: string; before: string | null; after: string }[];
  identical_through_iteration: number | null; // last iteration whose snapshots match (null: none)
  iterations: { before: number; after: number };
  status: { before: string; after: string };
  recommendation: { before: string[]; after: string[]; changed: boolean };
  goldilocks: { added: string[]; removed: string[]; kept: string[] };
  candidates: { id: string; p_before: number | null; p_after: number | null; cost_before: number | null; cost_after: number | null }[];
  binding: { root: string; before: boolean; after: boolean }[];
  posteriors: { node: string; median_before: number | null; median_after: number | null; change: number | null }[];
  next_measurement: { before: string | null; after: string | null };
  llm_guess_share: { before: number; after: number };
}

export function firstDivergence(a: Record<number, string>, b: Record<number, string>): number | null {
  let last: number | null = null;
  for (let k = 0; ; k++) {
    if (a[k] === undefined || b[k] === undefined || a[k] !== b[k]) return last;
    last = k;
  }
}

export type Scores = Map<string, { P: number; cost_mean: number }>;

export function diffReports(before: ReportJson, after: ReportJson, changed: RunDiff["changed_inputs"], snapsBefore: Record<number, string>, snapsAfter: Record<number, string>, scoresBefore: Scores, scoresAfter: Scores): RunDiff {
  const gb = new Set(before.goldilocks.G);
  const ga = new Set(after.goldilocks.G);
  const ids = [...new Set([...gb, ...ga, ...before.recommended.map((r) => r.id), ...after.recommended.map((r) => r.id)])].sort();
  const candidates = ids.map((id) => {
    const b = scoresBefore.get(id);
    const a = scoresAfter.get(id);
    return { id, p_before: b?.P ?? null, p_after: a?.P ?? null, cost_before: b?.cost_mean ?? null, cost_after: a?.cost_mean ?? null };
  });
  const bindB = new Map(before.requirements.relaxations.map((x) => [x.root, x.binding]));
  const bindA = new Map(after.requirements.relaxations.map((x) => [x.root, x.binding]));
  const binding = [...new Set([...bindB.keys(), ...bindA.keys()])].sort().filter((r) => bindB.get(r) !== bindA.get(r)).map((r) => ({ root: r, before: bindB.get(r) ?? false, after: bindA.get(r) ?? false }));
  const medB = new Map(before.ledger.map((l) => [l.id, l.posterior_q[1]]));
  const medA = new Map(after.ledger.map((l) => [l.id, l.posterior_q[1]]));
  const posteriors = [...new Set([...medB.keys(), ...medA.keys()])]
    .sort()
    .map((node) => {
      const b = medB.get(node) ?? null;
      const a = medA.get(node) ?? null;
      const change = b !== null && a !== null && b !== 0 ? a / b - 1 : null;
      return { node, median_before: b, median_after: a, change };
    })
    .filter((x) => x.change === null || Math.abs(x.change) > 0.01);
  return {
    changed_inputs: changed,
    identical_through_iteration: firstDivergence(snapsBefore, snapsAfter),
    iterations: { before: before.iteration, after: after.iteration },
    status: { before: before.status, after: after.status },
    recommendation: { before: before.recommended.map((r) => r.id), after: after.recommended.map((r) => r.id), changed: before.recommended[0]?.id !== after.recommended[0]?.id },
    goldilocks: { added: [...ga].filter((x) => !gb.has(x)).sort(), removed: [...gb].filter((x) => !ga.has(x)).sort(), kept: [...ga].filter((x) => gb.has(x)).sort() },
    candidates,
    binding,
    posteriors,
    next_measurement: { before: before.next_measurements[0]?.node ?? null, after: after.next_measurements[0]?.node ?? null },
    llm_guess_share: { before: before.llm_guess.evppi_share, after: after.llm_guess.evppi_share },
  };
}

const n = (x: number | null, d = 3) => (x === null ? "–" : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d));

export function diffSummary(d: RunDiff): string {
  const parts = [
    `changed: ${d.changed_inputs.map((c) => c.path).join(", ") || "nothing"}`,
    d.identical_through_iteration === null ? "diverges from iteration 0" : `identical through iteration ${d.identical_through_iteration}`,
    d.recommendation.changed ? `recommendation ${d.recommendation.before[0] ?? "none"} → ${d.recommendation.after[0] ?? "none"}` : `recommendation unchanged (${d.recommendation.after[0] ?? "none"})`,
    `G +${d.goldilocks.added.length} −${d.goldilocks.removed.length}`,
  ];
  return parts.join("; ");
}

export function diffMarkdown(d: RunDiff, before: string, after: string): string {
  const o: string[] = [];
  o.push(`# Rerun diff: ${before} → ${after}`);
  o.push("");
  o.push(`- ${diffSummary(d)}`);
  o.push(`- status ${d.status.before} (iteration ${d.iterations.before}) → ${d.status.after} (iteration ${d.iterations.after})`);
  o.push(`- next measurement ${d.next_measurement.before ?? "none"} → ${d.next_measurement.after ?? "none"}`);
  o.push(`- llm_guess share of EVPPI ${(100 * d.llm_guess_share.before).toFixed(1)}% → ${(100 * d.llm_guess_share.after).toFixed(1)}%`);
  o.push("");
  o.push("## Changed inputs");
  for (const c of d.changed_inputs) o.push(`- ${c.path}: ${c.before ? c.before.slice(0, 12) : "(new)"} → ${c.after.slice(0, 12)}`);
  o.push("");
  o.push("## Goldilocks set");
  o.push(`- added: ${d.goldilocks.added.map((x) => `\`${x}\``).join(", ") || "none"}`);
  o.push(`- removed: ${d.goldilocks.removed.map((x) => `\`${x}\``).join(", ") || "none"}`);
  o.push(`- kept: ${d.goldilocks.kept.length}`);
  o.push("");
  o.push("## Candidates in either set");
  o.push("| candidate | P before | P after | mean spend before | after |");
  o.push("| --- | --- | --- | --- | --- |");
  for (const c of d.candidates) if (c.p_before !== null || c.p_after !== null) o.push(`| \`${c.id}\` | ${n(c.p_before)} | ${n(c.p_after)} | ${n(c.cost_before)} | ${n(c.cost_after)} |`);
  o.push("");
  o.push("## Roots whose binding status changed");
  o.push(d.binding.length ? d.binding.map((b) => `- ${b.root}: ${b.before ? "binding" : "slack"} → ${b.after ? "binding" : "slack"}`).join("\n") : "- none");
  o.push("");
  o.push("## Posterior medians that moved by more than 1%");
  o.push(d.posteriors.length ? d.posteriors.map((p) => `- ${p.node}: ${n(p.median_before)} → ${n(p.median_after)}${p.change === null ? "" : ` (${(100 * p.change).toFixed(1)}%)`}`).join("\n") : "- none");
  return o.join("\n") + "\n";
}
