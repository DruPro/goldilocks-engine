// Clusterer: each candidate's functional curve is P(in zone) along the axis grid
// (the axis node scaled by each multiplier, everything downstream recomputed).
// Curves are grouped with k-means++ (k chosen by silhouette over 2..8) and projected
// onto the first two functional principal components for the solution map.

import type { Streams } from "../core/rng.ts";
import { symmetricEigen, zeros } from "../core/linalg.ts";
import type { Model } from "../model/tree.ts";
import type { Config } from "../model/types.ts";
import { clip, inZone, rawSlack, type CompiledPool, type MCtx } from "./evaluator.ts";
import type { Particles } from "./updater.ts";

export interface Family {
  id: number;
  members: string[];
  mean_curve: number[];
  in_goldilocks: boolean;
  most_binding: string | null; // for rejected families
}

export interface ClusterResult {
  multipliers: number[];
  curves: Record<string, number[]>;
  k: number;
  silhouette: number | null;
  families: Family[];
  assignment: Record<string, number>;
  fpca: { explained: number[]; scores: Record<string, [number, number]>; components: number[][] };
}

/** Equal-weight subsample by systematic resampling, so curves cost S particles, not N. */
function subsample(parts: Particles, model: Model, S: number, streams: Streams, tag: string): Float64Array {
  const rng = streams.get(`clusterer/${tag}/subsample`);
  const u = rng.next() / S;
  const out = new Float64Array(S * model.nB);
  let c = parts.w[0];
  let j = 0;
  for (let i = 0; i < S; i++) {
    const pos = u + i / S;
    while (pos > c && j < parts.N - 1) c += parts.w[++j];
    out.set(parts.base.subarray(j * model.nB, (j + 1) * model.nB), i * model.nB);
  }
  return out;
}

export function curves(model: Model, parts: Particles, pool: CompiledPool, cfg: Config, streams: Streams, tag: string): { mult: number[]; curves: number[][] } {
  const S = Math.min(cfg.axis.particles, parts.N);
  const base = subsample(parts, model, S, streams, tag);
  const axisIndex = model.node(cfg.axis.node).index;
  const C = pool.cands.length;
  const R = pool.roots.length;
  const out = Array.from({ length: C }, () => new Array<number>(cfg.axis.multipliers.length).fill(0));
  const s = new Float64Array(R);
  cfg.axis.multipliers.forEach((m, k) => {
    const vals = model.forwardAll(base, S, { index: axisIndex, scale: m });
    const ctx: MCtx = { v: vals, o: 0 };
    for (let c = 0; c < C; c++) {
      let z = 0;
      for (let p = 0; p < S; p++) {
        ctx.o = p * model.nV;
        let minS = Infinity;
        for (let i = 0; i < R; i++) {
          s[i] = clip(rawSlack(pool.roots[i], pool.scales[i], pool.metrics[c][i](ctx)));
          if (s[i] < minS) minS = s[i];
        }
        if (inZone(s, pool.weights, cfg.beta, cfg.zone_rule, minS)) z++;
      }
      out[c][k] = z / S;
    }
  });
  return { mult: [...cfg.axis.multipliers], curves: out };
}

const dist2 = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x - b[i]) * (x - b[i]), 0);

function kmeans(X: number[][], k: number, rng: { next(): number }, iters = 100): { labels: number[]; inertia: number } {
  const n = X.length;
  const centres: number[][] = [X[Math.floor(rng.next() * n)].slice()];
  while (centres.length < k) {
    const d = X.map((x) => Math.min(...centres.map((c) => dist2(x, c))));
    const tot = d.reduce((a, b) => a + b, 0);
    if (tot === 0) {
      centres.push(X[centres.length % n].slice());
      continue;
    }
    let r = rng.next() * tot;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centres.push(X[pick].slice());
  }
  let labels = new Array<number>(n).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = X.map((x) => {
      let best = 0;
      for (let c = 1; c < k; c++) if (dist2(x, centres[c]) < dist2(x, centres[best])) best = c;
      return best;
    });
    const changed = next.some((l, i) => l !== labels[i]);
    labels = next;
    for (let c = 0; c < k; c++) {
      const mem = X.filter((_, i) => labels[i] === c);
      if (mem.length) centres[c] = mem[0].map((_, j) => mem.reduce((s, x) => s + x[j], 0) / mem.length);
    }
    if (!changed && it > 0) break;
  }
  const inertia = X.reduce((s, x, i) => s + dist2(x, centres[labels[i]]), 0);
  return { labels, inertia };
}

function silhouette(X: number[][], labels: number[], k: number): number {
  const n = X.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const sums = new Array<number>(k).fill(0);
    const counts = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      sums[labels[j]] += Math.sqrt(dist2(X[i], X[j]));
      counts[labels[j]]++;
    }
    const own = labels[i];
    if (counts[own] === 0) continue; // singleton: silhouette 0
    const a = sums[own] / counts[own];
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && counts[c] > 0) b = Math.min(b, sums[c] / counts[c]);
    if (b === Infinity) continue;
    total += (b - a) / Math.max(a, b, 1e-300);
  }
  return total / n;
}

export function cluster(ids: string[], X: number[][], mult: number[], streams: Streams, tag: string, inG: Set<string>, binding: Record<string, string>): ClusterResult {
  const n = X.length;
  const distinct = new Set(X.map((x) => x.join(","))).size;
  let best: { k: number; labels: number[]; sil: number | null } = { k: 1, labels: new Array(n).fill(0), sil: null };
  for (let k = 2; k <= Math.min(8, distinct - 1, n - 1); k++) {
    const rng = streams.get(`clusterer/${tag}/kmeans/k=${k}`);
    let run = kmeans(X, k, rng);
    for (let r = 1; r < 4; r++) {
      const alt = kmeans(X, k, rng);
      if (alt.inertia < run.inertia - 1e-12) run = alt;
    }
    const sil = silhouette(X, run.labels, k);
    if (best.sil === null || sil > best.sil + 1e-12) best = { k, labels: run.labels, sil };
  }
  // Relabel families by first appearance in id order so numbering is stable.
  const remap = new Map<number, number>();
  for (const l of best.labels) if (!remap.has(l)) remap.set(l, remap.size);
  const labels = best.labels.map((l) => remap.get(l)!);

  // FPCA: PCA of the centred curves.
  const K = mult.length;
  const mean = new Array<number>(K).fill(0);
  for (const x of X) x.forEach((v, j) => (mean[j] += v / n));
  const cov = zeros(K);
  for (const x of X) for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) cov[a][b] += ((x[a] - mean[a]) * (x[b] - mean[b])) / Math.max(1, n - 1);
  const { values, vectors } = symmetricEigen(cov);
  const totalVar = values.reduce((s, v) => s + Math.max(0, v), 0);
  const comps = [0, 1].map((c) => vectors.map((row) => row[c] ?? 0));
  const scores: Record<string, [number, number]> = {};
  ids.forEach((id, i) => {
    const d = X[i].map((v, j) => v - mean[j]);
    scores[id] = [d.reduce((s, v, j) => s + v * comps[0][j], 0), d.reduce((s, v, j) => s + v * comps[1][j], 0)];
  });

  const families: Family[] = [];
  for (let f = 0; f < remap.size; f++) {
    const members = ids.filter((_, i) => labels[i] === f);
    const rows = X.filter((_, i) => labels[i] === f);
    const meanCurve = mean.map((_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
    const hasPick = members.some((m) => inG.has(m));
    let mostBinding: string | null = null;
    if (!hasPick) {
      const counts = new Map<string, number>();
      for (const m of members) counts.set(binding[m], (counts.get(binding[m]) ?? 0) + 1);
      mostBinding = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    }
    families.push({ id: f, members, mean_curve: meanCurve, in_goldilocks: hasPick, most_binding: mostBinding });
  }
  const assignment: Record<string, number> = {};
  ids.forEach((id, i) => (assignment[id] = labels[i]));
  const curvesRec: Record<string, number[]> = {};
  ids.forEach((id, i) => (curvesRec[id] = X[i]));
  return {
    multipliers: mult,
    curves: curvesRec,
    k: remap.size,
    silhouette: best.sil,
    families,
    assignment,
    fpca: { explained: values.slice(0, 2).map((v) => (totalVar > 0 ? Math.max(0, v) / totalVar : 0)), scores, components: comps },
  };
}
