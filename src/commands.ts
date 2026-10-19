// Command implementations shared by the CLI and the tests: run, resume, replay,
// draft-roots and draft-evidence.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentSettings, lazyAnthropic, modelFor, usesLlm } from "./agents/index.ts";
import { checkEvidenceApproval } from "./approval.ts";
import { draftEvidence } from "./agents/evidence.ts";
import { LlmCache, LlmClient, offlineTransport, type CacheMode, type LlmEvent, type Transport } from "./agents/llm.ts";
import { draftRoots } from "./agents/requirements.ts";
import type { CriticAdvice } from "./agents/critic_llm.ts";
import { Streams } from "./core/rng.ts";
import { canonicalJsonPretty, hashValue, sha256 } from "./io/canon.ts";
import { RunStore, toolVersion, type Manifest, type Segment } from "./io/runstore.ts";
import { inputsHash, runLoop, treeInputs, type Snapshot, type State } from "./engine/loop.ts";
import { makeOracle } from "./engine/oracle.ts";
import { applyOverrides, loadInputs, parseYaml, type Inputs } from "./model/load.ts";
import { validate } from "./model/schema.ts";
import { CatalogFileSchema, EvidenceSchema, ProblemFileSchema, type Config } from "./model/types.ts";
import { buildReport } from "./report/build.ts";
import { addExplanations } from "./report/explain.ts";
import { reportMarkdown } from "./report/markdown.ts";
import { fpcaSvg } from "./report/svg.ts";
import { reportHtmlDocument } from "./report/html.ts";
import { diffMarkdown, diffReports, diffSummary, type RunDiff } from "./report/diff.ts";

export type OracleMode = "truth" | "prior" | null;
export const DEFAULT_SHARED_CACHE = "cache/llm";

export interface LlmOptions {
  transport?: Transport; // injected by tests; default: the Claude API, created on first cache miss
  fresh?: boolean; // ignore the shared cache (still record)
  sharedCache?: string | null;
}

export interface RunResult {
  runId: string;
  dir: string;
  state: State;
  snapshots: Record<number, string>; // iter → sha256 of the snapshot JSON
}

function oracleFor(mode: OracleMode, inputs: Inputs, cfg: Config) {
  if (mode === null) return null;
  if (mode === "truth" && !inputs.truth) throw new Error("--oracle truth needs a truth.yaml in the inputs");
  return makeOracle(treeInputs(inputs), mode === "truth" ? inputs.truth : null, new Streams(cfg.seed));
}

function snapshotHashes(store: RunStore): Record<number, string> {
  const out: Record<number, string> = {};
  for (const k of store.snapshotIters()) out[k] = sha256(store.readSnapshot(k).json);
  return out;
}

/** Hooks that write events and snapshots, keep critic advice beside the run, and tag LLM events with the iteration. */
function hooks(store: RunStore) {
  let iter = 0;
  const h = {
    event: (e: { iter: number }) => {
      iter = e.iter;
      store.event(e);
    },
    snapshot: (k: number, json: string, bytes: Uint8Array) => store.writeSnapshot(k, json, bytes),
    advice: (k: number, advice: CriticAdvice, key: string) => {
      mkdirSync(join(store.dir, "advice"), { recursive: true });
      writeFileSync(join(store.dir, "advice", `iter_${k}.json`), canonicalJsonPretty({ iter: k, request: key, advice }));
    },
    llm: (e: LlmEvent) =>
      store.event({ iter, kind: "llm", inputs: { request: e.key }, outputs: { response: e.response_sha256 }, detail: { agent: e.agent, attempt: e.attempt, source: e.source, valid: e.valid, errors: e.errors } }),
  };
  return h;
}

function clientFor(cfg: Config, store: RunStore, mode: CacheMode, h: ReturnType<typeof hooks>, o: LlmOptions): LlmClient | null {
  if (!usesLlm(agentSettings(cfg))) return null;
  const shared = mode === "replay" ? null : o.sharedCache === undefined ? DEFAULT_SHARED_CACHE : o.sharedCache;
  const cache = new LlmCache(join(store.dir, "llm_cache"), shared, mode);
  const transport = mode === "replay" ? offlineTransport : (o.transport ?? lazyAnthropic());
  return new LlmClient(transport, cache, h.llm);
}

function latestAdvice(dir: string): { iter: number; request: string; advice: CriticAdvice } | null {
  const d = join(dir, "advice");
  if (!existsSync(d)) return null;
  const iters = readdirSync(d).map((f) => /^iter_(\d+)\.json$/.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!iters.length) return null;
  return JSON.parse(readFileSync(join(d, `iter_${iters[iters.length - 1]}.json`), "utf8"));
}

export async function writeReport(store: RunStore, st: State, inputs: Inputs, cfg: Config, llm: LlmClient | null): Promise<void> {
  const last = store.snapshotIters().pop()!;
  const report = buildReport(st, inputs, cfg, new Streams(cfg.seed), {
    run_id: store.id,
    manifest_sha256: store.manifestHash(),
    events: "events.jsonl",
    final_snapshot: `snapshots/iter_${last}.json (sha256 ${sha256(store.readSnapshot(last).json)})`,
  });
  const s = agentSettings(cfg);
  if (s.explain && llm) await addExplanations(report, llm, modelFor(cfg, "explainer"));
  const approvals = new Map<string, NonNullable<typeof report.approvals>[number]>();
  for (const line of readFileSync(join(store.dir, "events.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as { kind: string; detail?: Record<string, unknown> };
    if (e.kind !== "approve" || !e.detail) continue;
    const what = String(e.detail.what);
    approvals.set(what, { what, approved_by: String(e.detail.approved_by), approved_at: (e.detail.approved_at as string | null) ?? null, bound: (e.detail.bound_to_content as string | null) ?? null });
  }
  report.approvals = [...approvals.values()];
  const adv = s.critic ? latestAdvice(store.dir) : null;
  if (adv) report.advice = { iter: adv.iter, model: modelFor(cfg, "critic"), request: adv.request, advice: adv.advice };
  store.write("report.json", canonicalJsonPretty(report));
  store.write("report.md", reportMarkdown(report));
  store.write("fpca.svg", fpcaSvg(report));
  store.write("report.html", reportHtmlDocument(report, `${report.title.replace(/\s*\(illustrative\)\s*$/i, "")} brief`));
}

export async function cmdRun(a: { inputsDir: string; runsRoot: string; oracle: OracleMode; overrides: string[]; now?: Date; haltAfter?: number; report?: boolean } & LlmOptions): Promise<RunResult> {
  const inputs = loadInputs(a.inputsDir);
  const cfg = applyOverrides(inputs.config, a.overrides);
  const store = RunStore.create(a.runsRoot, `s${cfg.seed}-${inputsHash(inputs).slice(0, 8)}`, a.now);
  store.writeInputs(inputs.files);
  const manifest: Manifest = {
    run_id: store.id,
    tool: toolVersion(),
    started_at: (a.now ?? new Date()).toISOString(),
    seed: cfg.seed,
    config: cfg,
    config_sha256: hashValue(cfg),
    overrides: a.overrides,
    inputs: inputs.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    model_ids: cfg.models,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    segments: [{ kind: "run", from_iter: null, inputs: inputs.files.map((f) => f.path), oracle: a.oracle }],
    llm: usesLlm(agentSettings(cfg)) ? { agents: agentSettings(cfg), cache: a.fresh ? "fresh" : "run", shared_cache: a.sharedCache === undefined ? DEFAULT_SHARED_CACHE : a.sharedCache } : null,
  };
  store.writeManifest(manifest);
  const h = hooks(store);
  const llm = clientFor(cfg, store, a.fresh ? "fresh" : "run", h, a);
  const state = await runLoop({ inputs, config: cfg, oracle: oracleFor(a.oracle, inputs, cfg), hooks: h, llm, haltAfter: a.haltAfter });
  if (a.report !== false) await writeReport(store, state, inputs, cfg, llm);
  return { runId: store.id, dir: store.dir, state, snapshots: snapshotHashes(store) };
}

export async function cmdResume(a: { runsRoot: string; runId: string; fromIter?: number; evidenceFiles?: string[]; haltAfter?: number; report?: boolean } & LlmOptions): Promise<RunResult> {
  const store = new RunStore(join(a.runsRoot, a.runId));
  const manifest = store.readManifest();
  for (const f of a.evidenceFiles ?? []) {
    const raw = readFileSync(f, "utf8");
    checkEvidenceApproval(validate(EvidenceSchema, parseYaml(raw, f), f), f); // approval is required and must match the content
    const dest = join(store.dir, "inputs", "evidence", basename(f));
    if (existsSync(dest)) throw new Error(`evidence ${basename(f)} is already part of this run`);
    mkdirSync(join(store.dir, "inputs", "evidence"), { recursive: true });
    writeFileSync(dest, raw);
  }
  const inputs = loadInputs(join(store.dir, "inputs"));
  const cfg = applyOverrides(inputs.config, manifest.overrides);
  const iters = store.snapshotIters();
  const k = a.fromIter ?? iters[iters.length - 1];
  if (!iters.includes(k)) throw new Error(`run ${a.runId} has no snapshot for iteration ${k}`);
  const { json, bytes } = store.readSnapshot(k);
  const snapshot = JSON.parse(json) as Snapshot;
  const oracle = manifest.segments[manifest.segments.length - 1].oracle;
  const seg: Segment = { kind: "resume", from_iter: k, inputs: inputs.files.map((f) => f.path), oracle };
  manifest.segments.push(seg);
  manifest.inputs = inputs.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
  store.writeManifest(manifest);
  store.event({ iter: k, kind: "resume", inputs: { snapshot: sha256(json) }, outputs: {}, detail: { evidence_added: (a.evidenceFiles ?? []).map((f) => basename(f)) } });
  const h = hooks(store);
  const llm = clientFor(cfg, store, a.fresh ? "fresh" : "run", h, a);
  const state = await runLoop({ inputs, config: cfg, oracle: oracleFor(oracle, inputs, cfg), hooks: h, llm, resume: { snapshot, particleBytes: bytes }, haltAfter: a.haltAfter });
  if (a.report !== false) await writeReport(store, state, inputs, cfg, llm);
  return { runId: store.id, dir: store.dir, state, snapshots: snapshotHashes(store) };
}

export interface ReplayResult {
  ok: boolean;
  compared: number;
  mismatches: string[];
  original: Record<number, string>;
  replayed: Record<number, string>;
}

/** Re-execute every segment of a run from its own folder (no network) and compare byte for byte. */
export async function cmdReplay(a: { runsRoot: string; runId: string }): Promise<ReplayResult> {
  const orig = new RunStore(join(a.runsRoot, a.runId));
  const manifest = orig.readManifest();
  const rdir = join(orig.dir, "replay");
  rmSync(rdir, { recursive: true, force: true });
  for (const d of ["", "snapshots"]) mkdirSync(join(rdir, d), { recursive: true });
  writeFileSync(join(rdir, "events.jsonl"), "");
  const store = new RunStore(rdir);
  let state: State | null = null;
  let inputs: Inputs | null = null;
  let cfg: Config | null = null;
  const h = hooks(store);
  let llm: LlmClient | null = null;
  for (const [i, seg] of manifest.segments.entries()) {
    const sdir = join(rdir, `inputs_segment_${i}`);
    for (const p of seg.inputs) {
      mkdirSync(join(sdir, p, ".."), { recursive: true });
      cpSync(join(orig.dir, "inputs", p), join(sdir, p));
    }
    inputs = loadInputs(sdir);
    cfg = applyOverrides(inputs.config, manifest.overrides);
    if (hashValue(cfg) !== manifest.config_sha256) throw new Error("replayed config does not match the manifest");
    // Read-only: the original run's llm_cache, and no transport that could reach a network.
    llm = usesLlm(agentSettings(cfg)) ? new LlmClient(offlineTransport, new LlmCache(join(orig.dir, "llm_cache"), null, "replay"), h.llm) : null;
    const oracle = oracleFor(seg.oracle, inputs, cfg);
    if (seg.kind === "run") state = await runLoop({ inputs, config: cfg, oracle, hooks: h, llm });
    else {
      const { json, bytes } = store.readSnapshot(seg.from_iter!);
      state = await runLoop({ inputs, config: cfg, oracle, hooks: h, llm, resume: { snapshot: JSON.parse(json), particleBytes: bytes } });
    }
  }
  const original = snapshotHashes(orig);
  const replayed = snapshotHashes(store);
  const mismatches: string[] = [];
  for (const k of new Set([...Object.keys(original), ...Object.keys(replayed)].map(Number))) {
    if (original[k] !== replayed[k]) mismatches.push(`iter_${k}.json`);
    else if (sha256(orig.readSnapshot(k).bytes) !== sha256(store.readSnapshot(k).bytes)) mismatches.push(`iter_${k}.particles.bin`);
  }
  if (state && inputs && cfg) {
    store.write("manifest.json", readFileSync(join(orig.dir, "manifest.json"), "utf8"));
    await writeReport(store, state, inputs, cfg, llm);
    const strip = (s: string) => {
      const j = JSON.parse(s);
      delete j.audit;
      return canonicalJsonPretty(j);
    };
    if (existsSync(join(orig.dir, "report.json")) && strip(readFileSync(join(orig.dir, "report.json"), "utf8")) !== strip(readFileSync(join(rdir, "report.json"), "utf8")))
      mismatches.push("report.json");
  }
  return { ok: mismatches.length === 0, compared: Object.keys(original).length, mismatches, original, replayed };
}

/** Requirements agent → roots.draft.yaml (unapproved: the loader refuses it until a person signs it). */
export async function cmdDraftRoots(a: { inputsDir: string; out?: string; configOverrides?: string[] } & LlmOptions): Promise<{ path: string; drivers: string[] }> {
  const problemRaw = readFileSync(join(a.inputsDir, "problem.yaml"), "utf8");
  const problem = validate(ProblemFileSchema, parseYaml(problemRaw, "problem.yaml"), "problem.yaml");
  const catalog = validate(CatalogFileSchema, parseYaml(readFileSync(join(a.inputsDir, "catalog.yaml"), "utf8"), "catalog.yaml"), "catalog.yaml");
  const cfgRaw = parseYaml(readFileSync(join(a.inputsDir, "config.yaml"), "utf8"), "config.yaml") as Config;
  const model = cfgRaw.models?.requirements;
  if (!model) throw new Error("config.models.requirements is not set");
  const drafts = join(a.inputsDir, ".drafts");
  const client = new LlmClient(a.transport ?? lazyAnthropic(), new LlmCache(join(drafts, "llm_cache"), a.sharedCache === undefined ? DEFAULT_SHARED_CACHE : a.sharedCache, a.fresh ? "fresh" : "run"));
  const res = await draftRoots(client, model, problem, problemRaw, catalog);
  const path = a.out ?? join(a.inputsDir, "roots.draft.yaml");
  const header = [
    `# DRAFT roots from the requirements agent (${model}, request ${res.key.slice(0, 12)}).`,
    "# Review every band and weight. To approve, fill in approval.approved_by and approved_at,",
    "# then save as roots.yaml. The loader refuses this file while approved_by is empty.",
    ...(res.drivers.length ? ["# Drivers the metrics read (the decomposer must define them):", ...res.drivers.map((d) => `#   ${d.id}: ${d.description}`)] : []),
    ...(res.notes ? [`# Agent notes: ${res.notes.replace(/\n/g, " ")}`] : []),
    "",
  ].join("\n");
  writeFileSync(path, header + Bun.YAML.stringify(res.draft, null, 2) + "\n");
  return { path, drivers: res.drivers.map((d) => d.id) };
}

/** Evidence agent → runs/<id>/drafts/<id>.yaml (unapproved draft for the node the run is waiting on). */
export async function cmdDraftEvidence(a: { runsRoot: string; runId: string; notes: string; node?: string } & LlmOptions): Promise<{ path: string; id: string }> {
  const store = new RunStore(join(a.runsRoot, a.runId));
  const iters = store.snapshotIters();
  const snap = JSON.parse(store.readSnapshot(iters[iters.length - 1]).json) as Snapshot;
  const nodeId = a.node ?? snap.awaiting?.node;
  if (!nodeId) throw new Error("the run is not waiting for a measurement; pass --node");
  const node = snap.model.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const cfg = store.readManifest().config;
  const client = new LlmClient(a.transport ?? lazyAnthropic(), new LlmCache(join(store.dir, "llm_cache"), a.sharedCache === undefined ? DEFAULT_SHARED_CACHE : a.sharedCache, a.fresh ? "fresh" : "run"));
  const res = await draftEvidence(client, modelFor(cfg, "evidence"), node, a.notes);
  mkdirSync(join(store.dir, "drafts"), { recursive: true });
  const path = join(store.dir, "drafts", `${res.evidence.id}.yaml`);
  const header = `# DRAFT evidence from the evidence agent (request ${res.key.slice(0, 12)}).\n# Check the observation against your notes, then set approved_by and approved_at\n# and pass this file to: gde resume ${a.runId} --evidence <file>\n`;
  writeFileSync(path, header + Bun.YAML.stringify({ ...res.evidence, approved_at: "" }, null, 2) + "\n");
  store.event({ iter: snap.iter, kind: "draft", inputs: { llm_request: res.key }, outputs: { draft: sha256(readFileSync(path, "utf8")) }, detail: { agent: "evidence", node: nodeId } });
  return { path, id: res.evidence.id };
}

export interface RerunResult {
  newRunId: string;
  dir: string;
  state: State;
  diff: RunDiff;
  summary: string;
  snapshots: Record<number, string>;
}

const TOP_LEVEL = new Set(["problem.yaml", "roots.yaml", "catalog.yaml", "decompositions.yaml", "config.yaml", "truth.yaml"]);

/**
 * Rerun a recorded run with changed inputs. The new run follows the original's segments
 * (so evidence added on resume arrives at the same point), starts with a copy of the
 * original's llm_cache (so every unchanged LLM request is replayed, not re-asked), and
 * ends with a diff of the two briefs plus the last iteration at which they were identical.
 */
export async function cmdRerun(a: { runsRoot: string; runId: string; withFiles: string[]; now?: Date } & LlmOptions): Promise<RerunResult> {
  const orig = new RunStore(join(a.runsRoot, a.runId));
  const manifest = orig.readManifest();
  const origInputs = join(orig.dir, "inputs");
  const changed: RunDiff["changed_inputs"] = [];
  const replacement = new Map<string, string>(); // rel path → new content
  for (const f of a.withFiles) {
    const name = basename(f);
    const rel = TOP_LEVEL.has(name) ? name : `evidence/${name}`;
    const raw = readFileSync(f, "utf8");
    const before = existsSync(join(origInputs, rel)) ? sha256(readFileSync(join(origInputs, rel), "utf8")) : null;
    replacement.set(rel, raw);
    changed.push({ path: rel, before, after: sha256(raw) });
  }
  const store = RunStore.create(a.runsRoot, `rerun-${a.runId.slice(0, 15)}`, a.now);
  cpSync(join(orig.dir, "llm_cache"), join(store.dir, "llm_cache"), { recursive: true });
  const stage = join(store.dir, "staging");
  const segments: Segment[] = [];
  const h = hooks(store);
  let state: State | null = null;
  let inputs: Inputs | null = null;
  let cfg: Config | null = null;
  let llm: LlmClient | null = null;
  const added = [...replacement.keys()].filter((r) => !existsSync(join(origInputs, r)));
  for (const [i, seg] of manifest.segments.entries()) {
    const sdir = join(stage, `segment_${i}`);
    for (const rel of [...seg.inputs, ...(i === 0 ? added : [])]) {
      mkdirSync(join(sdir, rel, ".."), { recursive: true });
      writeFileSync(join(sdir, rel), replacement.get(rel) ?? readFileSync(join(origInputs, rel), "utf8"));
    }
    inputs = loadInputs(sdir);
    cfg = applyOverrides(inputs.config, manifest.overrides);
    store.writeInputs(inputs.files);
    segments.push({ ...seg, inputs: inputs.files.map((f) => f.path) });
    if (i === 0)
      store.writeManifest({
        run_id: store.id,
        tool: toolVersion(),
        started_at: (a.now ?? new Date()).toISOString(),
        seed: cfg.seed,
        config: cfg,
        config_sha256: hashValue(cfg),
        overrides: manifest.overrides,
        inputs: inputs.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
        model_ids: cfg.models,
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        segments,
        llm: manifest.llm ?? null,
        rerun_of: { run_id: a.runId, changed },
      } as Manifest);
    llm = clientFor(cfg, store, a.fresh ? "fresh" : "run", h, a);
    const oracle = oracleFor(seg.oracle, inputs, cfg);
    if (seg.kind === "run") state = await runLoop({ inputs, config: cfg, oracle, hooks: h, llm });
    else {
      const k = Math.min(seg.from_iter!, store.snapshotIters().pop()!);
      const { json, bytes } = store.readSnapshot(k);
      state = await runLoop({ inputs, config: cfg, oracle, hooks: h, llm, resume: { snapshot: JSON.parse(json), particleBytes: bytes } });
    }
  }
  rmSync(stage, { recursive: true, force: true });
  const m2 = store.readManifest();
  m2.segments = segments;
  store.writeManifest(m2);
  await writeReport(store, state!, inputs!, cfg!, llm);
  const scores = (s: RunStore) => {
    const k = s.snapshotIters().pop()!;
    const snap = JSON.parse(s.readSnapshot(k).json) as Snapshot;
    return new Map(snap.scores.map((x) => [x.id, { P: x.P, cost_mean: x.cost_mean }]));
  };
  const before = JSON.parse(readFileSync(join(orig.dir, "report.json"), "utf8"));
  const after = JSON.parse(readFileSync(join(store.dir, "report.json"), "utf8"));
  const snapsAfter = snapshotHashes(store);
  const diff = diffReports(before, after, changed, snapshotHashes(orig), snapsAfter, scores(orig), scores(store));
  store.write("diff.json", canonicalJsonPretty(diff));
  store.write("diff.md", diffMarkdown(diff, a.runId, store.id));
  store.event({ iter: state!.iter, kind: "rerun_diff", inputs: { original: orig.manifestHash() }, outputs: { diff: sha256(canonicalJsonPretty(diff)) }, detail: { summary: diffSummary(diff) } });
  return { newRunId: store.id, dir: store.dir, state: state!, diff, summary: `rerun of ${a.runId}: ${diffSummary(diff)}`, snapshots: snapsAfter };
}
