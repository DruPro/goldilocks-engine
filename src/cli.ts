#!/usr/bin/env bun
// gde — Goldilocks Discovery Engine command line.
//
//   gde run    [--inputs DIR] [--oracle truth|prior] [--llm] [--fresh] [--set key=value ...]
//   gde resume <run_id> [--from-iter K] [--evidence FILE ...] [--fresh]
//   gde replay <run_id>                       (offline: reads the run's llm_cache only)
//   gde draft-roots [--inputs DIR] [--out FILE]
//   gde draft-evidence <run_id> --notes "..." [--node ID]
//   gde init <dir>                            (new problem from templates/blank)
//   gde approve roots|evidence <file> --by NAME [--note TEXT] [--yes] [--out FILE]
//   gde rerun  <run_id> --with FILE [--with FILE ...]   (new run + diff of the two reports)
//   gde schemas [--out DIR]
// Common: --runs DIR (default runs), --cache DIR (shared LLM cache, default cache/llm).
// LLM calls need ANTHROPIC_API_KEY; replay never makes them.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLM_ON } from "./agents/index.ts";
import { approveEvidence, approveRoots } from "./approval.ts";
import { cmdDraftEvidence, cmdDraftRoots, cmdReplay, cmdRerun, cmdResume, cmdRun, type OracleMode, type RunResult } from "./commands.ts";
import { jsonSchema } from "./model/schema.ts";
import { ALL_SCHEMAS } from "./model/types.ts";

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags.set(key, [...(flags.get(key) ?? []), val]);
    } else pos.push(a);
  }
  const one = (k: string, d?: string) => flags.get(k)?.[flags.get(k)!.length - 1] ?? d;
  return { pos, one, many: (k: string) => flags.get(k) ?? [], has: (k: string) => flags.has(k) };
}

function summary(r: RunResult) {
  const s = r.state;
  const ids = (xs: number[]) => xs.map((c) => s.pool.cands[c].id);
  console.log(`run ${r.runId}: ${s.status} after iteration ${s.iter}`);
  console.log(`  Goldilocks set (${s.gl.G.length}): ${ids(s.gl.G).join(", ") || "empty"}`);
  if (s.status === "awaiting_evidence") {
    const node = s.plan.next!.node;
    console.log(`  waiting for a measurement of ${node}. Draft one from your notes, approve it, and resume:`);
    console.log(`    gde draft-evidence ${r.runId} --notes "what you measured"`);
    console.log(`    gde resume ${r.runId} --evidence path/to/approved.yaml`);
  }
  console.log(`  report: ${join(r.dir, "report.md")}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = parse(rest);
  const runs = a.one("runs", "runs")!;
  const llmOpts = { fresh: a.has("fresh"), sharedCache: a.one("cache") };
  switch (cmd) {
    case "run": {
      const oracle = a.one("oracle");
      const mode: OracleMode = oracle === undefined ? null : oracle === "true" ? "truth" : (oracle as OracleMode);
      if (mode !== null && mode !== "truth" && mode !== "prior") throw new Error("--oracle takes truth or prior");
      const overrides = [...(a.has("llm") ? [LLM_ON] : []), ...a.many("set")];
      if (a.has("llm") && !process.env.ANTHROPIC_API_KEY)
        console.error("warning: ANTHROPIC_API_KEY is not set, so this run succeeds only if every answer it needs is already in the shared cache.");
      summary(await cmdRun({ inputsDir: a.one("inputs", "fixtures/cloud")!, runsRoot: runs, oracle: mode, overrides, ...llmOpts }));
      return 0;
    }
    case "resume": {
      if (!a.pos[0]) throw new Error("usage: gde resume <run_id> [--from-iter K] [--evidence FILE ...]");
      const from = a.one("from-iter");
      summary(await cmdResume({ runsRoot: runs, runId: a.pos[0], fromIter: from === undefined ? undefined : Number(from), evidenceFiles: a.many("evidence"), ...llmOpts }));
      return 0;
    }
    case "replay": {
      if (!a.pos[0]) throw new Error("usage: gde replay <run_id>");
      const r = await cmdReplay({ runsRoot: runs, runId: a.pos[0] });
      console.log(`replay ${a.pos[0]}: ${r.ok ? "IDENTICAL" : "DIFFERS"} (${r.compared} snapshots compared, no network)`);
      for (const m of r.mismatches) console.log(`  mismatch: ${m}`);
      return r.ok ? 0 : 1;
    }
    case "draft-roots": {
      const r = await cmdDraftRoots({ inputsDir: a.one("inputs", "fixtures/cloud")!, out: a.one("out"), ...llmOpts });
      console.log(`wrote ${r.path} (unapproved draft; drivers: ${r.drivers.join(", ") || "none"})`);
      return 0;
    }
    case "draft-evidence": {
      const notes = a.one("notes");
      if (!a.pos[0] || !notes) throw new Error('usage: gde draft-evidence <run_id> --notes "..." [--node ID]');
      const r = await cmdDraftEvidence({ runsRoot: runs, runId: a.pos[0], notes, node: a.one("node"), ...llmOpts });
      console.log(`wrote ${r.path} (unapproved draft ${r.id})`);
      return 0;
    }
    case "init": {
      const dir = a.pos[0];
      if (!dir) throw new Error("usage: gde init <dir>");
      if (existsSync(dir)) throw new Error(`${dir} already exists`);
      cpSync(join(import.meta.dir, "..", "templates", "blank"), dir, { recursive: true });
      console.log(`created ${dir} from the blank template. Next: edit problem.yaml and catalog.yaml, then`);
      console.log(`  gde draft-roots --inputs ${dir}   (optional, needs ANTHROPIC_API_KEY)`);
      console.log(`  gde approve roots ${dir}/roots.yaml --by "Your Name"`);
      console.log(`  gde run --inputs ${dir}`);
      return 0;
    }
    case "approve": {
      const [what, file] = a.pos;
      const by = a.one("by");
      if (!["roots", "evidence"].includes(what ?? "") || !file || !by) throw new Error("usage: gde approve roots|evidence <file> --by NAME [--note TEXT] [--yes] [--out FILE]");
      let confirmFn: ((s: string) => boolean) | undefined;
      if (!a.has("yes")) {
        if (!process.stdin.isTTY) throw new Error("approval needs a person: run it in a terminal, or pass --yes to confirm you reviewed the file");
        confirmFn = (summary) => {
          console.log(summary);
          return confirm(`Approve this as ${by}?`);
        };
      }
      const r = what === "roots" ? approveRoots(file, { by, note: a.one("note"), confirm: confirmFn, out: a.one("out") }) : approveEvidence(file, { by, note: a.one("note"), confirm: confirmFn, out: a.one("out") });
      if (a.has("yes")) console.log(r.summary);
      console.log(`approved by ${by}: wrote ${r.path}`);
      return 0;
    }
    case "rerun": {
      const withFiles = a.many("with");
      if (!a.pos[0] || withFiles.length === 0) throw new Error("usage: gde rerun <run_id> --with FILE [--with FILE ...]");
      const r = await cmdRerun({ runsRoot: runs, runId: a.pos[0], withFiles, ...llmOpts });
      console.log(r.summary);
      console.log(`  new run: ${r.newRunId}; diff: ${join(r.dir, "diff.md")}`);
      return 0;
    }
    case "schemas": {
      const out = a.one("out", join(import.meta.dir, "..", "schemas"))!;
      mkdirSync(out, { recursive: true });
      for (const [name, s] of Object.entries(ALL_SCHEMAS)) writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(jsonSchema(s, `https://goldilocks.local/schemas/${name}.schema.json`, name), null, 2) + "\n");
      console.log(`wrote ${Object.keys(ALL_SCHEMAS).length} schemas to ${out}`);
      return 0;
    }
    default:
      console.error("usage: gde init|run|resume|replay|draft-roots|draft-evidence|approve|rerun|schemas  (see src/cli.ts header)");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
