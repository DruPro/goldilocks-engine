// One definition, two products: each schema built here is both a runtime validator
// (strict: unknown keys are rejected) and a JSON Schema document, and its TypeScript
// type is derived with Static<>. Types and JSON Schemas therefore cannot drift apart.

export type Json = Record<string, unknown>;

export interface Schema<T> {
  readonly json: Json;
  readonly optional: boolean;
  check(v: unknown, path: string, errs: string[]): void;
  readonly _t?: T;
}
export interface OptSchema<T> extends Schema<T> {
  readonly optional: true;
}
export type Static<S> = S extends Schema<infer T> ? T : never;

type Props = Record<string, Schema<unknown>>;
type ReqKeys<P extends Props> = { [K in keyof P]: P[K] extends OptSchema<unknown> ? never : K }[keyof P];
type OptKeys<P extends Props> = { [K in keyof P]: P[K] extends OptSchema<unknown> ? K : never }[keyof P];
type Simplify<T> = { [K in keyof T]: T[K] };
export type StaticObject<P extends Props> = Simplify<
  { [K in ReqKeys<P>]: Static<P[K]> } & { [K in OptKeys<P>]?: Static<P[K]> }
>;

function make<T>(json: Json, check: Schema<T>["check"]): Schema<T> {
  return { json, optional: false, check };
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export const T = {
  String(o: { pattern?: string; minLength?: number; maxLength?: number; description?: string } = {}): Schema<string> {
    const re = o.pattern ? new RegExp(o.pattern) : null;
    return make({ type: "string", ...o }, (v, p, e) => {
      if (typeof v !== "string") return void e.push(`${p}: expected string, got ${typeOf(v)}`);
      if (o.minLength !== undefined && v.length < o.minLength) e.push(`${p}: shorter than ${o.minLength}`);
      if (o.maxLength !== undefined && v.length > o.maxLength) e.push(`${p}: longer than ${o.maxLength}`);
      if (re && !re.test(v)) e.push(`${p}: "${v}" does not match ${o.pattern}`);
    });
  },
  Number(o: { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; description?: string } = {}): Schema<number> {
    return make({ type: "number", ...o }, (v, p, e) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return void e.push(`${p}: expected finite number, got ${typeOf(v)}`);
      if (o.minimum !== undefined && v < o.minimum) e.push(`${p}: ${v} < minimum ${o.minimum}`);
      if (o.maximum !== undefined && v > o.maximum) e.push(`${p}: ${v} > maximum ${o.maximum}`);
      if (o.exclusiveMinimum !== undefined && v <= o.exclusiveMinimum) e.push(`${p}: ${v} must be > ${o.exclusiveMinimum}`);
      if (o.exclusiveMaximum !== undefined && v >= o.exclusiveMaximum) e.push(`${p}: ${v} must be < ${o.exclusiveMaximum}`);
    });
  },
  Integer(o: { minimum?: number; maximum?: number; description?: string } = {}): Schema<number> {
    return make({ type: "integer", ...o }, (v, p, e) => {
      if (typeof v !== "number" || !Number.isInteger(v)) return void e.push(`${p}: expected integer, got ${typeOf(v)}`);
      if (o.minimum !== undefined && v < o.minimum) e.push(`${p}: ${v} < minimum ${o.minimum}`);
      if (o.maximum !== undefined && v > o.maximum) e.push(`${p}: ${v} > maximum ${o.maximum}`);
    });
  },
  Boolean(o: { description?: string } = {}): Schema<boolean> {
    return make({ type: "boolean", ...o }, (v, p, e) => {
      if (typeof v !== "boolean") e.push(`${p}: expected boolean, got ${typeOf(v)}`);
    });
  },
  Enum<const V extends readonly string[]>(values: V, o: { description?: string } = {}): Schema<V[number]> {
    return make({ type: "string", enum: [...values], ...o }, (v, p, e) => {
      if (typeof v !== "string" || !values.includes(v)) e.push(`${p}: expected one of ${values.join("|")}, got ${JSON.stringify(v)}`);
    });
  },
  Array<I>(item: Schema<I>, o: { minItems?: number; maxItems?: number; description?: string } = {}): Schema<I[]> {
    return make({ type: "array", items: item.json, ...o }, (v, p, e) => {
      if (!Array.isArray(v)) return void e.push(`${p}: expected array, got ${typeOf(v)}`);
      if (o.minItems !== undefined && v.length < o.minItems) e.push(`${p}: needs at least ${o.minItems} items`);
      if (o.maxItems !== undefined && v.length > o.maxItems) e.push(`${p}: allows at most ${o.maxItems} items`);
      v.forEach((x, i) => item.check(x, `${p}[${i}]`, e));
    });
  },
  Object<P extends Props>(props: P, o: { description?: string; title?: string } = {}): Schema<StaticObject<P>> {
    const required = Object.keys(props).filter((k) => !props[k].optional);
    const properties: Json = {};
    for (const k of Object.keys(props)) properties[k] = props[k].json;
    return make({ type: "object", ...o, properties, required, additionalProperties: false }, (v, p, e) => {
      if (typeOf(v) !== "object") return void e.push(`${p}: expected object, got ${typeOf(v)}`);
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) if (!(k in props)) e.push(`${p}: unknown key "${k}"`);
      for (const k of Object.keys(props)) {
        if (obj[k] === undefined) {
          if (!props[k].optional) e.push(`${p}: missing required key "${k}"`);
        } else props[k].check(obj[k], `${p}.${k}`, e);
      }
    });
  },
  Record<V>(value: Schema<V>, o: { keyPattern?: string; description?: string } = {}): Schema<Record<string, V>> {
    const re = o.keyPattern ? new RegExp(o.keyPattern) : null;
    const json: Json = { type: "object", additionalProperties: value.json };
    if (o.keyPattern) json.propertyNames = { pattern: o.keyPattern };
    if (o.description) json.description = o.description;
    return make(json, (v, p, e) => {
      if (typeOf(v) !== "object") return void e.push(`${p}: expected object, got ${typeOf(v)}`);
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (re && !re.test(k)) e.push(`${p}: key "${k}" does not match ${o.keyPattern}`);
        value.check(x, `${p}.${k}`, e);
      }
    });
  },
  Union<S extends Schema<unknown>[]>(options: S, o: { description?: string } = {}): Schema<Static<S[number]>> {
    return make({ anyOf: options.map((s) => s.json), ...o }, (v, p, e) => {
      const all: string[][] = [];
      for (const s of options) {
        const errs: string[] = [];
        s.check(v, p, errs);
        if (errs.length === 0) return;
        all.push(errs);
      }
      const best = all.reduce((a, b) => (b.length < a.length ? b : a));
      e.push(`${p}: matches none of ${options.length} alternatives; closest: ${best.join("; ")}`);
    });
  },
  Optional<V>(s: Schema<V>): OptSchema<V> {
    return { ...s, optional: true } as OptSchema<V>;
  },
  Null(): Schema<null> {
    return make({ type: "null" }, (v, p, e) => {
      if (v !== null) e.push(`${p}: expected null, got ${typeOf(v)}`);
    });
  },
  Nullable<V>(s: Schema<V>): Schema<V | null> {
    return T.Union([s, T.Null()]) as Schema<V | null>;
  },
};

export class SchemaError extends Error {
  constructor(readonly what: string, readonly errors: string[]) {
    super(`${what} failed schema validation:\n  - ${errors.slice(0, 20).join("\n  - ")}${errors.length > 20 ? `\n  … ${errors.length - 20} more` : ""}`);
  }
}

export function validate<V>(schema: Schema<V>, value: unknown, what: string): V {
  const errs: string[] = [];
  schema.check(value, "$", errs);
  if (errs.length) throw new SchemaError(what, errs);
  return value as V;
}

export function errorsOf<V>(schema: Schema<V>, value: unknown): string[] {
  const errs: string[] = [];
  schema.check(value, "$", errs);
  return errs;
}

export function jsonSchema(schema: Schema<unknown>, id: string, title: string): Json {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: id, title, ...schema.json };
}
