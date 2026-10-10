// S17c evaluation against live Clef. S17b's method (one item per call, three
// relabelled asks in the call, a fixed batch composition per question family,
// the pre-call estimator and the post-call cap check), plus the fixes:
//   c1    fix 1 only: comments stripped; asks inserted v0, v1, v2 (S17b's order)
//   c2    fixes 1 + 2: comments stripped; asks rotated per item (Latin square)
//   main  fixes 1 + 2 + 3: the anchor view, comments stripped; asks rotated
// S17b's own main run is the no-fix baseline (identical requests are
// deterministic, so it is read from spikes/17b-clef-scale/results, not re-run).
//   node scripts/eval.ts [main|c1|c2 ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, RESULTS, runPaced, runWithRetry, save } from "./client.ts";
import { estimate, truncatedAfterCall } from "../src/estimator.ts";
import type { Premise } from "../src/lattice.ts";
import { question, slotOrder, stateFor, variantsFor } from "../src/questions.ts";

type State = { hunks: unknown[]; symbols: unknown[] };
interface Item {
  id: string;
  premise: Premise;
  rotation: number;
  states: { stripped: State; scoped: State };
}
const docs = join(RESULTS, "..", "..", "..", "docs", "spikes");
const items = (JSON.parse(readFileSync(join(docs, "s17c-dataset.json"), "utf8")) as { items: Item[] }).items;

type Mode = "main" | "c1" | "c2";
const MODES: Record<Mode, { state: keyof Item["states"]; rotate: boolean }> = {
  c1: { state: "stripped", rotate: false },
  c2: { state: "stripped", rotate: true },
  main: { state: "scoped", rotate: true },
};
const modes = (process.argv.slice(2).length ? process.argv.slice(2) : ["main"]) as Mode[];
const endpoint = MODELS.clef;

for (const mode of modes) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`unknown mode ${mode}`);
  const tasks = items.map((item) => async () => {
    const vs = variantsFor(item.id, item.premise);
    const slots = slotOrder(vs, cfg.rotate ? item.rotation : 0);
    const questions = Object.fromEntries(slots.map((v) => [v.name, question(item.premise, v)]));
    const input = { model: "clef", state: stateFor(item.states[cfg.state]), questions };
    const est = estimate(input, "clef");
    const base = { mode, item: item.id, variants: vs, slots: slots.map((v) => v.name), estimate: est };
    if (est.oversize) return { ...base, skipped: "pre-call estimator: oversize" };
    const r = await runWithRetry(endpoint, input);
    const truncated = r.ok && r.output ? truncatedAfterCall(r.output.usage, "clef") : false;
    return { ...base, truncated, ...r };
  });
  const t0 = Date.now();
  const results = await runPaced(tasks, { concurrency: 2, minSpacingMs: 300 });
  const errors = results.filter((r) => !("ok" in r) || !r.ok);
  const retries = results.reduce((s, r) => s + ("retries" in r ? r.retries : 0), 0);
  console.log(`${mode}: ${results.length} calls in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors.length} errors/skips, ${retries} retries`);
  for (const e of errors.slice(0, 3)) console.log(JSON.stringify(e).slice(0, 400));
  save(`eval-raw-${mode}.json`, results);
}
