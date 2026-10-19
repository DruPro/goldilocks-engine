import { describe, expect, test } from "bun:test";
import { Streams } from "../src/core/rng.ts";
import { wmean, wvar } from "../src/core/stats.ts";
import { applyEvidence, drawPrior } from "../src/engine/updater.ts";
import { buildModel } from "../src/model/tree.ts";
import type { Config, Evidence, ParamNode, Root } from "../src/model/types.ts";

const cfg = {
  smc: { ess_fraction: 0.5, move_steps: 4, step_scale: 0.5 },
} as unknown as Config;

const root: Root = { id: "r", description: "", sense: "upper", target: 0, upper: 1, weight: 1, metric: "x", source: "expert" };
const node = (id: string, dist: ParamNode["distribution"], extra: Partial<ParamNode> = {}): ParamNode => ({
  id, parent_ids: [], kind: "sub", distribution: dist, observable: true, measure_cost: 1,
  measurement: { likelihood: "normal", noise: 1 }, source: "expert", rationale: "test", ...extra,
});
const catalog = { dimensions: [{ id: "d", label: "d", options: [{ id: "o", label: "o", attributes: { k: { value: 1, source: "expert" as const } } }] }] };

function model(children: ParamNode[]) {
  return buildModel({ roots: [root], catalog, decompositions: [{ parent: "r", rationale: "", children }] }, []);
}

describe("updater", () => {
  test("conjugate normal: posterior mean and sd match the closed form", () => {
    const m = model([node("x", { type: "normal", params: { mean: 0, sd: 1 } })]);
    const s = new Streams(3);
    const parts = drawPrior(m, 6000, s.get("prior"));
    const ev: Evidence = { id: "e1", target_node: "x", observation: { values: [1.5, 1.7, 1.3, 1.6] }, likelihood: "normal", noise: 0.5, source: "measured", approved_by: "test" };
    const rep = applyEvidence(m, parts, [], ev, cfg, s, "u");
    // prior N(0,1), 4 obs with sd .5: precision 1 + 16 = 17, mean = 16*1.525/17
    const xs = Array.from({ length: parts.N }, (_, p) => parts.vals[p * m.nV]);
    expect(wmean(xs, parts.w)).toBeCloseTo((16 * 1.525) / 17, 1);
    expect(Math.sqrt(wvar(xs, parts.w))).toBeCloseTo(Math.sqrt(1 / 17), 1);
    expect(rep.steps.length).toBeGreaterThan(1); // a sharp observation forces tempering
  });

  test("child nodes move with their parents (non-centred DAG)", () => {
    const m = model([
      node("a", { type: "lognormal", params: { median: 10, sigma: 0.5 } }),
      node("b", { type: "lognormal", params: { sigma: 0.1 } }, { parent_ids: ["a"], dependency: "2 * a" }),
    ]);
    const s = new Streams(4);
    const parts = drawPrior(m, 4000, s.get("prior"));
    const ev: Evidence = { id: "e", target_node: "b", observation: { values: [40] }, likelihood: "lognormal", noise: 0.05, source: "measured", approved_by: "test" };
    applyEvidence(m, parts, [], ev, cfg, s, "u");
    const ia = m.node("a").index;
    const as = Array.from({ length: parts.N }, (_, p) => parts.vals[p * m.nV + ia]);
    expect(wmean(as, parts.w)).toBeGreaterThan(17);
    expect(wmean(as, parts.w)).toBeLessThan(23);
  });

  test("updates are deterministic for a given seed", () => {
    const run = () => {
      const m = model([node("x", { type: "uniform", params: { lo: 0, hi: 10 } })]);
      const s = new Streams(9);
      const parts = drawPrior(m, 1000, s.get("prior"));
      const ev: Evidence = { id: "e", target_node: "x", observation: { lo: 2, hi: 3 }, likelihood: "interval", noise: 0.1, source: "document", approved_by: "test" };
      applyEvidence(m, parts, [], ev, cfg, s, "u");
      return Array.from(parts.base);
    };
    expect(run()).toEqual(run());
  });
});
