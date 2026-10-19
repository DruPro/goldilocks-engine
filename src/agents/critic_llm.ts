// Critic agent (LLM half). Reads the code critic's flags and a summary of the state,
// and writes advice: what each flag means, what to check, and which parameters may
// be missing. Advice is stored next to the run (advice/iter_<k>.json), never in a
// snapshot, so it cannot change any score, ranking or selection.

import { T, type Static } from "../model/schema.ts";
import type { LlmClient } from "./llm.ts";
import { checkProse } from "./prose.ts";

export const CriticOutSchema = T.Object({
  summary: T.String(),
  concerns: T.Array(T.Object({ flag: T.String(), explanation: T.String(), suggestion: T.String() })),
  missing_parameters: T.Array(T.Object({ name: T.String(), attach_to: T.String(), why: T.String() })),
});
export type CriticAdvice = Static<typeof CriticOutSchema>;

export interface CriticContext {
  iteration: number;
  flags: { kind: string; severity: string; message: string }[];
  recommended: string[];
  goldilocks: string[];
  top_values: { node: string; action: string | null }[];
  roots: { id: string; description: string }[];
  node_ids: string[];
  candidate_ids: string[];
}

export const CRITIC_SYSTEM = `You are the critic agent inside an engineering decision engine.
Code has already scored, ranked and selected the candidate solutions and has run its own
checks (posterior predictive checks, empty set, conflicting roots, roots at risk, low
effective sample size). You write advice for a human reviewer: what each flag means in
plain words, what they could check, and which parameters the model may be missing.

Rules:
- You cannot change or reorder any result; do not argue for a different ranking.
- Do not write any numbers. Refer to quantities and candidates by their ids.
- "flag" must be one of the flag kinds you are given, or "other".
- "attach_to" must be an existing node id or root id; "name" is a snake_case id for the
  suspected missing parameter.
- Keep it short: at most eight concerns and five missing parameters.
- Do not state facts about real vendors, products or prices.
Answer with JSON that matches the schema exactly.`;

export function criticPrompt(c: CriticContext): string {
  return [
    `<iteration>${c.iteration}</iteration>`,
    `<flags>\n${c.flags.length ? c.flags.map((f) => `- [${f.severity}] ${f.kind}: ${f.message}`).join("\n") : "(none)"}\n</flags>`,
    `<recommended>\n${c.recommended.join("\n") || "(none)"}\n</recommended>`,
    `<goldilocks_set>\n${c.goldilocks.join("\n") || "(empty)"}\n</goldilocks_set>`,
    `<most_valuable_information>\n${c.top_values.map((v) => `- ${v.node} (${v.action ?? "no action available"})`).join("\n")}\n</most_valuable_information>`,
    `<roots>\n${c.roots.map((r) => `- ${r.id}: ${r.description}`).join("\n")}\n</roots>`,
    `<node_ids>\n${c.node_ids.join(", ")}\n</node_ids>`,
    "Write your advice.",
  ].join("\n\n");
}

export async function critique(client: LlmClient, model: string, c: CriticContext): Promise<{ advice: CriticAdvice; key: string }> {
  const kinds = new Set([...c.flags.map((f) => f.kind), "other"]);
  const known = new Set([...c.node_ids, ...c.roots.map((r) => r.id)]);
  const ids = [...c.node_ids, ...c.roots.map((r) => r.id), ...c.candidate_ids, ...kinds];
  const r = await client.ask({
    agent: "critic",
    model,
    system: CRITIC_SYSTEM,
    user: criticPrompt(c),
    schema: CriticOutSchema,
    max_tokens: 2000,
    accept: (raw) => {
      const errors: string[] = [];
      if (raw.concerns.length > 8) errors.push("at most eight concerns");
      if (raw.missing_parameters.length > 5) errors.push("at most five missing parameters");
      errors.push(...checkProse("summary", raw.summary, { ids, maxLength: 800 }));
      raw.concerns.forEach((x, i) => {
        if (!kinds.has(x.flag)) errors.push(`concerns[${i}].flag "${x.flag}" is not one of: ${[...kinds].join(", ")}`);
        errors.push(...checkProse(`concerns[${i}].explanation`, x.explanation, { ids, maxLength: 600 }));
        errors.push(...checkProse(`concerns[${i}].suggestion`, x.suggestion, { ids, maxLength: 400 }));
      });
      raw.missing_parameters.forEach((m, i) => {
        if (!/^[a-z][a-z0-9_]*$/.test(m.name)) errors.push(`missing_parameters[${i}].name must be snake_case`);
        if (!known.has(m.attach_to)) errors.push(`missing_parameters[${i}].attach_to "${m.attach_to}" is not a node or root id`);
        errors.push(...checkProse(`missing_parameters[${i}].why`, m.why, { ids, maxLength: 400 }));
      });
      return errors.length ? { ok: false, errors } : { ok: true, value: raw };
    },
  });
  return { advice: r.value, key: r.key };
}
