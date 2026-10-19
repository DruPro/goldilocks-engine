// Input loading: YAML → strict schema validation → typed objects, plus a content
// hash of every file's raw bytes for the manifest. Unapproved roots or evidence
// cannot get past the schemas (approval records are required fields).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkEvidenceApproval, checkRootsApproval } from "../approval.ts";
import { sha256 } from "../io/canon.ts";
import { validate } from "./schema.ts";
import {
  CatalogFileSchema,
  ConfigSchema,
  DecompositionsFileSchema,
  EvidenceSchema,
  ProblemFileSchema,
  RootsFileSchema,
  TruthFileSchema,
  type CatalogFile,
  type Config,
  type Decomposition,
  type Evidence,
  type ProblemFile,
  type RootsFile,
  type TruthFile,
} from "./types.ts";

export interface InputFile {
  path: string; // relative to the input directory
  sha256: string;
  raw: string;
}

export interface Inputs {
  dir: string;
  problem: ProblemFile;
  roots: RootsFile;
  catalog: CatalogFile;
  decompositions: Decomposition[];
  config: Config;
  evidence: Evidence[];
  truth: TruthFile | null;
  files: InputFile[];
}

export const INPUT_NAMES = ["problem.yaml", "roots.yaml", "catalog.yaml", "decompositions.yaml", "config.yaml"] as const;

export function parseYaml(raw: string, what: string): unknown {
  try {
    return Bun.YAML.parse(raw);
  } catch (e) {
    throw new Error(`${what}: invalid YAML: ${(e as Error).message}`);
  }
}

function readInput(dir: string, rel: string, files: InputFile[]): unknown {
  const raw = readFileSync(join(dir, rel), "utf8");
  files.push({ path: rel, sha256: sha256(raw), raw });
  return parseYaml(raw, rel);
}

export function loadInputs(dir: string): Inputs {
  const files: InputFile[] = [];
  for (const n of INPUT_NAMES) if (!existsSync(join(dir, n))) throw new Error(`missing input file ${join(dir, n)}`);
  const problem = validate(ProblemFileSchema, readInput(dir, "problem.yaml", files), "problem.yaml");
  const roots = validate(RootsFileSchema, readInput(dir, "roots.yaml", files), "roots.yaml");
  checkRootsApproval(roots, "roots.yaml");
  const catalog = validate(CatalogFileSchema, readInput(dir, "catalog.yaml", files), "catalog.yaml");
  const decomp = validate(DecompositionsFileSchema, readInput(dir, "decompositions.yaml", files), "decompositions.yaml");
  const config = validate(ConfigSchema, readInput(dir, "config.yaml", files), "config.yaml");
  const evidence: Evidence[] = [];
  const evDir = join(dir, "evidence");
  if (existsSync(evDir)) {
    for (const f of readdirSync(evDir).filter((x) => x.endsWith(".yaml") || x.endsWith(".yml")).sort()) {
      const rel = `evidence/${f}`;
      const ev = validate(EvidenceSchema, readInput(dir, rel, files), rel);
      checkEvidenceApproval(ev, rel);
      evidence.push(ev);
    }
  }
  let truth: TruthFile | null = null;
  if (existsSync(join(dir, "truth.yaml"))) truth = validate(TruthFileSchema, readInput(dir, "truth.yaml", files), "truth.yaml");
  const ids = new Set<string>();
  for (const e of evidence) {
    if (ids.has(e.id)) throw new Error(`duplicate evidence id ${e.id}`);
    ids.add(e.id);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir, problem, roots, catalog, decompositions: decomp.decompositions, config, evidence, truth, files };
}

/** Apply dotted-path overrides such as "particles=2000" or "utility.miss_penalty_usd=1e5". */
export function applyOverrides(config: Config, overrides: string[]): Config {
  const out = structuredClone(config) as Record<string, unknown>;
  for (const o of overrides) {
    const eq = o.indexOf("=");
    if (eq < 1) throw new Error(`override "${o}" must look like key=value`);
    const path = o.slice(0, eq).split(".");
    const value = parseYaml(o.slice(eq + 1), `override ${o}`);
    let cur = out;
    for (const k of path.slice(0, -1)) {
      if (typeof cur[k] !== "object" || cur[k] === null) throw new Error(`override path ${o} does not exist`);
      cur = cur[k] as Record<string, unknown>;
    }
    cur[path[path.length - 1]] = value;
  }
  return validate(ConfigSchema, out, "config (with overrides)");
}
