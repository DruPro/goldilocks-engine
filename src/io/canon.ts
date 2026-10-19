// Canonical JSON and content hashing. Snapshots and hashes are computed over
// canonical JSON: object keys sorted, no whitespace, numbers in ECMAScript's
// shortest round-trip form (identical in every compliant engine). Non-finite
// numbers and undefined values are rejected rather than silently coerced.

export function canonicalize(value: unknown, path = "$"): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (ArrayBuffer.isView(value)) {
    const arr = Array.from(value as unknown as ArrayLike<number>);
    return arr.map((v, i) => canonicalize(v, `${path}[${i}]`));
  }
  if (Array.isArray(value)) return value.map((v, i) => canonicalize(v, `${path}[${i}]`));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v, `${path}.${k}`);
    }
    return out;
  }
  throw new Error(`cannot canonicalize ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Pretty canonical JSON for human-readable files (still key-sorted, still stable). */
export function canonicalJsonPretty(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + "\n";
}

export function sha256(data: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Little-endian bytes of a Float64Array, independent of host endianness. */
export function float64Bytes(arr: Float64Array): Uint8Array {
  const out = new Uint8Array(arr.length * 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < arr.length; i++) dv.setFloat64(i * 8, arr[i], true);
  return out;
}

export function bytesToFloat64(bytes: Uint8Array): Float64Array {
  if (bytes.length % 8 !== 0) throw new Error("byte length is not a multiple of 8");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(bytes.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8, true);
  return out;
}
