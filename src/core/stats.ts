// Weighted statistics over particle sets. All sorting breaks ties by index so the
// results never depend on engine sort internals.

export function sum(w: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s;
}

export function normalize(w: Float64Array): Float64Array {
  const s = sum(w);
  if (!(s > 0)) throw new Error("weights sum to zero");
  const out = new Float64Array(w.length);
  for (let i = 0; i < w.length; i++) out[i] = w[i] / s;
  return out;
}

/** Kish effective sample size of normalised weights. */
export function ess(w: ArrayLike<number>): number {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < w.length; i++) {
    s += w[i];
    s2 += w[i] * w[i];
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

export function wmean(x: ArrayLike<number>, w: ArrayLike<number>): number {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < x.length; i++) {
    s += w[i] * x[i];
    sw += w[i];
  }
  return s / sw;
}

export function wvar(x: ArrayLike<number>, w: ArrayLike<number>): number {
  const m = wmean(x, w);
  let s = 0;
  let sw = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - m;
    s += w[i] * d * d;
    sw += w[i];
  }
  return s / sw;
}

/** Indices sorted by value, ties broken by index. */
export function argsort(x: ArrayLike<number>): Int32Array {
  const idx = Array.from({ length: x.length }, (_, i) => i);
  idx.sort((a, b) => (x[a] < x[b] ? -1 : x[a] > x[b] ? 1 : a - b));
  return Int32Array.from(idx);
}

/** Weighted quantiles (inverse of the step CDF). qs must be sorted ascending. */
export function wquantiles(x: ArrayLike<number>, w: ArrayLike<number>, qs: number[]): number[] {
  const order = argsort(x);
  const total = sum(w);
  const out: number[] = [];
  let acc = 0;
  let j = 0;
  for (const q of qs) {
    const target = q * total;
    while (j < order.length - 1 && acc + w[order[j]] < target) {
      acc += w[order[j]];
      j++;
    }
    out.push(x[order[j]]);
  }
  return out;
}

/**
 * Assign each particle to one of B weighted-quantile bins of x.
 * A particle's bin is set by the cumulative weight at its midpoint, so bins
 * hold (close to) equal posterior mass even when weights are unequal.
 */
export function quantileBins(x: ArrayLike<number>, w: ArrayLike<number>, B: number): Int32Array {
  const order = argsort(x);
  const total = sum(w);
  const bins = new Int32Array(x.length);
  let acc = 0;
  for (let r = 0; r < order.length; r++) {
    const i = order[r];
    const mid = (acc + w[i] / 2) / total;
    bins[i] = Math.min(B - 1, Math.floor(mid * B));
    acc += w[i];
  }
  return bins;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const Bs = new Set(b);
  if (A.size === 0 && Bs.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (Bs.has(x)) inter++;
  return inter / (A.size + Bs.size - inter);
}

export const Z90 = 1.6448536269514722;
export const Z95 = 1.959963984540054;

/** Wilson score interval for a proportion p estimated from an effective sample n. */
export function wilson(p: number, n: number, z = Z90): [number, number] {
  if (n <= 0) return [0, 1];
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function round(x: number, digits = 6): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
