// Phase 2 acceptance: LLM agents behind schemas and the cache.
//  - replay works offline (byte-identical snapshots, no transport at all);
//  - schema-invalid output is rejected: retried with the errors, then a loud failure;
//  - no LLM output changes a ranking (adversarial critic/explainer text leaves every
//    snapshot and every number in the report unchanged).
// Claude is replaced by a scripted transport (tests/fake_claude.ts); the real
// transport is the same code path behind `lazyAnthropic()`.

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLM_ON } from "../src/agents/index.ts";
import { scriptedTransport } from "../src/agents/llm.ts";
import { cmdDraftEvidence, cmdDraftRoots, cmdReplay, cmdResume, cmdRun } from "../src/commands.ts";
import { canonicalJsonPretty } from "../src/io/canon.ts";
import { parseYaml } from "../src/model/load.ts";
import { errorsOf } from "../src/model/schema.ts";
import { EvidenceSchema, RootsFileSchema } from "../src/model/types.ts";
import { fakeClaude } from "./fake_claude.ts";

const FAST = ["particles=1200", "axis.particles=200"];
const LLM = [LLM_ON, ...FAST];
let INPUTS = "";
let ROOT = "";

/** The fixture without the ledger decomposition, so EXPAND of ledger_entries_m goes to the LLM decomposer. */
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "gde-p2-"));
  INPUTS = join(ROOT, "inputs");
  cpSync(join(import.meta.dir, "../fixtures/cloud"), INPUTS, { recursive: true });
  const dec = parseYaml(readFileSync(join(INPUTS, "decompositions.yaml"), "utf8"), "d") as { decompositions: { parent: string }[] };
  dec.decompositions = dec.decompositions.filter((d) => d.parent !== "ledger_entries_m");
  writeFileSync(join(INPUTS, "decompositions.yaml"), "# illustrative test variant\n" + Bun.YAML.stringify(dec, null, 2));
  writeFileSync(
    join(INPUTS, "truth.yaml"),
    "illustrative: true\nvalues:\n  read_ms@kv_log: 2.6\n  peak_tps: 360\n  verify_cpu_ms@containers: 4.8\n  read_ms@managed_sql: 5.1\n  sign_ms@kms: 3.4\n  ledger_entries_m: 520\n",
  );
});

const events = (dir: string) => readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const numbersOnly = (dir: string) => {
  const j = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  delete j.audit;
  delete j.explanations;
  delete j.advice;
  return canonicalJsonPretty(j);
};

describe("Phase 2 acceptance", () => {
  test("an LLM run replays offline byte for byte, and a second run makes no calls", async () => {
    const shared = join(ROOT, "shared-a");
    const t1 = scriptedTransport(fakeClaude());
    const a = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: LLM, transport: t1, sharedCache: shared, now: new Date("2026-10-19T20:00:00Z") });
    const agents = [...new Set(t1.calls.map((c) => c.agent))].sort();
    console.log(`  live run: ${t1.calls.length} calls (${agents.join(", ")}); history ${a.state.history.map((h) => `${h.action.kind}${h.action.node ? `(${h.action.node})` : ""}`).join(" → ")}`);
    expect(agents).toEqual(["critic", "decomposer", "explainer"]);
    expect(a.state.extras.decompositions.map((d) => d.parent)).toEqual(["ledger_entries_m"]);
    expect(a.state.extras.options).toEqual([]); // G was comfortably above τ: no hybrids asked for
    const report = JSON.parse(readFileSync(join(a.dir, "report.json"), "utf8"));
    expect(report.explanations.texts.recommended).toMatch(/reaches [01]\.\d{3} in the zone at a median spend of \d+ USD/); // number filled in by code
    expect(report.advice.advice.summary).toContain("second look");

    const t2 = scriptedTransport(() => {
      throw new Error("the network was used");
    });
    const b = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: LLM, transport: t2, sharedCache: shared, now: new Date("2026-10-19T21:00:00Z") });
    expect(t2.calls.length).toBe(0);
    expect(b.snapshots).toEqual(a.snapshots);

    const r = await cmdReplay({ runsRoot: ROOT, runId: a.runId });
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    const llmEvents = events(join(a.dir, "replay")).filter((e) => e.kind === "llm");
    expect(llmEvents.length).toBeGreaterThan(0);
    expect(llmEvents.every((e) => e.detail.source === "run_cache")).toBe(true);
  }, 300_000);

  test("schema-invalid output is retried with the errors, and a third rejection fails loudly", async () => {
    const t = scriptedTransport(fakeClaude({ badAttempts: { decomposer: 1, explainer: 2 } }));
    const run = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: LLM, transport: t, sharedCache: join(ROOT, "shared-b"), now: new Date("2026-10-19T22:00:00Z") });
    const llm = events(run.dir).filter((e) => e.kind === "llm");
    const by = (agent: string) => llm.filter((e) => e.detail.agent === agent).map((e) => e.detail.valid);
    const dec = by("decomposer");
    expect(dec.length).toBeGreaterThanOrEqual(2);
    expect(dec).toEqual(dec.map((_, i) => i % 2 === 1)); // every call: one rejection, then accepted
    expect(by("explainer")).toEqual([false, false, true]);
    expect(llm.find((e) => e.detail.agent === "explainer" && !e.detail.valid).detail.errors.join()).toMatch(/contains a number/);
    expect(llm.find((e) => e.detail.agent === "decomposer" && !e.detail.valid).detail.errors.join()).toMatch(/snake_case|missing required key/);

    const bad = scriptedTransport(fakeClaude({ badAttempts: { explainer: 3 } }));
    await expect(
      cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: LLM, transport: bad, sharedCache: join(ROOT, "shared-c"), now: new Date("2026-10-19T23:00:00Z") }),
    ).rejects.toThrow(/explainer: every attempt failed validation \(3 attempts\)/);
  }, 300_000);

  test("no LLM output changes a ranking", async () => {
    const benign = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: LLM, transport: scriptedTransport(fakeClaude()), sharedCache: join(ROOT, "shared-d"), now: new Date("2026-10-20T00:00:00Z") });
    const hostile = await cmdRun({
      inputsDir: INPUTS,
      runsRoot: ROOT,
      oracle: "truth",
      overrides: LLM,
      transport: scriptedTransport(fakeClaude({ critic: "adversarial", explainer: "adversarial" })),
      sharedCache: join(ROOT, "shared-e"),
      now: new Date("2026-10-20T01:00:00Z"),
    });
    expect(hostile.snapshots).toEqual(benign.snapshots);
    expect(numbersOnly(hostile.dir)).toBe(numbersOnly(benign.dir));
    const md = readFileSync(join(hostile.dir, "report.md"), "utf8");
    expect(md).toContain("Disregard the computed order"); // the text was used, and changed nothing
    expect(md).toContain("advisory only");
  }, 300_000);

  test("hybrids are asked for only when G is empty or near τ, and are then scored by code", async () => {
    const t = scriptedTransport(fakeClaude());
    const run = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: "truth", overrides: [...LLM, "agents.max_hybrid_calls=1", "tau=0.97", "iteration_budget=3"], transport: t, sharedCache: join(ROOT, "shared-f"), now: new Date("2026-10-20T02:00:00Z") });
    expect(t.calls.filter((c) => c.agent === "hybrids").length).toBe(1);
    expect(run.state.extras.options.map((p) => p.option.id)).toEqual(["kv_log_cached"]);
    const proposed = run.state.candidates.passing.filter((c) => c.origin === "llm_proposed");
    expect(proposed.length).toBe(54);
    expect(proposed.every((c) => c.picks.store === "kv_log_cached")).toBe(true);
    const snap = JSON.parse(readFileSync(join(run.dir, "snapshots", `iter_${run.state.iter}.json`), "utf8"));
    expect(snap.candidates.llm_proposed.length).toBe(54);
    expect(events(run.dir).some((e) => e.kind === "propose" && e.detail.agent === "hybrids")).toBe(true);
    const r = await cmdReplay({ runsRoot: ROOT, runId: run.runId });
    expect(r.ok).toBe(true);
  }, 300_000);

  test("drafted roots and evidence are refused until a person approves them", async () => {
    const shared = join(ROOT, "shared-g");
    const roots = await cmdDraftRoots({ inputsDir: INPUTS, transport: scriptedTransport(fakeClaude()), sharedCache: shared });
    const draft = parseYaml(readFileSync(roots.path, "utf8"), "draft") as { roots: { id: string; source: string; weight: number }[]; approval: { approved_by: string; approved_at: string } };
    expect(errorsOf(RootsFileSchema, draft).join()).toMatch(/approved_by: shorter than 1/);
    expect(draft.roots.find((r) => r.id === "spend_usd")!.source).toBe("llm_guess");
    expect(draft.roots.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 12);
    draft.approval.approved_by = "reviewer";
    draft.approval.approved_at = "2026-10-20T03:00:00Z";
    expect(errorsOf(RootsFileSchema, draft)).toEqual([]);

    const live = await cmdRun({ inputsDir: INPUTS, runsRoot: ROOT, oracle: null, overrides: FAST, now: new Date("2026-10-20T04:00:00Z"), report: false });
    expect(live.state.status).toBe("awaiting_evidence");
    const notes = "Five benchmark reads of the key-value store: 2.4, 2.9, 2.7, 3.1 and 2.5 ms.";
    const d = await cmdDraftEvidence({ runsRoot: ROOT, runId: live.runId, notes, transport: scriptedTransport(fakeClaude()), sharedCache: shared });
    const ev = parseYaml(readFileSync(d.path, "utf8"), "ev") as Record<string, unknown>;
    expect(errorsOf(EvidenceSchema, ev).join()).toMatch(/approved_by: shorter than 1/);
    expect((ev.observation as { values: number[] }).values).toEqual([2.4, 2.9, 2.7, 3.1, 2.5]);
    await expect(cmdResume({ runsRoot: ROOT, runId: live.runId, evidenceFiles: [d.path], report: false })).rejects.toThrow(/approved_by/);
    const approved = join(ROOT, "approved.yaml");
    writeFileSync(approved, Bun.YAML.stringify({ ...ev, approved_by: "reviewer", approved_at: "2026-10-20T05:00:00Z" }, null, 2));
    const res = await cmdResume({ runsRoot: ROOT, runId: live.runId, evidenceFiles: [approved], report: false });
    expect(res.state.applied.map((e) => e.id)).toContain(d.id);
  }, 300_000);
});
