// Human gates. A person approves (a) the root requirements and (b) every new
// likelihood before it is applied. An approval binds to a hash of the content it
// approves, so a file edited after approval is refused by the loader; the run log
// records every approval when it is used.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { freeVars, parse } from "./core/expr.ts";
import { canonicalJson, sha256 } from "./io/canon.ts";
import { validate } from "./model/schema.ts";
import { EvidenceSchema, RootsFileSchema, type Evidence, type RootsFile } from "./model/types.ts";

/** Hash of an evidence record without its approval fields. */
export function evidenceContentHash(ev: Evidence): string {
  const { approved_by: _a, approved_at: _b, approval_sha256: _c, ...content } = ev;
  return sha256(canonicalJson(content));
}

/** Hash of the roots without the approval record. */
export function rootsContentHash(r: RootsFile): string {
  return sha256(canonicalJson({ roots: r.roots }));
}

export class ApprovalError extends Error {}

/** Loader check: a hash-bound approval must still match the content. */
export function checkEvidenceApproval(ev: Evidence, where: string): void {
  if (ev.approval_sha256 !== undefined && ev.approval_sha256 !== evidenceContentHash(ev))
    throw new ApprovalError(`${where}: evidence ${ev.id} was changed after ${ev.approved_by} approved it; approve it again`);
}

export function checkRootsApproval(r: RootsFile, where: string): void {
  if (r.approval.content_sha256 !== undefined && r.approval.content_sha256 !== rootsContentHash(r))
    throw new ApprovalError(`${where}: the roots were changed after ${r.approval.approved_by} approved them; approve them again`);
}

export interface ApproveOptions {
  by: string;
  note?: string;
  now?: Date;
  /** Asked before signing; return false to refuse. Defaults to accepting (non-interactive use with --yes). */
  confirm?: (summary: string) => boolean;
  out?: string;
}

function parseYaml(raw: string, what: string): unknown {
  try {
    return Bun.YAML.parse(raw);
  } catch (e) {
    throw new ApprovalError(`${what}: invalid YAML: ${(e as Error).message}`);
  }
}

function header(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => l.startsWith("#") && !/DRAFT|To approve|approve, fill|refuses this file|Check the observation|and pass this file|then set approved_by/.test(l))
    .join("\n");
}

/** Sign an evidence file: validates everything but the approval, then binds the approval to the content. */
export function approveEvidence(path: string, o: ApproveOptions): { path: string; evidence: Evidence; summary: string } {
  if (!o.by.trim()) throw new ApprovalError("an approval needs a person's name (--by)");
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw, path) as Record<string, unknown>;
  const candidate = { ...data, approved_by: o.by, approved_at: (o.now ?? new Date()).toISOString() } as Record<string, unknown>;
  delete candidate.approval_sha256;
  if (typeof candidate.note === "string") candidate.note = (candidate.note as string).replace(/^DRAFT \(evidence agent\): /, "");
  const ev = validate(EvidenceSchema, candidate, path);
  const obs = ev.observation as Record<string, unknown>;
  const summary = [
    `evidence ${ev.id} for ${ev.target_node}`,
    `  observation: ${JSON.stringify(obs)}`,
    `  likelihood: ${ev.likelihood}, noise ${ev.noise}, source ${ev.source}`,
    ev.note ? `  note: ${ev.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (o.confirm && !o.confirm(summary)) throw new ApprovalError("approval declined");
  if (o.note) ev.note = ev.note ? `${ev.note} | approval: ${o.note}` : `approval: ${o.note}`;
  ev.approval_sha256 = evidenceContentHash(ev);
  const out = o.out ?? path;
  writeFileSync(out, `${header(raw)}\n# Approved by ${o.by} at ${ev.approved_at}; content sha256 ${ev.approval_sha256}.\n${Bun.YAML.stringify(ev, null, 2)}\n`.replace(/^\n/, ""));
  return { path: out, evidence: ev, summary };
}

/** Sign a roots draft: checks bands, weights and formula syntax, then writes the approved roots.yaml. */
export function approveRoots(path: string, o: ApproveOptions): { path: string; roots: RootsFile; summary: string } {
  if (!o.by.trim()) throw new ApprovalError("an approval needs a person's name (--by)");
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw, path) as RootsFile;
  const approval = { approved_by: o.by, approved_at: (o.now ?? new Date()).toISOString(), ...(o.note ? { note: o.note } : {}) };
  const roots = validate(RootsFileSchema, { ...data, approval }, path);
  const wsum = roots.roots.reduce((s, r) => s + r.weight, 0);
  if (Math.abs(wsum - 1) > 1e-9) throw new ApprovalError(`root weights sum to ${wsum}, not 1`);
  for (const r of roots.roots) {
    freeVars(parse(r.metric)); // throws on a malformed formula
    const ok = r.sense === "upper" ? r.upper !== undefined && r.upper > r.target : r.sense === "lower" ? r.lower !== undefined && r.lower < r.target : r.lower !== undefined && r.upper !== undefined && r.lower < r.target && r.target < r.upper;
    if (!ok) throw new ApprovalError(`root ${r.id}: band and target are inconsistent for sense ${r.sense}`);
  }
  const summary = roots.roots
    .map((r) => `  ${r.id}: ${r.sense === "upper" ? `<= ${r.upper}` : r.sense === "lower" ? `>= ${r.lower}` : `[${r.lower}, ${r.upper}]`} (target ${r.target}, weight ${r.weight.toFixed(3)}, ${r.source})`)
    .join("\n");
  if (o.confirm && !o.confirm(`roots:\n${summary}`)) throw new ApprovalError("approval declined");
  roots.approval.content_sha256 = rootsContentHash(roots);
  const out = o.out ?? (basename(path) === "roots.draft.yaml" ? join(dirname(path), "roots.yaml") : path);
  writeFileSync(out, `# Approved by ${o.by} at ${roots.approval.approved_at}; content sha256 ${roots.approval.content_sha256}.\n${Bun.YAML.stringify(roots, null, 2)}\n`);
  return { path: out, roots, summary };
}
