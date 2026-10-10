// Determinism check across runs: where two runs sent byte-identical requests
// for an item, its answers must be identical by option id. Pairs checked:
//   S17b main vs c1   identical for every item without comments
//   c2 vs main        identical where the anchor view is the stripped state
// Also counts, per fix, how many items' requests changed.
//   node scripts/determinism.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS } from "./client.ts";
import { sameProbabilities } from "./analyze-lib.ts";
import { canonical } from "../src/estimator.ts";

type Row = { item: string; slots?: string[]; output: { answers: Record<string, { probabilities: Record<string, number> }> } };
const load = (p: string) => new Map((JSON.parse(readFileSync(p, "utf8")) as Row[]).map((r) => [r.item, r]));
const docs = join(RESULTS, "..", "..", "..", "docs", "spikes");
const ds = JSON.parse(readFileSync(join(docs, "s17c-dataset.json"), "utf8")) as { composition: { strip: { ids: string[] } }; items: { id: string; rotation: number; states: { stripped: unknown; scoped: unknown } }[] };
const runs = {
  s17b: load(join(RESULTS, "..", "..", "17b-clef-scale", "results", "eval-raw-main.json")),
  c1: load(join(RESULTS, "eval-raw-c1.json")),
  c2: load(join(RESULTS, "eval-raw-c2.json")),
  main: load(join(RESULTS, "eval-raw-main.json")),
};
const same = (a: Row, b: Row) => ["v0", "v1", "v2"].every((v) => sameProbabilities(a.output.answers[v].probabilities, b.output.answers[v].probabilities));
const commented = new Set(ds.composition.strip.ids);
const unchanged1 = ds.items.filter((i) => !commented.has(i.id));
const id1 = unchanged1.filter((i) => same(runs.s17b.get(i.id)!, runs.c1.get(i.id)!)).length;
const rotated = ds.items.filter((i) => i.rotation !== 0);
const unchanged3 = ds.items.filter((i) => canonical(i.states.scoped) === canonical(i.states.stripped));
const id3 = unchanged3.filter((i) => same(runs.c2.get(i.id)!, runs.main.get(i.id)!)).length;
console.log(`fix 1 changes the request of ${commented.size}/242 items; S17b vs c1 identical on the other ${id1}/${unchanged1.length}`);
console.log(`fix 2 changes the slot order of ${rotated.length}/242 items (rotation 1 or 2)`);
console.log(`fix 3 changes the state of ${242 - unchanged3.length}/242 items; c2 vs main identical on the other ${id3}/${unchanged3.length}`);

// Item-level agreement transitions per fix: which items moved between
// "all three asks agree" and "they disagree" when each fix was added.
const values = (r: Row & { variants?: { name: string; valueOf: Record<string, string> }[] }) =>
  r.variants!.map((v) => v.valueOf[(r.output.answers[v.name] as unknown as { choice: string }).choice]);
const agree = (r: Row) => new Set(values(r as never)).size === 1;
/** Exact two-sided McNemar p-value: discordant pairs b, c under Binomial(b + c, 1/2). */
function mcnemar(b: number, c: number): number {
  const n = b + c;
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) {
    let coef = 1;
    for (let j = 0; j < k; j++) coef = (coef * (n - j)) / (j + 1);
    tail += coef / 2 ** n;
  }
  return Math.min(1, 2 * tail);
}
for (const [a, b] of [["s17b", "c1"], ["c1", "c2"], ["c2", "main"], ["s17b", "main"]] as const) {
  const gained = ds.items.filter((i) => !agree(runs[a].get(i.id)!) && agree(runs[b].get(i.id)!)).map((i) => i.id);
  const lost = ds.items.filter((i) => agree(runs[a].get(i.id)!) && !agree(runs[b].get(i.id)!)).map((i) => i.id);
  console.log(`${a} -> ${b}: now agree ${gained.length} [${gained.join(" ")}] | now disagree ${lost.length} [${lost.join(" ")}] | net ${gained.length - lost.length >= 0 ? "+" : ""}${gained.length - lost.length} | McNemar exact p = ${mcnemar(gained.length, lost.length).toFixed(3)}`);
}
