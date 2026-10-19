// Seeded random streams. Every random draw in the engine comes from a stream derived
// from (master_seed, stream_name); Math.random is never used (a test greps for it).
// Stream names carry the module, iteration and purpose, e.g. "update/iter=3/move",
// so no RNG state ever needs saving: resuming from iteration k re-derives the same
// streams an uninterrupted run would have used.

import { log } from "./fmath.ts";

/** 32-bit FNV-1a over UTF-16 code units, finished with the murmur3 fmix32 mixer. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private state: number;
  private spare: number | null = null;
  readonly name: string;

  constructor(seed32: number, name = "anon") {
    this.state = seed32 >>> 0;
    this.name = name;
  }

  /** mulberry32 step: a uniform 32-bit unsigned integer. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform on [0, 1) with 53 bits of resolution. */
  next(): number {
    const a = this.nextU32() >>> 5; // 27 bits
    const b = this.nextU32() >>> 6; // 26 bits
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Uniform on the open interval (0, 1). */
  open(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal via the Marsaglia polar method (only log and sqrt needed). */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    for (;;) {
      const u = 2 * this.next() - 1;
      const v = 2 * this.next() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        const m = Math.sqrt((-2 * log(s)) / s);
        this.spare = v * m;
        return u * m;
      }
    }
  }

  /** Fisher-Yates permutation of 0..n-1. */
  permutation(n: number): Int32Array {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    return p;
  }
}

/** Factory for named streams under one master seed. */
export class Streams {
  constructor(readonly masterSeed: number) {
    if (!Number.isInteger(masterSeed)) throw new Error(`seed must be an integer, got ${masterSeed}`);
  }
  get(name: string): Rng {
    return new Rng(hash32(`${this.masterSeed}|${name}`), name);
  }
}
