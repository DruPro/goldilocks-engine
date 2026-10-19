// Portable transcendental functions.
//
// Engine Math.exp / Math.log may differ in the last bit between operating systems
// and engine versions (ECMAScript only asks for an "implementation-approximated"
// result). Byte-identical snapshots across machines need bit-identical maths, so
// exp and log are ported from fdlibm (e_exp.c, e_log.c), which only uses IEEE-754
// +, -, *, / — operations every engine performs identically.
//
// Math.sqrt, Math.abs, Math.floor, Math.trunc, Math.min and Math.max are exact
// in every engine we target and are used directly.

// Word access through aliased typed arrays (much faster than DataView). The word
// order is detected once, so the code is correct on big-endian hosts too.
const f64 = new Float64Array(1);
const i32 = new Int32Array(f64.buffer);
const u32 = new Uint32Array(f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;

function hi(x: number): number {
  f64[0] = x;
  return i32[HI];
}
function lo(x: number): number {
  f64[0] = x;
  return u32[LO];
}
function withHi(x: number, h: number): number {
  f64[0] = x;
  i32[HI] = h | 0;
  return f64[0];
}

// ---------------------------------------------------------------- exp (e_exp.c)
const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.45133219101941108420e2;
const LN2_HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const LN2_LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const INV_LN2 = 1.44269504088896338700e0;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;
const HALF = [0.5, -0.5];
const TWOM1000 = 9.33263618503218878990e-302;

export function exp(x: number): number {
  let h = hi(x);
  const xsb = (h >>> 31) & 1;
  h &= 0x7fffffff;
  let k = 0;
  let hiPart = 0;
  let loPart = 0;
  if (h >= 0x40862e42) {
    if (h >= 0x7ff00000) {
      if (((h & 0xfffff) | lo(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0; // exp(+inf)=inf, exp(-inf)=0
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  if (h > 0x3fd62e42) {
    if (h < 0x3ff0a2b2) {
      hiPart = x - LN2_HI[xsb];
      loPart = LN2_LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = (INV_LN2 * x + HALF[xsb]) | 0;
      hiPart = x - k * LN2_HI[0];
      loPart = k * LN2_LO[0];
    }
    x = hiPart - loPart;
  } else if (h < 0x3e300000) {
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((loPart - (x * c) / (2 - c)) - hiPart);
  if (k >= -1021) return withHi(y, hi(y) + (k << 20));
  return withHi(y, hi(y) + ((k + 1000) << 20)) * TWOM1000;
}

// ---------------------------------------------------------------- log (e_log.c)
const LN2_HI_L = 6.93147180369123816490e-1;
const LN2_LO_L = 1.90821492927058770002e-10;
const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

export function log(x: number): number {
  let hx = hi(x);
  const lx = lo(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = hi(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i0 ^ 0x3ff00000));
  k += i0 >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI_L + k * LN2_LO_L;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI_L - ((R - k * LN2_LO_L) - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0
      ? f - (hfsq - s * (hfsq + R))
      : k * LN2_HI_L - ((hfsq - (s * (hfsq + R) + k * LN2_LO_L)) - f);
  }
  return k === 0 ? f - s * (f - R) : k * LN2_HI_L - ((s * (f - R) - k * LN2_LO_L) - f);
}

// ---------------------------------------------------------------- derived helpers
export function pow(base: number, e: number): number {
  if (Number.isInteger(e) && Math.abs(e) <= 64) {
    let r = 1;
    let b = base;
    let n = Math.abs(e);
    while (n > 0) {
      if (n & 1) r *= b;
      b *= b;
      n >>= 1;
    }
    return e < 0 ? 1 / r : r;
  }
  if (base === 0) return e > 0 ? 0 : Infinity;
  if (base < 0) return NaN;
  return exp(e * log(base));
}

/** log(sum(exp(xs))) without overflow. */
export function logSumExp(xs: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += exp(xs[i] - m);
  return m + log(s);
}

/** Numerically stable log(1 + exp(x)). */
export function softplus(x: number): number {
  return x > 0 ? x + log(1 + exp(-x)) : log(1 + exp(x));
}

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + exp(-x)) : exp(x) / (1 + exp(x));
}

export const LN_SQRT_2PI = 0.9189385332046727;
