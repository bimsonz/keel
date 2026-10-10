// Runs the dataset against both models and saves raw answers.
//   joint:    one call per item, the three permuted variants as three questions
//   separate: one call per variant, one question each (independent asks)
//   batch64:  one change state with 64 questions (latency, cross-question effect)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, RESULTS, runPaced, runWithRetry, save, type ModelName } from "./client.ts";
import { question, stateFor, variantsFor } from "../src/questions.ts";
import type { Premise } from "../src/lattice.ts";

interface Item {
  id: string;
  kind: string;
  premise: Premise;
  change: { hunks: unknown[]; symbols: unknown[] };
}
const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17-dataset.json"), "utf8")) as {
  items: Item[];
};
const only = process.argv[2] as ModelName | undefined;
const models = (only ? [only] : ["clef-flash", "clef"]) as ModelName[];

for (const model of models) {
  const endpoint = MODELS[model];
  const tasks: (() => Promise<unknown>)[] = [];
  for (const item of ds.items) {
    const variants = variantsFor(item.id, item.premise);
    const state = stateFor(item.change);
    tasks.push(async () => {
      const questions = Object.fromEntries(variants.map((v) => [v.name, question(item.premise, v)]));
      const r = await runWithRetry(endpoint, { model, state, questions });
      return { mode: "joint", item: item.id, variants, ...r };
    });
    for (const v of variants) {
      tasks.push(async () => {
        const r = await runWithRetry(endpoint, { model, state, questions: { [v.name]: question(item.premise, v) } });
        return { mode: "separate", item: item.id, variants: [v], ...r };
      });
    }
  }
  // 64 questions against one change: the S-1 change checked against the live
  // premises of the first 21 items (3 variants each) plus one more.
  const s1 = ds.items.find((i) => i.id === "C01")!;
  const batchQs: Record<string, ReturnType<typeof question>> = {};
  const batchVariants: Record<string, unknown> = {};
  for (const item of ds.items.slice(0, 22)) {
    for (const v of variantsFor(item.id, item.premise)) {
      if (Object.keys(batchQs).length === 64) break;
      batchQs[`${item.id}.${v.name}`] = question(item.premise, v);
      batchVariants[`${item.id}.${v.name}`] = v;
    }
  }
  for (let k = 0; k < 8; k++) {
    tasks.push(async () => {
      const r = await runWithRetry(endpoint, { model, state: stateFor(s1.change), questions: batchQs });
      return { mode: "batch64", item: "C01", batchVariants: k === 0 ? batchVariants : undefined, ...r };
    });
  }
  const t0 = Date.now();
  const results = await runPaced(tasks, { concurrency: 2, minSpacingMs: 300 });
  const errors = results.filter((r) => !(r as { ok: boolean }).ok);
  console.log(`${model}: ${results.length} calls in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors.length} errors`);
  for (const e of errors.slice(0, 3)) console.log(JSON.stringify(e).slice(0, 400));
  save(`eval-raw-${model}.json`, results);
}
