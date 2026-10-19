// Guard for LLM-written prose: all numbers come from code. Text may name known
// identifiers (node, root and candidate ids, which can contain digits) and may use
// {{placeholders}} that code fills in; any other digit is rejected, so an agent cannot
// slip an invented or altered figure into the brief.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.@-]+)\s*\}\}/g;

export function checkProse(field: string, text: string, opts: { ids: Iterable<string>; placeholders?: Iterable<string>; maxLength: number }): string[] {
  const errors: string[] = [];
  if (text.length > opts.maxLength) errors.push(`${field}: ${text.length} characters, limit is ${opts.maxLength}`);
  const allowed = new Set(opts.placeholders ?? []);
  let stripped = text.replace(PLACEHOLDER, (_m, name: string) => {
    if (!allowed.has(name)) errors.push(`${field}: unknown placeholder {{${name}}}`);
    return " ";
  });
  // Remove known identifiers, longest first so "a_b" is not partly matched by "a".
  for (const id of [...new Set(opts.ids)].sort((a, b) => b.length - a.length)) if (/\d/.test(id)) stripped = stripped.split(id).join(" ");
  const m = /[^\s]{0,12}\d[^\s]{0,12}/.exec(stripped);
  if (m) errors.push(`${field}: contains a number ("${m[0]}"); numbers must come from {{placeholders}}`);
  return errors;
}

export function renderProse(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => values[name] ?? `{{${name}}}`);
}

/** Pull every number written in free text (used to check extraction fidelity). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map((m) => Number(m[0]));
}
