// LLM access for the agents. Three guarantees live here:
//  1. Every response passes a strict schema (plus the agent's semantic checks) before
//     anything else sees it. A rejected answer is retried at most twice, with the
//     errors fed back; the third rejection throws.
//  2. Every request and response is cached, keyed by sha256 of canonical JSON of
//     (model, system prompt, user prompt, schema). `run` reads the shared cache first,
//     so a second run makes no calls; `replay` reads only the run's own llm_cache/.
//  3. Determinism never relies on sampling parameters; it comes from the cache.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, canonicalJsonPretty, sha256 } from "../io/canon.ts";
import { errorsOf, type Json, type Schema } from "../model/schema.ts";

export interface LlmRequest {
  agent: string;
  model: string;
  system: string;
  user: string;
  schema: Json; // API-compatible JSON Schema
  max_tokens: number;
}

export interface LlmResponse {
  text: string;
  model: string | null; // the model the API reports having used
  stop_reason: string | null;
  usage: Record<string, number> | null;
}

export interface Transport {
  name: string;
  call(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmRejectedError extends Error {
  constructor(readonly agent: string, readonly attempts: { key: string; errors: string[] }[]) {
    super(
      `${agent}: every attempt failed validation (${attempts.length} attempts); refusing to continue.\n` +
        attempts.map((a, i) => `  attempt ${i + 1} (${a.key.slice(0, 12)}): ${a.errors.slice(0, 5).join("; ")}`).join("\n"),
    );
  }
}

// ------------------------------------------------------------------ transports

export const ANTHROPIC_VERSION = "2023-06-01";

/** Claude Messages API with JSON-schema structured output (output_config.format). */
export function anthropicTransport(apiKey = process.env.ANTHROPIC_API_KEY, baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"): Transport {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; live LLM calls need it (replay never does)");
  return {
    name: "anthropic",
    async call(req) {
      const body = {
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { format: { type: "json_schema", schema: req.schema } },
      };
      let lastErr = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (res.ok) {
          const data = JSON.parse(text) as { content: { type: string; text?: string }[]; model?: string; stop_reason?: string; usage?: Record<string, number> };
          return {
            text: data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
            model: data.model ?? null,
            stop_reason: data.stop_reason ?? null,
            usage: data.usage ?? null,
          };
        }
        lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`;
        if (![429, 500, 502, 503, 529].includes(res.status)) break;
        await Bun.sleep(1000 * 2 ** attempt);
      }
      throw new Error(`Claude API request failed for ${req.agent}: ${lastErr}`);
    },
  };
}

/** Used by replay: any cache miss is an error, never a network call. */
export const offlineTransport: Transport = {
  name: "offline",
  async call(req) {
    throw new Error(`no network in replay: ${req.agent} needs a response that is not in the run's llm_cache`);
  },
};

/** Test double: answers from a function of the request, counting calls. */
export function scriptedTransport(respond: (req: LlmRequest, n: number) => unknown): Transport & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name: "scripted",
    calls,
    async call(req) {
      calls.push(req);
      const out = respond(req, calls.length);
      return { text: typeof out === "string" ? out : JSON.stringify(out), model: `${req.model} (scripted)`, stop_reason: "end_turn", usage: null };
    },
  };
}

// ------------------------------------------------------------------ cache

export interface CacheEntry {
  key: string;
  agent: string;
  request: Omit<LlmRequest, "agent">;
  response: LlmResponse;
  transport: string;
  recorded_at: string;
}

export function cacheKey(req: Pick<LlmRequest, "model" | "system" | "user" | "schema">): string {
  return sha256(canonicalJson({ model: req.model, system: req.system, user: req.user, schema: req.schema }));
}

export type CacheMode = "run" | "fresh" | "replay";

export class LlmCache {
  constructor(
    readonly runDir: string | null, // runs/<id>/llm_cache
    readonly sharedDir: string | null, // project-level content-addressed store
    readonly mode: CacheMode,
  ) {
    for (const d of [runDir, sharedDir]) if (d) mkdirSync(d, { recursive: true });
  }

  get(key: string): { entry: CacheEntry; where: "run" | "shared" } | null {
    const read = (dir: string | null) => (dir && existsSync(join(dir, `${key}.json`)) ? (JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as CacheEntry) : null);
    const r = read(this.runDir);
    if (r) return { entry: r, where: "run" };
    if (this.mode === "run") {
      const s = read(this.sharedDir);
      if (s) {
        this.writeTo(this.runDir, s); // keep the run folder self-contained
        return { entry: s, where: "shared" };
      }
    }
    return null;
  }

  put(entry: CacheEntry): void {
    this.writeTo(this.runDir, entry);
    if (this.mode !== "replay") this.writeTo(this.sharedDir, entry);
  }

  private writeTo(dir: string | null, entry: CacheEntry): void {
    if (dir) writeFileSync(join(dir, `${entry.key}.json`), canonicalJsonPretty(entry));
  }
}

// ------------------------------------------------------------------ client

export interface LlmEvent {
  agent: string;
  attempt: number;
  key: string;
  source: "run_cache" | "shared_cache" | "network";
  response_sha256: string;
  valid: boolean;
  errors: string[];
}

export interface AskSpec<Raw, Out> {
  agent: string;
  model: string;
  system: string;
  user: string;
  schema: Schema<Raw>;
  max_tokens: number;
  /** Semantic checks and conversion, after the strict schema has passed. */
  accept: (raw: Raw) => { ok: true; value: Out } | { ok: false; errors: string[] };
}

export const MAX_ATTEMPTS = 3; // the first answer plus two retries

export class LlmClient {
  constructor(
    readonly transport: Transport,
    readonly cache: LlmCache,
    private readonly onEvent: (e: LlmEvent) => void = () => {},
  ) {}

  async ask<Raw, Out>(spec: AskSpec<Raw, Out>): Promise<{ value: Out; key: string; model_reported: string | null }> {
    const schema = toApiSchema(spec.schema.json);
    const failures: { key: string; errors: string[] }[] = [];
    let user = spec.user;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const req: LlmRequest = { agent: spec.agent, model: spec.model, system: spec.system, user, schema, max_tokens: spec.max_tokens };
      const key = cacheKey(req);
      const hit = this.cache.get(key);
      let entry: CacheEntry;
      let source: LlmEvent["source"];
      if (hit) {
        entry = hit.entry;
        source = hit.where === "run" ? "run_cache" : "shared_cache";
      } else {
        const response = await this.transport.call(req);
        const { agent: _a, ...request } = req;
        entry = { key, agent: spec.agent, request, response, transport: this.transport.name, recorded_at: new Date().toISOString() };
        this.cache.put(entry);
        source = "network";
      }
      const errors: string[] = [];
      let parsed: unknown = undefined;
      if (entry.response.stop_reason === "max_tokens") errors.push("response was cut off at max_tokens");
      try {
        parsed = JSON.parse(entry.response.text);
      } catch (e) {
        errors.push(`response is not valid JSON: ${(e as Error).message}`);
      }
      if (errors.length === 0) errors.push(...errorsOf(spec.schema, parsed));
      let out: Out | undefined;
      if (errors.length === 0) {
        const res = spec.accept(parsed as Raw);
        if (res.ok) out = res.value;
        else errors.push(...res.errors);
      }
      this.onEvent({ agent: spec.agent, attempt, key, source, response_sha256: sha256(entry.response.text), valid: errors.length === 0, errors: errors.slice(0, 20) });
      if (errors.length === 0) return { value: out as Out, key, model_reported: entry.response.model };
      failures.push({ key, errors });
      user =
        `${spec.user}\n\n<previous_answer>\n${entry.response.text.slice(0, 6000)}\n</previous_answer>\n` +
        `<validation_errors>\n${errors.slice(0, 20).map((e) => `- ${e}`).join("\n")}\n</validation_errors>\n` +
        `Your previous answer was rejected for the reasons above. This is attempt ${attempt + 1} of ${MAX_ATTEMPTS}. ` +
        "Return a corrected answer that satisfies the schema and every rule.";
    }
    throw new LlmRejectedError(spec.agent, failures);
  }
}

// ------------------------------------------------------------------ API-compatible schemas

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "maxItems", "propertyNames", "pattern", "$id", "$schema", "multipleOf"];

/**
 * Structured output accepts a subset of JSON Schema: no numeric or length bounds,
 * minItems of 0 or 1 only, and additionalProperties must be false. Constraints are
 * stripped here and re-checked by our own strict validator on the way back in.
 */
export function toApiSchema(json: Json): Json {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (UNSUPPORTED.includes(k)) continue;
      if (k === "minItems") {
        out[k] = Math.min(1, v as number);
        continue;
      }
      if (k === "additionalProperties" && v !== false) throw new Error("LLM output schemas cannot contain open records (additionalProperties must be false)");
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    return out;
  };
  return walk(json) as Json;
}
