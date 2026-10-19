// Parameter tree (a DAG). Nodes come from three places: uncertain catalog attributes
// (one node per option × ranged attribute, e.g. read_ms@kv_log), the decomposition of
// each root (applied at start), and later EXPAND actions. A node's parent_ids are the
// inputs of its distribution or dependency formula; when a node is decomposed, its
// decomposition children become those inputs.

import { baseKind, checkParams, transform, type BaseKind, type DistSpec } from "../core/dist.ts";
import { compile, freeVars, parse, type Getter } from "../core/expr.ts";
import { log } from "../core/fmath.ts";
import { Z90 } from "../core/stats.ts";
import { hashValue } from "../io/canon.ts";
import type { CatalogFile, Decomposition, ParamNode, Root } from "./types.ts";

export interface Ctx {
  v: Float64Array;
}

export interface ModelNode {
  id: string;
  spec: ParamNode;
  index: number;
  base: number; // index in the base vector, -1 for deterministic nodes
  baseKind: BaseKind;
  dist: DistSpec;
  dep: Getter<Ctx> | null;
  attr: { dim: string; option: string; attr: string } | null;
}

export interface FixedAttr {
  value: number;
  source: string;
}

export class Model {
  readonly byId = new Map<string, ModelNode>();
  readonly nB: number;
  readonly nV: number;
  readonly hash: string;
  private readonly ctx: Ctx;

  constructor(
    readonly nodes: ModelNode[],
    readonly expanded: string[],
    readonly expandable: Set<string>,
    readonly fixedAttrs: Map<string, FixedAttr>, // key "<option>.<attr>"
    readonly optionDim: Map<string, string>, // option id → dimension id
  ) {
    for (const n of nodes) this.byId.set(n.id, n);
    this.nV = nodes.length;
    this.nB = nodes.filter((n) => n.base >= 0).length;
    this.ctx = { v: new Float64Array(this.nV) };
    this.hash = hashValue({ nodes: nodes.map((n) => n.spec), expanded });
  }

  node(id: string): ModelNode {
    const n = this.byId.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  /** Values of every node for one particle, in topological order. */
  forward(base: Float64Array, baseOffset: number, out: Float64Array, outOffset: number, override?: { index: number; scale: number }): void {
    const v = this.ctx.v;
    for (const n of this.nodes) {
      const loc = n.dep ? n.dep(this.ctx) : NaN;
      let x = transform(n.dist, n.base >= 0 ? base[baseOffset + n.base] : 0, loc);
      if (override && override.index === n.index) x *= override.scale;
      v[n.index] = x;
    }
    out.set(v, outOffset);
  }

  forwardAll(base: Float64Array, N: number, override?: { index: number; scale: number }): Float64Array {
    const vals = new Float64Array(N * this.nV);
    for (let p = 0; p < N; p++) this.forward(base, p * this.nB, vals, p * this.nV, override);
    return vals;
  }
}

/** A catalog range becomes a prior: uniform over it, or lognormal with it as the 90% interval. */
function attributeNode(dim: string, option: string, attr: string, a: Record<string, unknown>): ParamNode {
  const [lo, hi] = a.range as [number, number];
  if (!(hi > lo)) throw new Error(`catalog ${dim}.${option}.${attr}: range needs hi > lo`);
  const dist = (a.dist as string) ?? "uniform";
  let distribution: DistSpec;
  if (dist === "lognormal") {
    if (!(lo > 0)) throw new Error(`catalog ${dim}.${option}.${attr}: lognormal range must be positive`);
    distribution = { type: "lognormal", params: { median: Math.sqrt(lo * hi), sigma: log(hi / lo) / (2 * Z90) } };
  } else distribution = { type: "uniform", params: { lo, hi } };
  const node: ParamNode = {
    id: `${attr}@${option}`,
    parent_ids: [],
    kind: "sub",
    distribution,
    observable: (a.observable as boolean) ?? false,
    source: a.source as ParamNode["source"],
    rationale: (a.rationale as string) ?? `catalog range [${lo}, ${hi}] for ${dim}.${option}.${attr}`,
    illustrative: true,
  };
  if (a.measure_cost !== undefined) node.measure_cost = a.measure_cost as number;
  if (a.measurement !== undefined) node.measurement = a.measurement as ParamNode["measurement"];
  if (a.unit !== undefined) node.unit = a.unit as string;
  return node;
}

export interface TreeInputs {
  roots: Root[];
  catalog: CatalogFile;
  decompositions: Decomposition[];
}

export function buildModel(inp: TreeInputs, expanded: string[], opts: { expandAny?: boolean } = {}): Model {
  const specs = new Map<string, ParamNode>();
  const attrOf = new Map<string, ModelNode["attr"]>();
  const fixed = new Map<string, FixedAttr>();
  const optionDim = new Map<string, string>();
  const add = (n: ParamNode, why: string) => {
    if (specs.has(n.id)) throw new Error(`duplicate node id ${n.id} (${why})`);
    specs.set(n.id, structuredClone(n));
  };

  for (const d of inp.catalog.dimensions) {
    for (const o of d.options) {
      if (optionDim.has(o.id)) throw new Error(`option id ${o.id} is used in two dimensions; option ids must be unique`);
      optionDim.set(o.id, d.id);
      for (const [attr, a] of Object.entries(o.attributes)) {
        if ("value" in a) fixed.set(`${o.id}.${attr}`, { value: a.value, source: a.source });
        else {
          const node = attributeNode(d.id, o.id, attr, a as Record<string, unknown>);
          add(node, "catalog");
          attrOf.set(node.id, { dim: d.id, option: o.id, attr });
        }
      }
    }
  }

  const rootIds = new Set(inp.roots.map((r) => r.id));
  const byParent = new Map<string, Decomposition>();
  for (const dc of inp.decompositions) {
    if (byParent.has(dc.parent)) throw new Error(`two decompositions for ${dc.parent}`);
    byParent.set(dc.parent, dc);
  }
  for (const dc of inp.decompositions) {
    if (!rootIds.has(dc.parent)) continue;
    for (const c of dc.children) add(c, `decomposition of root ${dc.parent}`);
  }
  const fromExpansion = new Set<string>(); // children created by expanding a node
  for (const id of expanded) {
    const dc = byParent.get(id);
    const node = specs.get(id);
    if (!dc || rootIds.has(id)) throw new Error(`no decomposition available for ${id}`);
    if (!node) throw new Error(`cannot expand unknown node ${id}`);
    if (!dc.replace) throw new Error(`decomposition of ${id} must say how the node is replaced`);
    node.distribution = structuredClone(dc.replace.distribution);
    if (dc.replace.dependency) node.dependency = dc.replace.dependency;
    else delete node.dependency;
    node.parent_ids = [...new Set([...node.parent_ids, ...dc.children.map((c) => c.id)])].sort();
    node.rationale = `${node.rationale} | decomposed: ${dc.rationale}`;
    for (const c of dc.children) {
      add(c, `decomposition of ${id}`);
      fromExpansion.add(c.id);
    }
  }

  // Validate each node against its parents.
  for (const n of specs.values()) {
    for (const p of n.parent_ids) if (!specs.has(p)) throw new Error(`node ${n.id}: unknown parent ${p}`);
    const located = n.dependency !== undefined;
    const err = checkParams(n.distribution as DistSpec, located);
    if (err) throw new Error(`node ${n.id}: ${err}`);
    if (n.distribution.type === "deterministic" && !located) throw new Error(`node ${n.id}: deterministic nodes need a dependency`);
    if (located) {
      const vars = freeVars(parse(n.dependency!));
      for (const v of vars) if (!n.parent_ids.includes(v)) throw new Error(`node ${n.id}: dependency uses ${v}, which is not in parent_ids`);
    }
    if (n.observable && n.measure_cost === undefined) throw new Error(`node ${n.id}: observable nodes need a measure_cost`);
    if (n.observable && !n.measurement) throw new Error(`node ${n.id}: observable nodes need a measurement model`);
  }

  // Topological order (Kahn), ties broken by id so the order never depends on input order.
  const indeg = new Map<string, number>();
  const kids = new Map<string, string[]>();
  for (const n of specs.values()) {
    indeg.set(n.id, n.parent_ids.length);
    for (const p of n.parent_ids) kids.set(p, [...(kids.get(p) ?? []), n.id]);
  }
  const ready = [...specs.keys()].filter((k) => indeg.get(k) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const k of kids.get(id) ?? []) {
      indeg.set(k, indeg.get(k)! - 1);
      if (indeg.get(k) === 0) {
        ready.push(k);
        ready.sort();
      }
    }
  }
  if (order.length !== specs.size) throw new Error(`parameter graph has a cycle among: ${[...specs.keys()].filter((k) => !order.includes(k)).join(", ")}`);

  const index = new Map(order.map((id, i) => [id, i]));
  let b = 0;
  const nodes: ModelNode[] = order.map((id) => {
    const spec = specs.get(id)!;
    const kind = baseKind(spec.distribution.type);
    const dep = spec.dependency
      ? compile<Ctx>(spec.dependency, (name) => {
          const i = index.get(name)!;
          return (c) => c.v[i];
        })
      : null;
    return { id, spec, index: index.get(id)!, base: kind === "none" ? -1 : b++, baseKind: kind, dist: spec.distribution as DistSpec, dep, attr: attrOf.get(id) ?? null };
  });

  const expandable = new Set<string>();
  for (const [parent] of byParent) {
    const s = specs.get(parent);
    if (s && !rootIds.has(parent) && !expanded.includes(parent) && !s.observable) expandable.add(parent);
  }
  // With an LLM decomposer, any unobservable stochastic leaf of the original tree can be
  // decomposed. Children created by an expansion are not expanded again (no regress).
  if (opts.expandAny)
    for (const s of specs.values())
      if (!s.observable && s.parent_ids.length === 0 && s.distribution.type !== "deterministic" && !expanded.includes(s.id) && !fromExpansion.has(s.id)) expandable.add(s.id);
  return new Model(nodes, [...expanded], expandable, fixed, optionDim);
}

/** Roots presented as ParamNodes of kind "root" (for the ledger and tree views). */
export function rootNodes(roots: Root[]): ParamNode[] {
  return roots.map((r) => ({
    id: r.id,
    parent_ids: [],
    kind: "root" as const,
    distribution: { type: "deterministic" as const, params: {} },
    dependency: r.metric,
    observable: false,
    source: r.source,
    rationale: r.description,
    illustrative: r.illustrative,
  }));
}
