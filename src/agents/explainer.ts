// Explainer agent: writes the prose of the brief. It gets the numbers as named
// placeholders and may only refer to them as {{name}}; code substitutes the values.
// Any other digit is rejected, so every number in the brief comes from code.

import { T, type Static } from "../model/schema.ts";
import type { LlmClient } from "./llm.ts";
import { checkProse } from "./prose.ts";

export const SECTIONS = ["recommended", "solution_map", "requirements", "ledger", "next_measurements"] as const;
export type Section = (typeof SECTIONS)[number];

export const ExplainOutSchema = T.Object({
  sections: T.Array(T.Object({ section: T.Enum(SECTIONS), text: T.String() }), { minItems: 1 }),
});
export type ExplainOut = Static<typeof ExplainOutSchema>;

export interface ExplainContext {
  title: string;
  facts: Record<Section, string>; // what each section shows, in words, with placeholder names
  values: Record<string, string>; // placeholder name → formatted value (filled in by code)
  ids: string[];
}

export const EXPLAINER_SYSTEM = `You are the explainer agent inside an engineering decision engine.
Code has computed every result in the brief. You write a short plain-language paragraph
for each section, explaining what the results mean for the decision.

Rules:
- Never write a digit. When you need a number, write its placeholder exactly as given,
  for example {{rec1_p_zone}}; code fills in the value.
- Use only the placeholders you are given, and refer to candidates, roots and parameters
  by their ids.
- Do not change, reorder or second-guess the results; explain them.
- At most one paragraph per section, under about a hundred words.
- Do not state facts about real vendors, products or prices.
Answer with JSON that matches the schema exactly.`;

export function explainPrompt(c: ExplainContext): string {
  return [
    `<title>${c.title}</title>`,
    ...SECTIONS.map((s) => `<section name="${s}">\n${c.facts[s]}\n</section>`),
    `<placeholders>\n${Object.keys(c.values).sort().map((k) => `{{${k}}}`).join(" ")}\n</placeholders>`,
    "Write one paragraph per section.",
  ].join("\n\n");
}

export async function explain(client: LlmClient, model: string, c: ExplainContext): Promise<{ texts: Partial<Record<Section, string>>; key: string }> {
  const placeholders = Object.keys(c.values);
  const r = await client.ask({
    agent: "explainer",
    model,
    system: EXPLAINER_SYSTEM,
    user: explainPrompt(c),
    schema: ExplainOutSchema,
    max_tokens: 3000,
    accept: (raw) => {
      const errors: string[] = [];
      const seen = new Set<string>();
      const texts: Partial<Record<Section, string>> = {};
      for (const s of raw.sections) {
        if (seen.has(s.section)) errors.push(`section ${s.section} appears twice`);
        seen.add(s.section);
        errors.push(...checkProse(`sections.${s.section}`, s.text, { ids: c.ids, placeholders, maxLength: 900 }));
        texts[s.section] = s.text;
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: texts };
    },
  });
  return { texts: r.value, key: r.key };
}
