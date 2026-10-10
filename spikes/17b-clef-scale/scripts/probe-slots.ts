// Slot probe on the items whose reorder-only asks disagreed:
//   single     one question per call, v0 ids, lattice key order vs reversed
//              key order: are the probabilities bit-identical (S17's finding)?
//   identical  three byte-identical questions (ids q0, q1, q2) in one call:
//              does the answer depend on the slot?
//   reversed   the same three, inserted q2, q1, q0: does the odd slot follow
//              the id (sorted) or the insertion position?
//   node scripts/probe-slots.ts [--reanalyse]   (--reanalyse reads the saved results, no calls)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync as read } from "node:fs";
import { MODELS, RESULTS, runPaced, runWithRetry, save } from "./client.ts";
import { sameProbabilities } from "./analyze-lib.ts";
import type { Premise } from "../src/lattice.ts";
import { question, stateFor, variantsFor } from "../src/questions.ts";

const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17b-dataset.json"), "utf8")) as { items: { id: string; premise: Premise; change: { hunks: unknown[]; symbols: unknown[] } }[] };
const report = JSON.parse(readFileSync(join(RESULTS, "eval-report.json"), "utf8"));
const ids = new Set<string>(report.controls.reorderOnly.disagreeing.map((d: { id: string }) => d.id));
const items = ds.items.filter((i) => ids.has(i.id));
const tasks: (() => Promise<unknown>)[] = [];
for (const item of items) {
  const v0 = variantsFor(item.id, item.premise)[0];
  const q = question(item.premise, v0);
  const reversed = { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).toReversed()) };
  const state = stateFor(item.change);
  const call = (kind: string, questions: Record<string, unknown>) => async () => ({ kind, item: item.id, valueOf: v0.valueOf, ...(await runWithRetry(MODELS.clef, { model: "clef", state, questions })) });
  tasks.push(call("single-lattice-keys", { q: q }), call("single-reversed-keys", { q: reversed }));
  tasks.push(call("identical", { q0: q, q1: q, q2: q }), call("reversed-insertion", { q2: q, q1: q, q0: q }));
}
const reanalyse = process.argv.includes("--reanalyse");
const rows = (reanalyse ? JSON.parse(read(join(RESULTS, "probe-slots.json"), "utf8")) : await runPaced(tasks, { concurrency: 2, minSpacingMs: 300 })) as { kind: string; item: string; ok: boolean; valueOf: Record<string, string>; output: { answers: Record<string, { choice: string; probabilities: Record<string, number> }> } }[];
if (!reanalyse) save("probe-slots.json", rows);
/** Slot s is the odd one out: the other two agree and s differs. */
const odd = (v: string[], s: number) => {
  const o = [0, 1, 2].filter((x) => x !== s);
  return v[o[0]] === v[o[1]] && v[s] !== v[o[0]];
};
const get = (item: string, kind: string) => rows.find((r) => r.item === item && r.kind === kind)!;
let singleSame = 0, identicalDiffer = 0, oddById = 0, oddByInsertion = 0;
for (const item of items) {
  const a = get(item.id, "single-lattice-keys"), b = get(item.id, "single-reversed-keys");
  if (sameProbabilities(a.output.answers.q.probabilities, b.output.answers.q.probabilities)) singleSame++;
  const idn = get(item.id, "identical"), rev = get(item.id, "reversed-insertion");
  const ch = (r: typeof idn, k: string) => r.valueOf[r.output.answers[k].choice];
  const iv = ["q0", "q1", "q2"].map((k) => ch(idn, k)), rv = ["q0", "q1", "q2"].map((k) => ch(rev, k));
  if (new Set(iv).size > 1) identicalDiffer++;
  // in "reversed", q2 was inserted first; q0 sorts first
  if (odd(rv, 0)) oddById++;
  if (odd(rv, 2)) oddByInsertion++;
  console.log(`${item.id.padEnd(5)} single same=${sameProbabilities(a.output.answers.q.probabilities, b.output.answers.q.probabilities)} identical(q0,q1,q2)=${JSON.stringify(iv)} reversed-insertion(q0,q1,q2)=${JSON.stringify(rv)}`);
}
console.log(`items=${items.length} single-question key order bit-identical: ${singleSame}/${items.length}; identical questions disagree within a call: ${identicalDiffer}/${items.length}; reversed insertion: odd slot is q0 (sorted first) in ${oddById}, q2 (inserted first) in ${oddByInsertion}`);
