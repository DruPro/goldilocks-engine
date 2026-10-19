// Phase 3: human gates, rerun-with-diff, and the HTML brief.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLM_ON } from "../src/agents/index.ts";
import { scriptedTransport } from "../src/agents/llm.ts";
import { approveEvidence, approveRoots } from "../src/approval.ts";
import { cmdDraftEvidence, cmdDraftRoots, cmdRerun, cmdResume, cmdRun } from "../src/commands.ts";
import { loadInputs } from "../src/model/load.ts";
import { fakeClaude } from "./fake_claude.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/cloud");
const FAST = ["particles=1200", "axis.particles=200"];
const CLI = join(import.meta.dir, "../src/cli.ts");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "gde-p3-"));
  const inputs = join(root, "inputs");
  cpSync(FIXTURE, inputs, { recursive: true });
  return { root, inputs };
}

describe("human gates", () => {
  test("approving evidence binds it to its content; an edit after approval is refused", async () => {
    const { root, inputs } = workspace();
    const live = await cmdRun({ inputsDir: inputs, runsRoot: root, oracle: null, overrides: FAST, now: new Date("2026-10-20T10:00:00Z"), report: false });
    const draft = await cmdDraftEvidence({ runsRoot: root, runId: live.runId, notes: "Five benchmark reads: 2.4, 2.9, 2.7, 3.1 and 2.5 ms.", transport: scriptedTransport(fakeClaude()), sharedCache: join(root, "cache") });
    const signed = approveEvidence(draft.path, { by: "reviewer", now: new Date("2026-10-20T10:30:00Z") });
    expect(signed.evidence.approval_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.summary).toContain("read_ms@kv_log");

    // Tamper with the observation after approval: the run refuses the file.
    const tampered = join(root, "tampered.yaml");
    writeFileSync(tampered, readFileSync(signed.path, "utf8").replace("- 2.4", "- 1.4"));
    await expect(cmdResume({ runsRoot: root, runId: live.runId, evidenceFiles: [tampered], report: false })).rejects.toThrow(/changed after reviewer approved it/);

    // The untouched file goes in, and the run log records a content-bound approval.
    const res = await cmdResume({ runsRoot: root, runId: live.runId, evidenceFiles: [signed.path], report: false });
    expect(res.state.applied.map((e) => e.id)).toContain(draft.id);
    const events = readFileSync(join(res.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ap = events.find((e) => e.kind === "approve" && e.detail.what === draft.id);
    expect(ap.detail.approved_by).toBe("reviewer");
    expect(ap.detail.bound_to_content).toBe(signed.evidence.approval_sha256);
  }, 300_000);

  test("approving roots writes roots.yaml; the loader refuses drafts and edited approvals", async () => {
    const { root, inputs } = workspace();
    const draft = await cmdDraftRoots({ inputsDir: inputs, out: join(root, "roots.draft.yaml"), transport: scriptedTransport(fakeClaude()), sharedCache: join(root, "cache") });
    const signed = approveRoots(draft.path, { by: "lead engineer", out: join(root, "roots.signed.yaml"), now: new Date("2026-10-20T11:00:00Z") });
    expect(signed.roots.approval.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The fixture's own roots, signed by a person, load fine; an edited band does not.
    const fixtureRoots = approveRoots(join(inputs, "roots.yaml"), { by: "lead engineer", now: new Date("2026-10-20T11:05:00Z") });
    expect(loadInputs(inputs).roots.approval.approved_by).toBe("lead engineer");
    writeFileSync(fixtureRoots.path, readFileSync(fixtureRoots.path, "utf8").replace("upper: 40", "upper: 45"));
    expect(() => loadInputs(inputs)).toThrow(/roots were changed after lead engineer approved them/);
  }, 300_000);

  test("the CLI will not approve on behalf of a person without a terminal or --yes", () => {
    const { root } = workspace();
    const file = join(root, "ev.yaml");
    writeFileSync(file, "id: ev-x\ntarget_node: peak_tps\nobservation: { values: [300] }\nlikelihood: lognormal\nnoise: 0.2\nsource: measured\napproved_by: ''\n");
    const r = Bun.spawnSync(["bun", CLI, "approve", "evidence", file, "--by", "someone"], { stdin: "ignore" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/approval needs a person/);
    const ok = Bun.spawnSync(["bun", CLI, "approve", "evidence", file, "--by", "someone", "--yes"], { stdin: "ignore" });
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/approval_sha256: [0-9a-f]{64}/);
  });
});

describe("rerun with diff", () => {
  test("an unchanged input reruns byte for byte; a changed price changes the answer and the diff says where", async () => {
    const { root, inputs } = workspace();
    const orig = await cmdRun({ inputsDir: inputs, runsRoot: root, oracle: "truth", overrides: FAST, now: new Date("2026-10-20T12:00:00Z") });
    const same = await cmdRerun({ runsRoot: root, runId: orig.runId, withFiles: [join(inputs, "catalog.yaml")], now: new Date("2026-10-20T12:30:00Z") });
    expect(same.snapshots).toEqual(orig.snapshots);
    expect(same.diff.identical_through_iteration).toBe(orig.state.iter);
    expect(same.diff.recommendation.changed).toBe(false);
    expect(same.diff.goldilocks.added).toEqual([]);

    const pricier = join(root, "catalog.yaml");
    writeFileSync(pricier, readFileSync(join(inputs, "catalog.yaml"), "utf8").replace("base_usd: { value: 180, source: document }", "base_usd: { value: 900, source: document }"));
    const changed = await cmdRerun({ runsRoot: root, runId: orig.runId, withFiles: [pricier], now: new Date("2026-10-20T13:00:00Z") });
    console.log(`  ${changed.summary}`);
    expect(changed.diff.changed_inputs.map((c) => c.path)).toEqual(["catalog.yaml"]);
    expect(changed.diff.identical_through_iteration).toBeNull();
    expect(changed.diff.recommendation.changed).toBe(true);
    expect(changed.diff.recommendation.after[0]).not.toContain("kv_log");
    expect(existsSync(join(changed.dir, "diff.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(changed.dir, "manifest.json"), "utf8")).rerun_of.run_id).toBe(orig.runId);
  }, 300_000);

  test("a rerun of an LLM run replays every unchanged LLM answer from the copied cache", async () => {
    const { root, inputs } = workspace();
    const orig = await cmdRun({ inputsDir: inputs, runsRoot: root, oracle: "truth", overrides: [LLM_ON, ...FAST], transport: scriptedTransport(fakeClaude()), sharedCache: null, now: new Date("2026-10-20T14:00:00Z") });
    const t = scriptedTransport(() => {
      throw new Error("the network was used");
    });
    const re = await cmdRerun({ runsRoot: root, runId: orig.runId, withFiles: [join(inputs, "problem.yaml")], transport: t, sharedCache: null, now: new Date("2026-10-20T14:30:00Z") });
    expect(t.calls.length).toBe(0);
    expect(re.snapshots).toEqual(orig.snapshots);
  }, 300_000);
});

describe("HTML brief", () => {
  test("report.html is self-contained, follows the palette and carries all six sections", async () => {
    const { root, inputs } = workspace();
    const run = await cmdRun({ inputsDir: inputs, runsRoot: root, oracle: "truth", overrides: [LLM_ON, ...FAST], transport: scriptedTransport(fakeClaude()), sharedCache: null, now: new Date("2026-10-20T15:00:00Z") });
    const html = readFileSync(join(run.dir, "report.html"), "utf8");
    for (const id of ["recommended", "map", "requirements", "ledger", "next", "audit"]) expect(html).toContain(`<section id="${id}">`);
    for (const c of ["#FFFFFF", "#007F6E", "#BFDFDB", "#02040A"]) expect(html).toContain(c);
    expect(html).toContain("font-family: var(--font)");
    expect(html).toContain("Arial");
    expect(html).not.toMatch(/<script/i);
    expect(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")).not.toMatch(/(src|href)="https?:/i);
    expect((html.match(/<section /g) ?? []).length).toBe((html.match(/<\/section>/g) ?? []).length);
    expect(html).toContain("Explanation written by claude-sonnet-5-5"); // LLM prose is labelled
    expect(html).toContain("Approvals");
    expect((html.match(/<svg /g) ?? []).length).toBeGreaterThanOrEqual(5);
  }, 300_000);
});
