// Bounded open-loop burst: 2, 4, 6, 8, 10 requests/s for 6 s each (30 s max,
// at most 180 requests per model). Stops issuing at the first sustained
// rate limiting: 3 rate-limited responses within one second, or 5 in a row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, RESULTS, isRateLimited, run, save, sleep, type ModelName, type RunResult } from "./client.ts";
import { question, stateFor, variantsFor } from "../src/questions.ts";
import type { Premise } from "../src/lattice.ts";

const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17-dataset.json"), "utf8")) as {
  items: { id: string; premise: Premise; change: { hunks: unknown[]; symbols: unknown[] } }[];
};
const item = ds.items.find((i) => i.id === "C01")!;
const v0 = variantsFor(item.id, item.premise)[0];
const STEPS = [2, 4, 6, 8, 10];
const STEP_SECONDS = 6;

const out: Record<string, unknown> = {};
const only = process.argv[2] as ModelName | undefined;
for (const model of (only ? [only] : ["clef-flash", "clef"]) as ModelName[]) {
  const input = { model, state: stateFor(item.change), questions: { v0: question(item.premise, v0) } };
  const records: { at: number; rps: number; status: number; ok: boolean; limited: boolean; ms: number | null; clientMs: number; error?: string }[] = [];
  const inflight: Promise<void>[] = [];
  let stopReason: string | null = null;
  let consecutive = 0;
  const t0 = Date.now();
  outer: for (const rps of STEPS) {
    const n = rps * STEP_SECONDS;
    for (let i = 0; i < n; i++) {
      if (stopReason) break outer;
      const startAt = t0 + (STEPS.indexOf(rps) * STEP_SECONDS + i / rps) * 1000;
      const wait = startAt - Date.now();
      if (wait > 0) await sleep(wait);
      const at = Date.now() - t0;
      inflight.push(
        run(MODELS[model], input).then((r: RunResult) => {
          const limited = isRateLimited(r);
          const done = Date.now() - t0;
          records.push({ at, rps, status: r.status, ok: r.ok, limited, ms: r.ms, clientMs: Math.round(r.clientMs), error: r.ok ? undefined : String(r.error?.message ?? r.bodyText).slice(0, 300) });
          consecutive = limited ? consecutive + 1 : 0;
          const recent = records.filter((x) => x.limited && done - x.at - (x.clientMs ?? 0) < 1000).length;
          if (!stopReason && (consecutive >= 5 || recent >= 3)) stopReason = `sustained rate limiting at ${rps} rps after ${(done / 1000).toFixed(1)} s`;
        }),
      );
    }
  }
  await Promise.all(inflight);
  records.sort((a, b) => a.at - b.at);
  const byStep = STEPS.map((rps) => {
    const rs = records.filter((r) => r.rps === rps);
    const okMs = rs.filter((r) => r.ok).map((r) => r.ms!).toSorted((a, b) => a - b);
    return { rps, sent: rs.length, ok: rs.filter((r) => r.ok).length, limited: rs.filter((r) => r.limited).length, otherErrors: rs.filter((r) => !r.ok && !r.limited).length, p50ms: okMs[Math.floor(okMs.length / 2)] ?? null, maxMs: okMs.at(-1) ?? null };
  });
  const firstLimited = records.find((r) => r.limited);
  const errorShapes = [...new Set(records.filter((r) => !r.ok).map((r) => `${r.status} ${r.error}`))];
  out[model] = { stopReason, total: records.length, byStep, firstLimited, errorShapes, records };
  console.log(model, JSON.stringify({ stopReason, total: records.length, byStep, firstLimited, errorShapes }, null, 1));
  if (!only && model === "clef-flash") await sleep(60_000);
}
save(`ratelimit${only ? "-" + only : ""}.json`, out);
