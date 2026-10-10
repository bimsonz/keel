// Re-scores the saved truncation sweep against the estimator as it stands,
// plus two can-fail variants: estimator disabled, and a mis-calibrated floor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, save } from "./client.ts";
import { CALIBRATED_BYTES_PER_TOKEN, CONTEXT_LIMIT, GUARANTEED_BYTES_PER_TOKEN, type ClefModel } from "../src/estimator.ts";

interface Row { target: number; predictedTokens: number; bytes: number; ok: boolean; error?: string; reportedInputTokens?: number; choice?: string; pPerSession?: number; ms?: number }
const t = JSON.parse(readFileSync(join(RESULTS, "truncation.json"), "utf8")) as { models: Record<ClefModel, { sweep: Row[] }> };

const detectors: Record<string, (r: Row, cap: number) => boolean> = {
  calibrated: (r, cap) => Math.ceil(r.bytes / CALIBRATED_BYTES_PER_TOKEN) >= cap,
  guaranteed: (r, cap) => Math.ceil(r.bytes / GUARANTEED_BYTES_PER_TOKEN) >= cap,
  "disabled (can-fail)": () => false,
  "floor=4.0 (can-fail)": (r, cap) => Math.ceil(r.bytes / 4.0) >= cap,
  // exact token counts compared with the documented windows instead of the measured caps
  "true count vs docs window (can-fail)": (r, cap) => r.predictedTokens >= (cap === 64_000 ? 65_536 : 24_576),
  "post-call usage == cap": (r, cap) => (r.reportedInputTokens ?? 0) >= cap,
};

const report: Record<string, unknown> = {};
for (const model of Object.keys(t.models) as ClefModel[]) {
  const cap = CONTEXT_LIMIT[model];
  const rows = t.models[model].sweep.map((r) => {
    const truncated = r.ok && r.reportedInputTokens !== undefined && r.predictedTokens > r.reportedInputTokens;
    const oversize = r.predictedTokens > cap;
    return {
      target: r.target,
      trueTokens: r.predictedTokens,
      oversize,
      service: r.ok ? (truncated ? `silently truncated to ${r.reportedInputTokens}` : `full (${r.reportedInputTokens})`) : r.error!.slice(0, 60),
      answer: r.choice ?? "-",
      pPerSession: r.pPerSession,
      ms: r.ms,
      ...Object.fromEntries(Object.entries(detectors).map(([name, d]) => [name, d(r, cap)])),
    };
  });
  const summary = Object.fromEntries(
    Object.keys(detectors).map((name) => {
      const over = rows.filter((r) => r.oversize);
      const under = rows.filter((r) => !r.oversize);
      return [name, {
        oversizeDetected: `${over.filter((r) => (r as Record<string, unknown>)[name]).length}/${over.length}`,
        falseAlarms: `${under.filter((r) => (r as Record<string, unknown>)[name]).length}/${under.length}`,
      }];
    }),
  );
  report[model] = { cap, rows, summary };
  console.log(`\n=== ${model} (effective cap ${cap})`);
  console.table((rows as Record<string, unknown>[]).map((r) => ({ target: r.target, true: r.trueTokens, over: r.oversize, service: r.service, answer: r.answer, cal: r.calibrated, guar: r.guaranteed, off: r["disabled (can-fail)"], k4: r["floor=4.0 (can-fail)"], docs: r["true count vs docs window (can-fail)"], post: r["post-call usage == cap"] })));
  console.log(JSON.stringify(summary, null, 1));
}
save("truncation-report.json", report);
