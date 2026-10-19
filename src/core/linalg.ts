// Small dense linear algebra for FPCA: cyclic Jacobi eigen-decomposition of a
// symmetric matrix. Grid sizes are tiny (< 30), so clarity beats speed.

export type Mat = number[][];

export function zeros(n: number, m = n): Mat {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

/** Eigenvalues (descending) and unit eigenvectors (columns of `vectors`). */
export function symmetricEigen(A: Mat, maxSweeps = 100): { values: number[]; vectors: Mat } {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const v = zeros(n);
  for (let i = 0; i < n; i++) v[i][i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i] || i - j);
  const values = order.map((i) => a[i][i]);
  const vectors = zeros(n);
  order.forEach((col, k) => {
    // Fix the sign so the largest-magnitude entry is positive (deterministic orientation).
    let big = 0;
    for (let r = 0; r < n; r++) if (Math.abs(v[r][col]) > Math.abs(v[big][col])) big = r;
    const sgn = v[big][col] < 0 ? -1 : 1;
    for (let r = 0; r < n; r++) vectors[r][k] = sgn * v[r][col];
  });
  return { values, vectors };
}
