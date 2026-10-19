// Agent settings and helpers shared by the loop and the commands.

import type { Config } from "../model/types.ts";
import { anthropicTransport, type Transport } from "./llm.ts";

export interface AgentSettings {
  decomposer: "fixture" | "llm";
  hybrids: boolean;
  critic: boolean;
  explain: boolean;
  max_hybrid_calls: number;
}

/** Phase 1 behaviour (no LLM) unless config.yaml turns agents on. */
export function agentSettings(cfg: Config): AgentSettings {
  return cfg.agents ?? { decomposer: "fixture", hybrids: false, critic: false, explain: false, max_hybrid_calls: 0 };
}

export function usesLlm(s: AgentSettings): boolean {
  return s.decomposer === "llm" || s.hybrids || s.critic || s.explain;
}

/** The override `--llm` applies: every agent on. */
export const LLM_ON = "agents={decomposer: llm, hybrids: true, critic: true, explain: true, max_hybrid_calls: 2}";

export function modelFor(cfg: Config, agent: "requirements" | "decomposer" | "critic" | "evidence" | "explainer" | "hybrids"): string {
  const m = cfg.models[agent] ?? (agent === "hybrids" ? cfg.models.decomposer : undefined);
  if (!m) throw new Error(`config.models has no model for the ${agent} agent`);
  return m;
}

/** Creates the real transport only when a call actually misses the cache. */
export function lazyAnthropic(): Transport {
  let t: Transport | null = null;
  return {
    name: "anthropic",
    call(req) {
      t ??= anthropicTransport();
      return t.call(req);
    },
  };
}
