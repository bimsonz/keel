// Per-slot view of the joint calls: value accuracy by field position and
// pairwise disagreement per slot pair, for the main run, the reorder-only
// control and the exploratory warm-up run (where the asks sit in slots 2-4).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS } from "./client.ts";
import { wilson } from "./analyze-lib.ts";

const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17b-dataset.json"), "utf8"));
const truth = new Map<string, string>(ds.items.map((i: { id: string; groundTruthEffect: { value: string } }) => [i.id, i.groundTruthEffect.value]));
const out: Record<string, unknown> = {};
for (const mode of ["main", "reorder", "warmup"]) {
  const rows = JSON.parse(readFileSync(join(RESULTS, `eval-raw-${mode}.json`), "utf8"));
  const vals = rows.map((r: { item: string; variants: { name: string; valueOf: Record<string, string> }[]; output: { answers: Record<string, { choice: string }> } }) =>
    ({ id: r.item, v: r.variants.map((v) => v.valueOf[r.output.answers[v.name].choice]) }));
  const acc = [0, 1, 2].map((s) => wilson(vals.filter((x: { id: string; v: string[] }) => x.v[s] === truth.get(x.id)).length, vals.length));
  const pair = (a: number, b: number) => wilson(vals.filter((x: { v: string[] }) => x.v[a] !== x.v[b]).length, vals.length);
  const odd = [0, 1, 2].map((s) => vals.filter((x: { v: string[] }) => { const o = [0, 1, 2].filter((k) => k !== s); return x.v[o[0]] === x.v[o[1]] && x.v[s] !== x.v[o[0]]; }).length);
  out[mode] = { slotAccuracy: acc, disagree01: pair(0, 1), disagree02: pair(0, 2), disagree12: pair(1, 2), oddOneOutBySlot: odd };
  console.log(`${mode}: acc slot1 ${acc[0].p} slot2 ${acc[1].p} slot3 ${acc[2].p} | disagree 1-2 ${pair(0, 1).k} 1-3 ${pair(0, 2).k} 2-3 ${pair(1, 2).k} of ${vals.length} | odd one out by slot ${odd.join("/")}`);
}
console.log(JSON.stringify(out));
