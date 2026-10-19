// Evidence drafting agent: turns a person's free-text measurement notes into an
// Evidence record (observation + likelihood + noise). Every number in the observation
// must appear in the notes, so the agent can structure data but never invent it. The
// draft has an empty approved_by, so it cannot be applied until a person approves it.

import { T, type Static } from "../model/schema.ts";
import type { Evidence, ParamNode } from "../model/types.ts";
import { sha256 } from "../io/canon.ts";
import type { LlmClient } from "./llm.ts";
import { numbersIn } from "./prose.ts";

export const EvidenceOutSchema = T.Object({
  observation: T.Object({
    kind: T.Enum(["values", "binomial", "interval"] as const),
    values: T.Array(T.Number()),
    k: T.Nullable(T.Integer()),
    n: T.Nullable(T.Integer()),
    lo: T.Nullable(T.Number()),
    hi: T.Nullable(T.Number()),
  }),
  likelihood: T.Enum(["normal", "lognormal", "binomial", "interval"] as const),
  noise: T.Number(),
  source: T.Enum(["measured", "document", "expert"] as const),
  note: T.String(),
});
export type EvidenceOut = Static<typeof EvidenceOutSchema>;

export const EVIDENCE_SYSTEM = `You are the evidence-drafting agent inside an engineering decision engine.
A person describes a measurement in free text. You PROPOSE how to record it: the
observation, a likelihood model and its noise. A person approves the draft before it is
used; code applies it.

Rules:
- Copy observed numbers exactly from the notes; never compute, round or invent them.
- kind "values" (with likelihood normal or lognormal) for repeated readings; "binomial"
  for k successes out of n trials; "interval" for a stated range. Unused fields are null
  (values is an empty list when unused).
- noise is the measurement error: an sd in the node's unit for normal, a log-scale sd for
  lognormal, the edge softness for interval. Use the node's default unless the notes say
  otherwise.
- source is "measured" for your own tests, "document" for published material, "expert"
  for a person's judgement.
Answer with JSON that matches the schema exactly.`;

export function convertEvidence(raw: EvidenceOut, node: ParamNode, notes: string): { ok: true; value: Omit<Evidence, "id" | "approved_by"> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = raw.observation;
  const inNotes = new Set(numbersIn(notes));
  const check = (x: number | null, what: string) => {
    if (x !== null && !inNotes.has(x)) errors.push(`${what} ${x} does not appear in the notes`);
  };
  let observation: Evidence["observation"] | null = null;
  if (o.kind === "values") {
    if (raw.likelihood !== "normal" && raw.likelihood !== "lognormal") errors.push("values need a normal or lognormal likelihood");
    if (o.values.length === 0) errors.push("values is empty");
    o.values.forEach((v, i) => check(v, `values[${i}]`));
    if (raw.likelihood === "lognormal" && o.values.some((v) => !(v > 0))) errors.push("lognormal values must be positive");
    observation = { values: o.values };
  } else if (o.kind === "binomial") {
    if (raw.likelihood !== "binomial") errors.push("binomial observations need the binomial likelihood");
    if (o.k === null || o.n === null || !(o.n >= 1 && o.k >= 0 && o.k <= o.n)) errors.push("binomial needs 0 <= k <= n and n >= 1");
    check(o.k, "k");
    check(o.n, "n");
    observation = { k: o.k ?? 0, n: o.n ?? 1 };
  } else {
    if (raw.likelihood !== "interval") errors.push("interval observations need the interval likelihood");
    if (o.lo === null || o.hi === null || !(o.hi > o.lo)) errors.push("interval needs lo < hi");
    check(o.lo, "lo");
    check(o.hi, "hi");
    observation = { lo: o.lo ?? 0, hi: o.hi ?? 1 };
  }
  if (!(raw.noise > 0)) errors.push("noise must be > 0");
  if (raw.note.length > 400) errors.push("note is longer than 400 characters");
  for (const x of numbersIn(raw.note.split(node.id).join(" "))) if (!inNotes.has(x)) errors.push(`note mentions ${x}, which is not in the notes`);
  if (errors.length || !observation) return { ok: false, errors };
  return { ok: true, value: { target_node: node.id, observation, likelihood: raw.likelihood, noise: raw.noise, source: raw.source, note: `DRAFT (evidence agent): ${raw.note}` } };
}

export function evidencePrompt(node: ParamNode, notes: string): string {
  const m = node.measurement;
  return [
    `<node>\nid: ${node.id}\nunit: ${node.unit ?? "(none)"}\ndescription: ${node.rationale}\ndefault measurement model: ${m ? `${m.likelihood}, noise ${m.noise}, ${m.replicates ?? 1} replicate(s)` : "(none)"}\n</node>`,
    `<notes>\n${notes}\n</notes>`,
    "Draft the evidence record.",
  ].join("\n\n");
}

export async function draftEvidence(client: LlmClient, model: string, node: ParamNode, notes: string): Promise<{ evidence: Evidence; key: string }> {
  const r = await client.ask({
    agent: "evidence",
    model,
    system: EVIDENCE_SYSTEM,
    user: evidencePrompt(node, notes),
    schema: EvidenceOutSchema,
    max_tokens: 1200,
    accept: (raw) => convertEvidence(raw, node, notes),
  });
  const id = `ev-draft-${node.id.replace("@", "-at-")}-${sha256(notes).slice(0, 8)}`;
  return { evidence: { id, ...r.value, approved_by: "" }, key: r.key };
}
