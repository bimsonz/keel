export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function clamp(n: number, lo: number, hi: number): number {
  if (lo > hi) throw new RangeError("lo > hi");
  return Math.min(hi, Math.max(lo, n));
}

export async function delayed<T>(value: T, ms = 1): Promise<T> {
  await new Promise((r) => setTimeout(r, ms));
  return value;
}
