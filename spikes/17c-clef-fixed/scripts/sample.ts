// Prints a seeded random sample of synthetic items with the anchor view Clef
// was sent (states.scoped), for the hand-check of fix 3.
//   node scripts/sample.ts [count] [seed]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS } from "./client.ts";

const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17c-dataset.json"), "utf8"));
const count = Number(process.argv[2] ?? 16);
let a = Number(process.argv[3] ?? 2026) >>> 0;
const rnd = () => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const synth = ds.items.filter((i: { source: string }) => i.source === "synthetic");
const picked = new Set<number>();
while (picked.size < count) picked.add(Math.floor(rnd() * synth.length));
for (const k of [...picked].toSorted((x, y) => x - y)) {
  const i = synth[k];
  console.log(`\n##### ${i.id} ${i.family} ${i.kind}${i.decoyType ? "/" + i.decoyType : ""} | ${i.premise.predicate} premise ${i.premise.value} | effect ${i.groundTruthEffect.value} => ${i.label}`);
  console.log(`reason: ${i.reason}`);
  console.log(`anchors: ${i.anchors.symbols.join(", ")} | touched ${i.anchors.touched}`);
  console.log(`symbols sent: ${i.states.scoped.symbols.map((s: { name: string; status: string }) => `${s.name}(${s.status})`).join(", ")}`);
  for (const h of i.states.scoped.hunks) console.log(h.diff);
}
