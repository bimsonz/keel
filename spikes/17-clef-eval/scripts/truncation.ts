// Truncation probe and estimator sweep.
// 1. Calibrate bytes/token on the dataset requests already run (eval-raw-*).
// 2. Build states of N filler hunks followed by the decisive S-1 hunk at the
//    end; the right answer (per-session) exists only in that last hunk.
// 3. Sweep total input tokens around each model's limit; record what the
//    service returns, the reported usage, and whether the estimator flags it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, RESULTS, run, save, sleep, type ModelName } from "./client.ts";
import { question, stateFor, variantsFor } from "../src/questions.ts";
import {
  CALIBRATED_BYTES_PER_TOKEN, CONTEXT_LIMIT, GUARANTEED_BYTES_PER_TOKEN, estimate, promptBytes, truncatedAfterCall,
} from "../src/estimator.ts";
import type { Premise } from "../src/lattice.ts";
import type { Variant } from "../src/questions.ts";

interface Item { id: string; premise: Premise; change: { hunks: { file: string; language: string; diff: string }[]; symbols: unknown[] } }
const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17-dataset.json"), "utf8")) as { items: Item[] };
const byId = new Map(ds.items.map((i) => [i.id, i]));

// 1. calibration on the 240 single-question dataset calls
const calibration: Record<string, unknown> = {};
for (const model of ["clef-flash", "clef"] as const) {
  const raw = JSON.parse(readFileSync(join(RESULTS, `eval-raw-${model}.json`), "utf8")) as {
    mode: string; item: string; variants: Variant[]; output: { usage: { input_tokens: number } };
  }[];
  const ratios = raw.filter((r) => r.mode === "separate").map((r) => {
    const item = byId.get(r.item)!;
    const v = r.variants[0];
    const bytes = promptBytes({ state: stateFor(item.change), questions: { [v.name]: question(item.premise, v) } });
    return bytes / r.output.usage.input_tokens;
  });
  calibration[model] = { n: ratios.length, minBytesPerToken: Math.min(...ratios), maxBytesPerToken: Math.max(...ratios), meanBytesPerToken: ratios.reduce((a, b) => a + b, 0) / ratios.length };
}
console.log("calibration", JSON.stringify(calibration));

// 2. probe construction
const s1 = byId.get("C01")!;
const v0 = variantsFor(s1.id, s1.premise)[0];
const questions = { v0: question(s1.premise, v0) };
const decisive = s1.change.hunks; // permissions.ts + logout.ts
function filler(i: number) {
  const n = String(i).padStart(5, "0");
  const file = `src/util/format_${n}.ts`;
  return {
    file,
    language: "typescript",
    diff: `--- a/${file}\n+++ b/${file}\n@@ -3,3 +3,3 @@\n export function formatBytes${n}(n: number): string {\n-  // convert bytes to a human readable string\n+  // Convert bytes to a human-readable string.\n   return (n / 1024).toFixed(1) + " KiB";\n`,
  };
}
const probe = (k: number, decisiveAt: "end" | "start") => {
  const fill = Array.from({ length: k }, (_, i) => filler(i));
  const hunks = decisiveAt === "end" ? [...fill, ...decisive] : [...decisive, ...fill];
  return { state: { hunks }, questions };
};

const out: Record<string, unknown> = { calibration, models: {} };
for (const model of ["clef-flash", "clef"] as ModelName[]) {
  const endpoint = MODELS[model];
  const call = async (k: number, at: "end" | "start") => {
    const input = probe(k, at);
    const r = await run(endpoint, { model, ...input });
    await sleep(500);
    return { input, r };
  };
  // linear token model from three small probes
  const base = await Promise.all([0, 20, 100].map((k) => call(k, "end")));
  const [t0, t20, t100] = base.map((b) => b.r.output!.usage.input_tokens);
  const slope = (t100 - t20) / 80;
  const linear = { t0, t20, t100, slopePerFiller: slope, slopeFirst20: (t20 - t0) / 20 };
  console.log(model, "linear", JSON.stringify(linear));

  const targets = [
    ...(model === "clef-flash" ? [20_480, 23_552, 24_576, 25_600, 32_768] : []),
    51_200, 61_440, 64_512, 65_536, 67_584, 81_920,
  ];
  const rows = [];
  for (const target of targets) {
    const k = Math.floor((target - t0) / slope);
    const predictedTokens = t0 + slope * k;
    const { input, r } = await call(k, "end");
    const a = r.output?.answers.v0 as { choice: string; probabilities: Record<string, number> } | undefined;
    const limit = CONTEXT_LIMIT[model as keyof typeof CONTEXT_LIMIT];
    const calibrated = estimate(input, model as keyof typeof CONTEXT_LIMIT, CALIBRATED_BYTES_PER_TOKEN);
    const guaranteed = estimate(input, model as keyof typeof CONTEXT_LIMIT, GUARANTEED_BYTES_PER_TOKEN);
    const row = {
      target,
      fillers: k,
      predictedTokens,
      actuallyOversize: predictedTokens >= limit,
      ok: r.ok,
      error: r.error?.message,
      reportedInputTokens: r.output?.usage.input_tokens,
      choice: a ? v0.valueOf[a.choice] : undefined,
      pPerSession: a?.probabilities[v0.idOf["per-session"]],
      ms: r.ms,
      bytes: calibrated.bytes,
      estCalibrated: calibrated.estimatedTokens,
      flaggedCalibrated: calibrated.oversize,
      estGuaranteed: guaranteed.estimatedTokens,
      flaggedGuaranteed: guaranteed.oversize,
      postCallTruncated: r.output ? truncatedAfterCall(r.output.usage, model as keyof typeof CONTEXT_LIMIT) : undefined,
      estimatorDisabledDetects: false, // with no pre-call estimate there is nothing to flag; see doc
    };
    rows.push(row);
    console.log(model, JSON.stringify(row));
  }
  // control: decisive hunk first at the largest size; the answer survives truncation
  const kMax = Math.floor((81_920 - t0) / slope);
  const ctl = await call(kMax, "start");
  const ca = ctl.r.output?.answers.v0 as { choice: string; probabilities: Record<string, number> } | undefined;
  const control = { fillers: kMax, decisiveAt: "start", ok: ctl.r.ok, error: ctl.r.error?.message, reportedInputTokens: ctl.r.output?.usage.input_tokens, choice: ca ? v0.valueOf[ca.choice] : undefined, pPerSession: ca?.probabilities[v0.idOf["per-session"]] };
  console.log(model, "control", JSON.stringify(control));
  const small = base[0].r.output!.answers.v0 as { choice: string; probabilities: Record<string, number> };
  (out.models as Record<string, unknown>)[model] = {
    linear,
    noFillerAnswer: { choice: v0.valueOf[small.choice], pPerSession: small.probabilities[v0.idOf["per-session"]] },
    sweep: rows,
    control,
  };
}
save("truncation.json", out);
