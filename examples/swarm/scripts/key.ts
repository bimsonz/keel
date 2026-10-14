// Writes the key to a swarm run's planted pairs before the run starts, and
// prints the digest to publish: which workers are each pair's two sides, and
// which pairs are planted. Keel is never told; the run is scored against this
// file afterwards (score.ts).
//
//   node examples/swarm/scripts/key.ts --workers 100 --seed 42
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keyOf, planTasks } from "../src/run/tasks.ts";

const { values } = parseArgs({
  options: { workers: { type: "string" }, seed: { type: "string", default: "42" } },
});
if (values.workers === undefined) throw new Error("--workers is required");
const workers = Number(values.workers);
const seed = Number(values.seed);
// A run's label names only its files and subjects: which worker is which side is the seed's and the count's.
const pairs = keyOf(planTasks({ seed, count: workers, run: "key" }));
const text = `${JSON.stringify({ seed, workers, pairs }, null, 2)}\n`;
const dir = join(import.meta.dirname, "..", "runs");
mkdirSync(dir, { recursive: true });
const file = join(dir, `key-s${seed}-w${workers}.json`);
writeFileSync(file, text);
console.log(
  `${file}: ${pairs.length} pairs, ${pairs.filter((p) => p.planted).length} planted; sha256 ${createHash("sha256").update(text).digest("hex")}`,
);
