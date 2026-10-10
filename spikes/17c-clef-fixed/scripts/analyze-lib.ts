// Wilson score interval, 95%.
const Z = 1.959964;
export function wilson(k: number, n: number) {
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const c = (p + (Z * Z) / (2 * n)) / d;
  const h = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return { k, n, p: +p.toFixed(4), lo: +Math.max(0, c - h).toFixed(4), hi: +Math.min(1, c + h).toFixed(4) };
}


/** Probabilities compared by option id; the response map follows the request's key order, so JSON text is not comparable. */
export function sameProbabilities(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).toSorted();
  const kb = Object.keys(b).toSorted();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}
