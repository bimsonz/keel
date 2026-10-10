// Latency histogram of a saved produce run.
//   node scripts/histo.ts single10k [bucketMs]
import { readFileSync } from "node:fs";
import { results } from "./lib.ts";

const run = process.argv[2];
const bucket = Number(process.argv[3] ?? 100);
const d = JSON.parse(readFileSync(new URL(`produce-${run}.json`, results), "utf8")) as { lat: number[] };
const h = new Map<number, number>();
for (const v of d.lat) h.set(Math.floor(v / bucket) * bucket, (h.get(Math.floor(v / bucket) * bucket) ?? 0) + 1);
const max = Math.max(...h.values());
for (const [k, n] of [...h].toSorted((a, b) => a[0] - b[0])) {
  console.log(`${String(k).padStart(5)}-${String(k + bucket - 1).padEnd(5)} ms ${String(n).padStart(6)} ${"#".repeat(Math.ceil((n / max) * 50))}`);
}
