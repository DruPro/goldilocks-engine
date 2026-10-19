// Phase 2 unit tests: the schema gate, retries, cache modes, prose guard and each
// agent's semantic checks. No network: transports are scripted.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDecomposition, type DecompositionOut } from "../src/agents/decomposer.ts";
import { convertEvidence } from "../src/agents/evidence.ts";
import { convertHybrids } from "../src/agents/hybrids.ts";
import { LlmCache, LlmClient, LlmRejectedError, MAX_ATTEMPTS, offlineTransport, scriptedTransport, toApiSchema, type LlmEvent } from "../src/agents/llm.ts";
import { checkProse, renderProse } from "../src/agents/prose.ts";
import { convertRequirements } from "../src/agents/requirements.ts";
import { loadInputs } from "../src/model/load.ts";
import { T } from "../src/model/schema.ts";
import { ParamNodeSchema } from "../src/model/types.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/cloud");
const Out = T.Object({ answer: T.Integer({ minimum: 0, maximum: 10 }) });
const spec = (user = "question") => ({
  agent: "test",
  model: "claude-sonnet-5-5",
  system: "sys",
  user,
  schema: Out,
  max_tokens: 100,
  accept: (raw: { answer: number }) => (raw.answer % 2 === 0 ? { ok: true as const, value: raw.answer } : { ok: false as const, errors: ["answer must be even"] }),
});
const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), "gde-llm-"));
  return { run: join(d, "run"), shared: join(d, "shared") };
};

describe("LLM client", () => {
  test("valid answer is cached; the same request never reaches the network twice", async () => {
    const d = dirs();
    const t = scriptedTransport(() => ({ answer: 4 }));
    const c = new LlmClient(t, new LlmCache(d.run, d.shared, "run"));
    expect((await c.ask(spec())).value).toBe(4);
    expect((await c.ask(spec())).value).toBe(4);
    expect(t.calls.length).toBe(1);
    // A second run (new run folder, same shared store) is served from the shared cache.
    const t2 = scriptedTransport(() => ({ answer: 6 }));
    const c2 = new LlmClient(t2, new LlmCache(join(d.run, "..", "run2"), d.shared, "run"));
    expect((await c2.ask(spec())).value).toBe(4);
    expect(t2.calls.length).toBe(0);
    // --fresh ignores the shared store.
    const t3 = scriptedTransport(() => ({ answer: 8 }));
    const c3 = new LlmClient(t3, new LlmCache(join(d.run, "..", "run3"), d.shared, "fresh"));
    expect((await c3.ask(spec())).value).toBe(8);
  });

  test("schema-invalid and rule-breaking answers are retried with the errors, then accepted", async () => {
    const d = dirs();
    const answers = ["not json", { answer: 99 }, { answer: 2 }];
    const t = scriptedTransport((_r, n) => answers[n - 1]);
    const events: LlmEvent[] = [];
    const c = new LlmClient(t, new LlmCache(d.run, d.shared, "run"), (e) => events.push(e));
    expect((await c.ask(spec())).value).toBe(2);
    expect(events.map((e) => e.valid)).toEqual([false, false, true]);
    expect(events[0].errors.join()).toMatch(/not valid JSON/);
    expect(events[1].errors.join()).toMatch(/maximum 10/);
    expect(t.calls[1].user).toContain("<validation_errors>");
  });

  test("after two retries the client fails loudly", async () => {
    const d = dirs();
    const t = scriptedTransport(() => ({ answer: 3 }));
    const c = new LlmClient(t, new LlmCache(d.run, d.shared, "run"));
    await expect(c.ask(spec())).rejects.toBeInstanceOf(LlmRejectedError);
    expect(t.calls.length).toBe(MAX_ATTEMPTS);
  });

  test("replay reads only the run's own cache and never the network", async () => {
    const d = dirs();
    const t = scriptedTransport(() => ({ answer: 4 }));
    await new LlmClient(t, new LlmCache(d.run, d.shared, "run")).ask(spec());
    const replay = new LlmClient(offlineTransport, new LlmCache(d.run, null, "replay"));
    expect((await replay.ask(spec())).value).toBe(4);
    await expect(replay.ask(spec("a different question"))).rejects.toThrow(/no network in replay/);
  });

  test("API schemas drop unsupported bounds and refuse open records", () => {
    const api = toApiSchema(Out.json) as { properties: { answer: Record<string, unknown> } };
    expect(api.properties.answer.minimum).toBeUndefined();
    expect(() => toApiSchema(ParamNodeSchema.json)).toThrow(/open records/);
  });
});

describe("prose guard", () => {
  test("numbers must come from placeholders; ids with digits are fine", () => {
    const ids = ["verify_p99_ms", "vms+kv_log+kms+sync+merkle"];
    expect(checkProse("t", "Pick `vms+kv_log+kms+sync+merkle`: P is {{p}} and verify_p99_ms has slack.", { ids, placeholders: ["p"], maxLength: 500 })).toEqual([]);
    expect(checkProse("t", "P is 0.99", { ids, maxLength: 500 }).join()).toMatch(/contains a number/);
    expect(checkProse("t", "P is {{q}}", { ids, placeholders: ["p"], maxLength: 500 }).join()).toMatch(/unknown placeholder/);
    expect(renderProse("P is {{p}}.", { p: "0.994" })).toBe("P is 0.994.");
  });
});

describe("agent checks", () => {
  const inp = loadInputs(FIXTURE);
  const target = { kind: "node" as const, id: "net_rtt_ms", description: "", unit: "ms", current_prior: null, inputs: [], required_ids: [], read_by: [] };
  const ctx = { problem_title: "", objectives: [], existing_ids: ["peak_tps", "net_rtt_ms"], min_rel_width: 1 };
  const child = (id: string) => ({ id, unit: "ms", distribution: { type: "lognormal" as const, params: [{ name: "median", value: 5 }, { name: "sigma", value: 0.5 }] }, observable: false, measure_cost_usd: null, measurement: null, rationale: "r" });
  test("decomposer: good proposal converts, bad ids and formulas are rejected", () => {
    const measurable = { ...child("a_ms"), observable: true, measure_cost_usd: 100, measurement: { likelihood: "normal" as const, noise: 1, replicates: 3 } };
    const good: DecompositionOut = { rationale: "r", replace: { type: "deterministic", noise: null, dependency: "a_ms + b_ms" }, children: [measurable, child("b_ms")] };
    const nothingToMeasure = convertDecomposition({ ...good, children: [child("a_ms"), child("b_ms")] }, target, ctx);
    expect(nothingToMeasure.ok).toBe(false);
    if (!nothingToMeasure.ok) expect(nothingToMeasure.errors.join()).toMatch(/at least one child must be observable/);
    const ok = convertDecomposition(good, target, ctx);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.children.every((c) => c.source === "llm_guess")).toBe(true);
    const bad: DecompositionOut = { rationale: "r", replace: { type: "deterministic", noise: null, dependency: "a_ms + mystery" }, children: [child("a_ms"), child("peak_tps")] };
    const r = convertDecomposition(bad, target, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join()).toMatch(/already exists/);
      expect(r.errors.join()).toMatch(/uses mystery/);
    }
  });
  test("hybrids: fixed attributes cannot be overridden and guesses must be wide", () => {
    const r = convertHybrids(
      { options: [{ dimension: "store", based_on: "kv_log", id: "kv_cache", label: "x", rationale: "add a read cache", overrides: [{ attribute: "base_usd", lo: 1, hi: 2, dist: "uniform" }, { attribute: "read_ms", lo: 1, hi: 1.2, dist: "lognormal" }] }] },
      inp.catalog,
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join()).toMatch(/fixed attribute/);
      expect(r.errors.join()).toMatch(/too narrow/);
    }
    const ok = convertHybrids({ options: [{ dimension: "store", based_on: "kv_log", id: "kv_cache", label: "x", rationale: "add a read cache", overrides: [{ attribute: "read_ms", lo: 0.8, hi: 6, dist: "lognormal" }] }] }, inp.catalog, 1);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value[0].option.attributes.tamper_evident).toBeUndefined();
  });
  test("evidence: numbers must come from the notes", () => {
    const node = { id: "read_ms@kv_log", parent_ids: [], kind: "sub" as const, distribution: { type: "lognormal" as const, params: { median: 4, sigma: 0.6 } }, observable: true, source: "llm_guess" as const, rationale: "" };
    const notes = "Five benchmark reads: 2.4, 2.9, 2.7, 3.1 and 2.5 ms.";
    const base = { observation: { kind: "values" as const, values: [2.4, 2.9, 2.7, 3.1, 2.5], k: null, n: null, lo: null, hi: null }, likelihood: "normal" as const, noise: 1, source: "measured" as const, note: "five reads" };
    expect(convertEvidence(base, node, notes).ok).toBe(true);
    const invented = { ...base, observation: { ...base.observation, values: [2.4, 2.2] } };
    const r = convertEvidence(invented, node, notes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/2.2 does not appear/);
  });
  test("requirements: weights renormalised, sources set by code, unknown names refused", () => {
    const root = (id: string, upper: number, metric: string) => ({ id, description: "", sense: "upper" as const, target: upper / 2, lower: null, upper, weight: 0.5, unit: "", metric, rationale: "" });
    const raw = { roots: [root("verify_ms", 40, "net_ms + store.read_ms"), root("spend", 1234, "store.base_usd")], drivers: [{ id: "net_ms", description: "" }], notes: "" };
    const r = convertRequirements(raw, "verify under 40 ms, target 20", inp.catalog);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.roots[0].source).toBe("document");
      expect(r.value.roots[1].source).toBe("llm_guess");
    }
    const bad = convertRequirements({ ...raw, roots: [root("a", 40, "store.nope + ghost"), root("b", 10, "store.base_usd")] }, "", inp.catalog);
    expect(bad.ok).toBe(false);
  });
});
