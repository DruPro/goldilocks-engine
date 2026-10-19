// Candidate generator: the catalog's Cartesian product, filtered by hard gates.
// Gates are boolean filters on fixed catalog attributes, applied before scoring;
// they never become slacks. (LLM-proposed hybrids arrive in Phase 2.)

import { compile } from "../core/expr.ts";
import type { Candidate, CatalogFile, ProblemFile } from "../model/types.ts";

export interface Pool {
  all: Candidate[];
  passing: Candidate[];
}

export function candidateId(picks: Record<string, string>, dimOrder: string[]): string {
  return dimOrder.map((d) => picks[d]).join("+");
}

export function generateCandidates(catalog: CatalogFile, gates: ProblemFile["gates"], proposed: Set<string> = new Set()): Pool {
  const dims = catalog.dimensions;
  const dimOrder = dims.map((d) => d.id);
  const fixed = new Map<string, number>();
  const ranged = new Set<string>();
  for (const d of dims)
    for (const o of d.options)
      for (const [a, spec] of Object.entries(o.attributes)) {
        if ("value" in spec) fixed.set(`${o.id}.${a}`, spec.value);
        else ranged.add(`${o.id}.${a}`);
      }

  const combos: Record<string, string>[] = [{}];
  for (const d of dims) {
    const next: Record<string, string>[] = [];
    for (const c of combos) for (const o of d.options) next.push({ ...c, [d.id]: o.id });
    combos.splice(0, combos.length, ...next);
  }

  const gateFns = gates.map((g) => ({
    id: g.id,
    fn: (picks: Record<string, string>) =>
      compile<null>(g.formula, (name) => {
        const dot = name.indexOf(".");
        if (dot < 0 || name.includes("@")) throw new Error(`gate ${g.id}: "${name}" is not a <dimension>.<attribute> reference`);
        const dim = name.slice(0, dot);
        const attr = name.slice(dot + 1);
        if (!(dim in picks)) throw new Error(`gate ${g.id}: unknown dimension ${dim}`);
        const key = `${picks[dim]}.${attr}`;
        if (ranged.has(key)) throw new Error(`gate ${g.id}: ${dim}.${attr} is uncertain; gates may only use fixed attributes`);
        if (!fixed.has(key)) throw new Error(`gate ${g.id}: option ${picks[dim]} has no attribute ${attr}`);
        const v = fixed.get(key)!;
        return () => v;
      })(null) !== 0,
  }));

  const all: Candidate[] = combos.map((picks) => {
    const gate_results: Record<string, boolean> = {};
    for (const g of gateFns) gate_results[g.id] = g.fn(picks);
    const origin = Object.values(picks).some((o) => proposed.has(o)) ? ("llm_proposed" as const) : ("catalog" as const);
    return { id: candidateId(picks, dimOrder), picks, origin, gate_results };
  });
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const passing = all.filter((c) => Object.values(c.gate_results).every(Boolean));
  if (passing.length === 0) throw new Error("no catalog candidate passes the hard gates");
  return { all, passing };
}
