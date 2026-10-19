// Acceptance (b): byte-identical reproduction.
//  - CI contract: run twice, then replay once; all three give identical snapshot hashes.
//  - resume --from-iter k reproduces an uninterrupted run exactly.
//  - a live run that pauses for evidence, resumed with an approved evidence file,
//    replays byte for byte from its own folder (two segments).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdReplay, cmdResume, cmdRun } from "../src/commands.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/cloud");
const FAST = ["particles=1200", "axis.particles=200"];

describe("acceptance (b): reproducibility", () => {
  const root = mkdtempSync(join(tmpdir(), "gde-replay-"));

  test("run twice + replay once give identical snapshot hashes", async () => {
    const a = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: "truth", overrides: FAST, now: new Date("2026-10-19T10:00:00Z") });
    const b = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: "truth", overrides: FAST, now: new Date("2026-10-19T11:00:00Z") });
    expect(a.runId).not.toBe(b.runId);
    expect(Object.keys(a.snapshots).length).toBeGreaterThan(2);
    expect(b.snapshots).toEqual(a.snapshots);
    // Events carry no wall-clock time, so the logs match too.
    expect(readFileSync(join(b.dir, "events.jsonl"), "utf8")).toBe(readFileSync(join(a.dir, "events.jsonl"), "utf8"));
    const r = await cmdReplay({ runsRoot: root, runId: a.runId });
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.replayed).toEqual(a.snapshots);
    console.log(`  snapshots: ${Object.entries(a.snapshots).map(([k, h]) => `iter_${k}=${h.slice(0, 12)}`).join(" ")}`);
  }, 300_000);

  test("halting after iteration 2 and resuming matches an uninterrupted run", async () => {
    const full = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: "truth", overrides: FAST, now: new Date("2026-10-19T12:00:00Z"), report: false });
    const part = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: "truth", overrides: FAST, now: new Date("2026-10-19T13:00:00Z"), haltAfter: 2, report: false });
    expect(Object.keys(part.snapshots).map(Number)).toEqual([0, 1, 2]);
    const resumed = await cmdResume({ runsRoot: root, runId: part.runId, report: false });
    expect(resumed.snapshots).toEqual(full.snapshots);
    // Resuming from an earlier snapshot recomputes the later ones identically.
    const again = await cmdResume({ runsRoot: root, runId: part.runId, fromIter: 1, report: false });
    expect(again.snapshots).toEqual(full.snapshots);
  }, 300_000);

  test("live run pauses for evidence, resumes with an approved file, and replays", async () => {
    const live = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: null, overrides: FAST, now: new Date("2026-10-19T14:00:00Z") });
    expect(live.state.status).toBe("awaiting_evidence");
    const node = live.state.plan.next!.node;
    expect(node).toBe("read_ms@kv_log");
    const ev = join(root, "ev-100-bench-kv-read.yaml");
    writeFileSync(
      ev,
      [
        "id: ev-100-bench-kv-read",
        `target_node: "${node}"`,
        "observation: { values: [2.4, 2.9, 2.7, 3.1, 2.5] }",
        "likelihood: normal",
        "noise: 1.0",
        "source: measured",
        "approved_by: test-reviewer",
        'approved_at: "2026-10-19T14:30:00Z"',
        "illustrative: true",
        "",
      ].join("\n"),
    );
    const res = await cmdResume({ runsRoot: root, runId: live.runId, evidenceFiles: [ev] });
    expect(res.state.applied.map((e) => e.id)).toContain("ev-100-bench-kv-read");
    const r = await cmdReplay({ runsRoot: root, runId: live.runId });
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  }, 300_000);

  test("unapproved evidence is refused", async () => {
    const live = await cmdRun({ inputsDir: FIXTURE, runsRoot: root, oracle: null, overrides: FAST, now: new Date("2026-10-19T15:00:00Z"), report: false });
    const ev = join(root, "ev-101-unapproved.yaml");
    writeFileSync(ev, "id: ev-101\ntarget_node: peak_tps\nobservation: { values: [300] }\nlikelihood: lognormal\nnoise: 0.2\nsource: measured\n");
    await expect(cmdResume({ runsRoot: root, runId: live.runId, evidenceFiles: [ev] })).rejects.toThrow(/approved_by/);
  }, 300_000);
});
