// Synthetic oracle: a hidden "true" Θ* on the fully expanded tree, observed through
// each node's measurement model. Used by the acceptance tests and by `run --oracle`.
// Θ* comes from truth.yaml where given; every other node is drawn once from the prior
// on the "oracle/truth" stream, and deterministic nodes are computed from the DAG.

import { sampleBase, simulateObs, transform } from "../core/dist.ts";
import type { Streams } from "../core/rng.ts";
import { buildModel, type Ctx, type Model, type TreeInputs } from "../model/tree.ts";
import type { Evidence, TruthFile } from "../model/types.ts";

export interface Oracle {
  truth: Map<string, number>;
  full: Model;
  /** `current` is the run's current tree; it supplies priors for nodes invented after the start. */
  measure(node: string, iter: number, current?: Model): Evidence;
}

export function fullyExpanded(ti: TreeInputs): Model {
  let expanded: string[] = [];
  for (;;) {
    const m = buildModel(ti, expanded);
    const more = [...m.expandable].filter((id) => !expanded.includes(id)).sort();
    if (more.length === 0) return m;
    expanded = [...expanded, ...more];
  }
}

export function makeOracle(ti: TreeInputs, truthFile: TruthFile | null, streams: Streams): Oracle {
  const full = fullyExpanded(ti);
  const given = truthFile?.values ?? {};
  for (const id of Object.keys(given)) {
    const n = full.byId.get(id);
    if (!n) throw new Error(`truth.yaml sets ${id}, which is not a node of the fully expanded tree`);
    if (n.base < 0) throw new Error(`truth.yaml sets ${id}, which is deterministic; set its inputs instead`);
  }
  const rng = streams.get("oracle/truth");
  const ctx: Ctx = { v: new Float64Array(full.nV) };
  for (const n of full.nodes) {
    const b = n.base >= 0 ? sampleBase(n.baseKind, rng) : 0; // drawn for every node so the stream never depends on truth.yaml
    const loc = n.dep ? n.dep(ctx) : NaN;
    ctx.v[n.index] = n.id in given ? given[n.id] : transform(n.dist, b, loc);
  }
  const truth = new Map(full.nodes.map((n) => [n.id, ctx.v[n.index]]));
  return {
    truth,
    full,
    measure(node: string, iter: number, current?: Model): Evidence {
      let n = full.byId.get(node);
      if (!n) {
        // A node invented during the run (an agent decomposition): its hidden truth is drawn
        // once from its prior in the current tree, on its own stream.
        n = current?.byId.get(node);
        if (!n || n.base < 0 || n.spec.parent_ids.length > 0) throw new Error(`oracle cannot measure unknown node ${node}`);
        if (!truth.has(node)) truth.set(node, transform(n.dist, sampleBase(n.baseKind, streams.get(`oracle/new/${node}`)), NaN));
      }
      const m = n.spec.measurement;
      if (!n.spec.observable || !m) throw new Error(`node ${node} is not observable`);
      const obs = simulateObs(m.likelihood, m.noise, truth.get(node)!, streams.get(`oracle/iter=${iter}/${node}`), m.replicates ?? 1);
      return {
        id: `oracle-${iter}-${node.replace("@", "_at_")}`,
        target_node: node,
        observation: obs,
        likelihood: m.likelihood,
        noise: m.noise,
        source: "measured",
        approved_by: "synthetic-oracle",
        note: "Synthetic observation drawn from the hidden truth (test mode).",
        illustrative: true,
      };
    },
  };
}
