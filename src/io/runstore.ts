// Run folders: runs/<run_id>/{manifest.json, events.jsonl, inputs/, llm_cache/,
// snapshots/iter_<k>.json + iter_<k>.particles.bin, report.*}. Inputs are copied in
// so a run folder alone is enough to replay it. Wall-clock time appears only in the
// manifest (and the run id); snapshots and events never contain it.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Config } from "../model/types.ts";
import type { InputFile } from "../model/load.ts";
import { canonicalJson, canonicalJsonPretty, sha256 } from "./canon.ts";

export const TOOL_NAME = "goldilocks-discovery-engine";
const SRC_DIR = join(import.meta.dir, "..");
const PKG = join(SRC_DIR, "..", "package.json");

/** Tool version: package version plus a hash of every source file, so any code change shows. */
export function toolVersion(): { name: string; version: string; source_sha256: string } {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(SRC_DIR);
  const listing = files.map((f) => `${relative(SRC_DIR, f)}:${sha256(readFileSync(f))}`).join("\n");
  const version = existsSync(PKG) ? (JSON.parse(readFileSync(PKG, "utf8")).version as string) : "0.0.0";
  return { name: TOOL_NAME, version, source_sha256: sha256(listing) };
}

export interface Segment {
  kind: "run" | "resume";
  from_iter: number | null;
  inputs: string[]; // input paths visible to this segment
  oracle: "truth" | "prior" | null;
}

export interface Manifest {
  run_id: string;
  tool: ReturnType<typeof toolVersion>;
  started_at: string;
  seed: number;
  config: Config;
  config_sha256: string;
  overrides: string[];
  inputs: { path: string; sha256: string }[];
  model_ids: Record<string, string>;
  runtime: { bun: string; platform: string; arch: string };
  segments: Segment[];
  llm?: { agents: unknown; cache: string; shared_cache: string | null } | null;
  rerun_of?: { run_id: string; changed: { path: string; before: string | null; after: string }[] };
}

export class RunStore {
  private seq = 0;
  constructor(readonly dir: string) {
    if (existsSync(join(dir, "events.jsonl"))) this.seq = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).length;
  }

  static create(runsRoot: string, label: string, now = new Date()): RunStore {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    let id = `${stamp}-${label}`;
    for (let i = 2; existsSync(join(runsRoot, id)); i++) id = `${stamp}-${label}-${i}`;
    const dir = join(runsRoot, id);
    for (const d of ["", "inputs", "llm_cache", "snapshots"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");
    return new RunStore(dir);
  }

  get id(): string {
    return this.dir.split("/").filter(Boolean).pop()!;
  }

  writeInputs(files: InputFile[]): void {
    for (const f of files) {
      const p = join(this.dir, "inputs", f.path);
      mkdirSync(dirname(p), { recursive: true });
      if (existsSync(p) && sha256(readFileSync(p, "utf8")) !== f.sha256) throw new Error(`input ${f.path} already exists in the run with different content`);
      writeFileSync(p, f.raw);
    }
  }

  writeManifest(m: Manifest): string {
    const json = canonicalJsonPretty(m);
    writeFileSync(join(this.dir, "manifest.json"), json);
    return sha256(json);
  }

  readManifest(): Manifest {
    return JSON.parse(readFileSync(join(this.dir, "manifest.json"), "utf8"));
  }

  manifestHash(): string {
    return sha256(readFileSync(join(this.dir, "manifest.json"), "utf8"));
  }

  event(e: object): void {
    appendFileSync(join(this.dir, "events.jsonl"), canonicalJson({ seq: this.seq++, ...e }) + "\n");
  }

  writeSnapshot(iter: number, json: string, bytes: Uint8Array): void {
    writeFileSync(join(this.dir, "snapshots", `iter_${iter}.json`), json);
    writeFileSync(join(this.dir, "snapshots", `iter_${iter}.particles.bin`), bytes);
  }

  snapshotIters(): number[] {
    const d = join(this.dir, "snapshots");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => /^iter_(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  readSnapshot(iter: number): { json: string; bytes: Uint8Array } {
    return {
      json: readFileSync(join(this.dir, "snapshots", `iter_${iter}.json`), "utf8"),
      bytes: new Uint8Array(readFileSync(join(this.dir, "snapshots", `iter_${iter}.particles.bin`))),
    };
  }

  write(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content);
  }
}
