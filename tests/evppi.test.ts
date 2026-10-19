// Acceptance (c): EVPPI ranks the planted most-influential parameter first.
// In the fixture the planted parameter is read_ms@kv_log: a wide llm_guess prior on the
// read latency of the cheapest store, which decides whether the cheap families qualify.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Streams } from "../src/core/rng.ts";
import { compilePool, evaluate } from "../src/engine/evaluator.ts";
import { generateCandidates } from "../src/engine/generator.ts";
import { treeInputs } from "../src/engine/loop.ts";
import { plan } from "../src/engine/planner.ts";
import { applyEvidence, drawPrior } from "../src/engine/updater.ts";
import { applyOverrides, loadInputs } from "../src/model/load.ts";
import { buildModel } from "../src/model/tree.ts";
import type { CatalogFile, Config, Evidence, ParamNode, Root } from "../src/model/types.ts";

const PLANTED = "read_ms@kv_log";

function planFor(seed: number) {
  const inp = loadInputs(join(import.meta.dir, "../fixtures/cloud"));
  const cfg = applyOverrides(inp.config, [`seed=${seed}`]);
  const model = buildModel(treeInputs(inp), []);
  const streams = new Streams(seed);
  const parts = drawPrior(model, cfg.particles, streams.get("prior"));
  const applied: Evidence[] = [];
  for (const e of inp.evidence) applyEvidence(model, parts, applied, e, cfg, streams, `init/${e.id}`);
  const pool = compilePool(model, inp.roots.roots, generateCandidates(inp.catalog, inp.problem.gates).passing, cfg);
  const ev = evaluate(pool, parts.vals, model.nV, parts.w, cfg);
  return plan(model, parts, ev, pool, cfg, streams, 0);
}

describe("acceptance (c): EVPPI", () => {
  test("the planted parameter ranks first by EVPPI and by EVPPI/cost across seeds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const pl = planFor(seed);
      const byEvppi = [...pl.values].sort((a, b) => b.evppi - a.evppi);
      console.log(`  seed ${seed}: ${byEvppi.slice(0, 3).map((v) => `${v.node}=${v.evppi.toFixed(0)}`).join(", ")}`);
      expect(byEvppi[0].node).toBe(PLANTED);
      expect(pl.next?.node).toBe(PLANTED);
      expect(pl.next?.action).toBe("measure");
      // Second place is clearly behind the planted node.
      expect(byEvppi[1].evppi).toBeLessThan(0.6 * byEvppi[0].evppi);
      // A node that only matters to gate-failing candidates has true EVPPI 0; after the
      // null correction its estimate is noise, far below the planted node.
      expect(pl.values.find((v) => v.node === "sign_ms@soft_key")!.evppi).toBeLessThan(0.02 * byEvppi[0].evppi);
    }
  }, 120_000);

  test("toy problem: the deciding parameter has value, an irrelevant one has none", () => {
    // Two options: "cheap" fails the latency bound unless lat is low; "safe" always passes but costs more.
    const catalog: CatalogFile = {
      dimensions: [
        {
          id: "store",
          label: "store",
          options: [
            { id: "cheap", label: "cheap", attributes: { usd: { value: 100, source: "expert" }, fast: { value: 0, source: "expert" } } },
            { id: "safe", label: "safe", attributes: { usd: { value: 300, source: "expert" }, fast: { value: 1, source: "expert" } } },
          ],
        },
      ],
    };
    const node = (id: string, dist: ParamNode["distribution"]): ParamNode => ({ id, parent_ids: [], kind: "sub", distribution: dist, observable: true, measure_cost: 10, measurement: { likelihood: "normal", noise: 1 }, source: "llm_guess", rationale: "toy" });
    const roots: Root[] = [
      { id: "latency", description: "", sense: "upper", target: 10, upper: 20, weight: 0.5, metric: "if(store.fast, 12, lat)", source: "expert" },
      { id: "spend", description: "", sense: "upper", target: 100, upper: 1000, weight: 0.5, metric: "store.usd + 0 * noise", source: "expert" },
    ];
    const ti = { roots, catalog, decompositions: [{ parent: "latency", rationale: "", children: [node("lat", { type: "uniform", params: { lo: 5, hi: 40 } }), node("noise", { type: "normal", params: { mean: 0, sd: 1 } })] }] };
    const cfg = { beta: 10, tau: 0.85, epsilon: 0.25, zone_rule: "softmin", evppi: { bins: 10, null_permutations: 4 }, utility: { spend_root: "spend", horizon_months: 12, miss_penalty_usd: 20000 }, expand_cost_usd: 100 } as unknown as Config;
    const model = buildModel(ti, []);
    const streams = new Streams(11);
    const parts = drawPrior(model, 4000, streams.get("prior"));
    const pool = compilePool(model, roots, generateCandidates(catalog, []).passing, cfg);
    const ev = evaluate(pool, parts.vals, model.nV, parts.w, cfg);
    const pl = plan(model, parts, ev, pool, cfg, streams, 0);
    const v = Object.fromEntries(pl.values.map((x) => [x.node, x.evppi]));
    expect(pl.values[0].node).toBe("lat");
    // Exact EVPPI is about 1075 USD; the bin straddling the threshold loses a little.
    expect(v.lat).toBeGreaterThan(800);
    expect(v.noise).toBe(0);
  });
});
