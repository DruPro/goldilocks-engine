// Data model: every input file and the three core records (ParamNode, Candidate,
// Evidence) are defined once here; validators, JSON Schemas and TS types all come
// from these definitions.

import { T, type Static } from "./schema.ts";

export const ID = "^[A-Za-z_][A-Za-z0-9_]*(?:@[A-Za-z_][A-Za-z0-9_]*)?$";

export const SourceSchema = T.Enum(["measured", "document", "expert", "llm_guess"] as const, {
  description: "Where a number came from. llm_guess priors must be wide.",
});
export type Source = Static<typeof SourceSchema>;

export const DistSpecSchema = T.Object({
  type: T.Enum(["normal", "lognormal", "uniform", "triangular", "logitnormal", "deterministic"] as const),
  params: T.Record(T.Number()),
});

export const LikelihoodTypeSchema = T.Enum(["normal", "lognormal", "binomial", "interval"] as const);

export const MeasurementSchema = T.Object(
  {
    likelihood: LikelihoodTypeSchema,
    noise: T.Number({ exclusiveMinimum: 0 }),
    replicates: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  },
  { description: "How a MEASURE of this node is observed (used to draft evidence and by the synthetic oracle)." },
);

export const ParamNodeSchema = T.Object(
  {
    id: T.String({ pattern: ID }),
    parent_ids: T.Array(T.String({ pattern: ID })),
    kind: T.Enum(["root", "sub"] as const),
    distribution: DistSpecSchema,
    dependency: T.Optional(T.String({ minLength: 1, description: "Formula over parent ids, evaluated by the safe evaluator." })),
    observable: T.Boolean(),
    measure_cost: T.Optional(T.Number({ minimum: 0, description: "USD, same unit as the EVPPI utility." })),
    measurement: T.Optional(MeasurementSchema),
    unit: T.Optional(T.String()),
    source: SourceSchema,
    rationale: T.String(),
    illustrative: T.Optional(T.Boolean()),
  },
  { title: "ParamNode" },
);
export type ParamNode = Static<typeof ParamNodeSchema>;

export const CandidateSchema = T.Object(
  {
    id: T.String(),
    picks: T.Record(T.String({ pattern: ID })),
    origin: T.Enum(["catalog", "llm_proposed"] as const),
    gate_results: T.Record(T.Boolean()),
  },
  { title: "Candidate" },
);
export type Candidate = Static<typeof CandidateSchema>;

export const ObservationSchema = T.Union([
  T.Object({ values: T.Array(T.Number(), { minItems: 1 }) }),
  T.Object({ k: T.Integer({ minimum: 0 }), n: T.Integer({ minimum: 1 }) }),
  T.Object({ lo: T.Number(), hi: T.Number() }),
]);

export const EvidenceSchema = T.Object(
  {
    id: T.String({ pattern: "^[A-Za-z0-9_.-]+$" }),
    target_node: T.String({ pattern: ID }),
    observation: ObservationSchema,
    likelihood: LikelihoodTypeSchema,
    noise: T.Number({ exclusiveMinimum: 0 }),
    source: SourceSchema,
    approved_by: T.String({ minLength: 1 }),
    approved_at: T.Optional(T.String()),
    approval_sha256: T.Optional(T.String({ pattern: "^[0-9a-f]{64}$", description: "sha256 of the record without its approval fields, set by gde approve" })),
    note: T.Optional(T.String()),
    illustrative: T.Optional(T.Boolean()),
  },
  { title: "Evidence" },
);
export type Evidence = Static<typeof EvidenceSchema>;

export const ApprovalSchema = T.Object({
  approved_by: T.String({ minLength: 1 }),
  approved_at: T.String(),
  content_sha256: T.Optional(T.String({ pattern: "^[0-9a-f]{64}$", description: "sha256 of the roots without this record, set by gde approve" })),
  note: T.Optional(T.String()),
});

export const RootSchema = T.Object({
  id: T.String({ pattern: ID }),
  description: T.String(),
  sense: T.Enum(["upper", "lower", "band"] as const, { description: "upper: g <= U; lower: g >= L; band: L <= g <= U" }),
  target: T.Number(),
  lower: T.Optional(T.Number()),
  upper: T.Optional(T.Number()),
  weight: T.Number({ exclusiveMinimum: 0, maximum: 1 }),
  metric: T.String({ minLength: 1, description: "g_i(x, Θ): formula over node ids and <dimension>.<attribute> of the picked options." }),
  unit: T.Optional(T.String()),
  source: SourceSchema,
  illustrative: T.Optional(T.Boolean()),
});
export type Root = Static<typeof RootSchema>;

export const RootsFileSchema = T.Object({ roots: T.Array(RootSchema, { minItems: 1 }), approval: ApprovalSchema });
export type RootsFile = Static<typeof RootsFileSchema>;

export const GateSchema = T.Object({ id: T.String({ pattern: ID }), description: T.String(), formula: T.String({ minLength: 1 }) });

export const ProblemFileSchema = T.Object({
  title: T.String(),
  objectives: T.Array(T.String()),
  constraints: T.Array(T.String()),
  gates: T.Array(GateSchema),
  illustrative: T.Optional(T.Boolean()),
});
export type ProblemFile = Static<typeof ProblemFileSchema>;

export const FixedAttrSchema = T.Object({
  value: T.Number(),
  source: SourceSchema,
  unit: T.Optional(T.String()),
});
export const RangeAttrSchema = T.Object({
  range: T.Array(T.Number(), { minItems: 2, maxItems: 2 }),
  dist: T.Optional(T.Enum(["uniform", "lognormal"] as const, { description: "lognormal: range is the 90% interval" })),
  source: SourceSchema,
  observable: T.Optional(T.Boolean()),
  measure_cost: T.Optional(T.Number({ minimum: 0 })),
  measurement: T.Optional(MeasurementSchema),
  unit: T.Optional(T.String()),
  rationale: T.Optional(T.String()),
});
export const AttributeSchema = T.Union([FixedAttrSchema, RangeAttrSchema]);

export const CatalogFileSchema = T.Object({
  dimensions: T.Array(
    T.Object({
      id: T.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
      label: T.String(),
      options: T.Array(
        T.Object({
          id: T.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
          label: T.String(),
          attributes: T.Record(AttributeSchema, { keyPattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
          illustrative: T.Optional(T.Boolean()),
        }),
        { minItems: 1 },
      ),
    }),
    { minItems: 1 },
  ),
  illustrative: T.Optional(T.Boolean()),
});
export type CatalogFile = Static<typeof CatalogFileSchema>;

export const DecompositionSchema = T.Object({
  parent: T.String({ pattern: ID }),
  rationale: T.String(),
  replace: T.Optional(T.Object({ distribution: DistSpecSchema, dependency: T.Optional(T.String()) })),
  children: T.Array(ParamNodeSchema, { minItems: 1 }),
});
export type Decomposition = Static<typeof DecompositionSchema>;
export const DecompositionsFileSchema = T.Object({
  decompositions: T.Array(DecompositionSchema),
  illustrative: T.Optional(T.Boolean()),
});

export const ConfigSchema = T.Object({
  seed: T.Integer(),
  particles: T.Integer({ minimum: 100, maximum: 200000 }),
  tau: T.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
  epsilon: T.Number({ minimum: 0 }),
  beta: T.Number({ exclusiveMinimum: 0 }),
  iteration_budget: T.Integer({ minimum: 0 }),
  zone_rule: T.Optional(T.Enum(["softmin", "softmin_and_all"] as const)),
  evppi: T.Object({ bins: T.Integer({ minimum: 2 }), null_permutations: T.Integer({ minimum: 0 }) }),
  smc: T.Object({
    ess_fraction: T.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
    move_steps: T.Integer({ minimum: 0 }),
    step_scale: T.Number({ exclusiveMinimum: 0 }),
  }),
  axis: T.Object({
    node: T.String({ pattern: ID }),
    multipliers: T.Array(T.Number({ exclusiveMinimum: 0 }), { minItems: 2 }),
    particles: T.Integer({ minimum: 50 }),
  }),
  utility: T.Object({
    spend_root: T.String({ pattern: ID }),
    horizon_months: T.Number({ exclusiveMinimum: 0 }),
    miss_penalty_usd: T.Number({ minimum: 0 }),
  }),
  expand_cost_usd: T.Number({ exclusiveMinimum: 0 }),
  llm_guess_min_rel_width: T.Number({ minimum: 0, description: "(hi - lo) / |mid| of the 90% prior interval" }),
  models: T.Record(T.String()),
  agents: T.Optional(
    T.Object({
      decomposer: T.Enum(["fixture", "llm"] as const, { description: "Where EXPAND gets decompositions: the fixture file or the LLM decomposer" }),
      hybrids: T.Boolean({ description: "Ask the LLM for hybrid options when G is empty or every member is within 0.05 of tau" }),
      critic: T.Boolean({ description: "LLM advice on the code critic flags (kept out of snapshots)" }),
      explain: T.Boolean({ description: "LLM-written explanations in the brief (numbers filled in by code)" }),
      max_hybrid_calls: T.Integer({ minimum: 0 }),
    }),
  ),
});
export type Config = Static<typeof ConfigSchema>;

export const TruthFileSchema = T.Object({
  values: T.Record(T.Number()),
  note: T.Optional(T.String()),
  illustrative: T.Optional(T.Boolean()),
});
export type TruthFile = Static<typeof TruthFileSchema>;

export const ALL_SCHEMAS = {
  param_node: ParamNodeSchema,
  candidate: CandidateSchema,
  evidence: EvidenceSchema,
  roots: RootsFileSchema,
  problem: ProblemFileSchema,
  catalog: CatalogFileSchema,
  decompositions: DecompositionsFileSchema,
  config: ConfigSchema,
  truth: TruthFileSchema,
};
