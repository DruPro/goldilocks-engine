import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Streams } from "../src/core/rng.ts";
import { wquantiles } from "../src/core/stats.ts";
import { treeInputs } from "../src/engine/loop.ts";
import { drawPrior } from "../src/engine/updater.ts";
import { loadInputs } from "../src/model/load.ts";
import { errorsOf, jsonSchema } from "../src/model/schema.ts";
import { buildModel } from "../src/model/tree.ts";
import { ALL_SCHEMAS, CandidateSchema, EvidenceSchema, ParamNodeSchema } from "../src/model/types.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/cloud");

describe("schemas", () => {
  test("every fixture file validates and every number is marked illustrative", () => {
    const inp = loadInputs(FIXTURE);
    expect(inp.files.length).toBeGreaterThanOrEqual(7);
    for (const f of inp.files) expect(f.raw).toMatch(/illustrative/i);
  });

  test("strict validation rejects malformed records", () => {
    const ev = { id: "e1", target_node: "peak_tps", observation: { values: [1] }, likelihood: "normal", noise: 1, source: "measured", approved_by: "x" };
    expect(errorsOf(EvidenceSchema, ev)).toEqual([]);
    expect(errorsOf(EvidenceSchema, { ...ev, approved_by: undefined }).join()).toMatch(/approved_by/);
    expect(errorsOf(EvidenceSchema, { ...ev, extra: 1 }).join()).toMatch(/unknown key "extra"/);
    expect(errorsOf(EvidenceSchema, { ...ev, source: "vibes" }).join()).toMatch(/measured\|document\|expert\|llm_guess/);
    expect(errorsOf(EvidenceSchema, { ...ev, noise: 0 }).join()).toMatch(/must be > 0/);
    expect(errorsOf(EvidenceSchema, { ...ev, observation: { k: 3 } }).join()).toMatch(/none of 3 alternatives/);
    const node = { id: "a@b", parent_ids: [], kind: "sub", distribution: { type: "normal", params: { mean: 0, sd: 1 } }, observable: false, source: "expert", rationale: "" };
    expect(errorsOf(ParamNodeSchema, node)).toEqual([]);
    expect(errorsOf(ParamNodeSchema, { ...node, id: "bad id" }).join()).toMatch(/does not match/);
    expect(errorsOf(ParamNodeSchema, { ...node, distribution: { type: "cauchy", params: {} } }).join()).toMatch(/one of/);
    expect(errorsOf(CandidateSchema, { id: "x", picks: { store: "kv_log" }, origin: "llm", gate_results: {} }).join()).toMatch(/catalog\|llm_proposed/);
  });

  test("JSON Schemas are emitted from the same definitions", () => {
    for (const [name, s] of Object.entries(ALL_SCHEMAS)) {
      const js = jsonSchema(s, name, name);
      expect(js.$schema).toContain("json-schema.org");
    }
    const pn = jsonSchema(ParamNodeSchema, "p", "p") as Record<string, unknown>;
    expect(pn.additionalProperties).toBe(false);
    expect((pn.required as string[]).sort()).toEqual(["distribution", "id", "kind", "observable", "parent_ids", "rationale", "source"]);
  });
});

describe("parameter tree", () => {
  test("expanding a node leaves its prior marginal unchanged (fixture design)", () => {
    const ti = treeInputs(loadInputs(FIXTURE));
    const collapsed = buildModel(ti, []);
    const expanded = buildModel(ti, ["ledger_entries_m", "net_rtt_ms"]);
    const s = new Streams(5);
    const a = drawPrior(collapsed, 20000, s.get("a"));
    const b = drawPrior(expanded, 20000, s.get("b"));
    for (const id of ["ledger_entries_m", "net_rtt_ms"]) {
      const q = (m: typeof collapsed, P: typeof a) => {
        const xs = new Float64Array(P.N);
        for (let p = 0; p < P.N; p++) xs[p] = P.vals[p * m.nV + m.node(id).index];
        return wquantiles(xs, P.w, [0.05, 0.5, 0.95]);
      };
      const qa = q(collapsed, a);
      const qb = q(expanded, b);
      for (let i = 0; i < 3; i++) expect(Math.abs(qa[i] / qb[i] - 1)).toBeLessThan(0.05);
    }
    expect(expanded.node("net_rtt_ms").spec.parent_ids).toEqual(["client_rtt_ms", "edge_overhead"]);
    expect(expanded.expandable.size).toBe(0);
  });

  test("cycles, unknown parents and narrow llm_guess priors are refused", () => {
    const ti = treeInputs(loadInputs(FIXTURE));
    const bad = structuredClone(ti);
    bad.decompositions[0].children[0].parent_ids = ["net_rtt_ms"];
    bad.decompositions[0].children[0].dependency = "net_rtt_ms";
    bad.decompositions[0].children[1].parent_ids = ["peak_tps"];
    bad.decompositions[0].children[1].dependency = "peak_tps";
    bad.decompositions[0].children[0].distribution = { type: "lognormal", params: { sigma: 0.1 } };
    bad.decompositions[0].children[1].distribution = { type: "lognormal", params: { sigma: 0.1 } };
    expect(() => buildModel(bad, [])).toThrow(/cycle/);
    const unknown = structuredClone(ti);
    unknown.decompositions[0].children[0].parent_ids = ["nope"];
    expect(() => buildModel(unknown, [])).toThrow(/unknown parent nope/);
  });
});
