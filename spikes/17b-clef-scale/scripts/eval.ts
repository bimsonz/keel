// S17b evaluation against live Clef, S17's method exactly:
//   main     one call per item holding that item's three relabelled asks (v0,
//            v1, v2) as three questions. The batch composition is fixed per
//            question family: an item's asks are always asked together and
//            with nothing else.
//   reorder  control: three asks that share v0's option ids and only reorder
//            the criteria keys. The service sorts ids, so this cannot disagree.
//   s17orig  control: S17's 40 items exactly as S17 sent them (before the
//            leak sanitisation), same method.
//   warmup   exploratory, not the pre-registered method: the same three
//            relabelled asks behind a fixed first field (a yes/no question),
//            to test whether the first slot is what moves.
// Every request goes through the pre-call estimator first (abstain if
// oversize) and the post-call usage check afterwards (abstain at the cap).
//   node scripts/eval.ts [main|reorder|s17orig ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, RESULTS, runPaced, runWithRetry, save } from "./client.ts";
import { estimate, truncatedAfterCall } from "../src/estimator.ts";
import type { Premise } from "../src/lattice.ts";
import { question, stateFor, variantsFor, type Variant } from "../src/questions.ts";

interface Item {
  id: string;
  premise: Premise;
  change: { hunks: unknown[]; symbols: unknown[] };
}
const docs = join(RESULTS, "..", "..", "..", "docs", "spikes");
const load = (f: string) => (JSON.parse(readFileSync(join(docs, f), "utf8")) as { items: Item[] }).items;

/** Same option ids as `base`, criteria keys inserted in `order`. */
function reorderOnly(premise: Premise, base: Variant, order: string[]) {
  const q = question(premise, base);
  const criteria = Object.fromEntries(order.map((v) => [base.idOf[v], q.criteria[base.idOf[v]]]));
  return { ...q, criteria };
}

type Mode = "main" | "reorder" | "s17orig" | "warmup";
const WARMUP = { type: "noul" as const, instructions: "The change adds, removes or modifies at least one function, method, type or resource." };
const modes = (process.argv.slice(2).length ? process.argv.slice(2) : ["main", "reorder", "s17orig"]) as Mode[];
const endpoint = MODELS.clef;

for (const mode of modes) {
  const items = mode === "s17orig" ? load("s17-dataset.json") : load("s17b-dataset.json");
  const tasks = items.map((item) => async () => {
    const vs = variantsFor(item.id, item.premise);
    const questions =
      mode === "reorder"
        ? { v0: question(item.premise, vs[0]), v1: reorderOnly(item.premise, vs[0], vs[1].order), v2: reorderOnly(item.premise, vs[0], vs[2].order) }
        : mode === "warmup"
          ? { a_warmup: WARMUP, ...Object.fromEntries(vs.map((v) => [v.name, question(item.premise, v)])) }
          : Object.fromEntries(vs.map((v) => [v.name, question(item.premise, v)]));
    const decodeAs = mode === "reorder" ? [vs[0], { ...vs[0], name: "v1" }, { ...vs[0], name: "v2" }] : vs;
    const input = { model: "clef", state: stateFor(item.change), questions };
    const est = estimate(input, "clef");
    if (est.oversize) return { mode, item: item.id, variants: decodeAs, estimate: est, skipped: "pre-call estimator: oversize" };
    const r = await runWithRetry(endpoint, input);
    const truncated = r.ok && r.output ? truncatedAfterCall(r.output.usage, "clef") : false;
    return { mode, item: item.id, variants: decodeAs, estimate: est, truncated, ...r };
  });
  const t0 = Date.now();
  const results = await runPaced(tasks, { concurrency: 2, minSpacingMs: 300 });
  const errors = results.filter((r) => !("ok" in r) || !r.ok);
  const retries = results.reduce((s, r) => s + ("retries" in r ? r.retries : 0), 0);
  console.log(`${mode}: ${results.length} calls in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors.length} errors/skips, ${retries} retries`);
  for (const e of errors.slice(0, 3)) console.log(JSON.stringify(e).slice(0, 400));
  save(`eval-raw-${mode}.json`, results);
}
