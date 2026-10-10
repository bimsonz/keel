// Aggregates draft results per model.
//
//   node scripts/report.ts <results/drafts> [--reeval]
//
// --reeval re-runs each rejected final draft through /evaluate (BASE/TOKEN in
// the environment) to recover the per-world reason, saved beside the draft as
// <name>.reeval.json. The draft record keeps outcomes but not reasons.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wilson } from "../src/admission.ts";

// USD per million tokens, from `wrangler ai models list --json` on 2026-10-10.
const PRICE: Record<string, [number, number]> = {
  "@cf/moonshotai/kimi-k2.7-code": [0.95, 4],
  "@cf/deepseek-ai/deepseek-v4-flash-0731": [0.44, 1.32],
  "@cf/qwen/qwen2.5-coder-32b-instruct": [0.66, 1],
  "@cf/zai-org/glm-5.3": [1.4, 4.4],
};
// Dynamic Workers: each fresh isolate id is a unique Worker, $0.002 per day (S14 finding 10).
const PER_ID = 0.002;
const IDS_PER_EVAL = 12;
const IDS_MUTANT = 3;

const dir = process.argv[2]!;
const reeval = process.argv.includes("--reeval");

const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : NaN;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function errorClass(text: string): string {
  if (text.startsWith("bundling ")) return "compile/bundle";
  if (/not valid JSON|does not match the output schema/.test(text)) return "schema (abstain)";
  if (/missing JSON line|invalid JSON line/.test(text)) return "JSON line";
  if (/expected exactly one probe test, found 0/.test(text)) return "load error";
  if (/expected exactly one probe test/.test(text)) return "test count";
  if (/skipped/.test(text)) return "skipped test";
  if (/without reporting/.test(text)) return "no observation";
  return "other harness";
}

async function evaluate(probe: string): Promise<any> {
  const res = await fetch(`${process.env.BASE}/evaluate`, {
    method: "POST",
    headers: { "x-spike-token": process.env.TOKEN!, "content-type": "application/json" },
    body: JSON.stringify({ probe, worlds: ["base", "A", "B", "AB"] }),
  });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return lines.findLast((l: any) => "result" in l)?.result;
}

const out: string[] = [];
for (const model of readdirSync(dir).toSorted()) {
  const mdir = join(dir, model);
  const files = readdirSync(mdir).filter((f) => f.endsWith(".json") && !f.includes(".reeval")).toSorted();
  const jobs = files.map((f) => ({ f, j: JSON.parse(readFileSync(join(mdir, f), "utf8")) }));
  if (!jobs.length) continue;
  const m = jobs[0]!.j.model as string;
  const [pin, pout] = PRICE[m] ?? [NaN, NaN];
  const admitted = jobs.filter((x) => x.j.outcome === "admitted");
  const nonVacuous = admitted.filter((x) => !x.j.final.vacuity.vacuous);
  const flagged = admitted.filter((x) => x.j.final.staticCheck?.unasserted?.length);
  const [lo, hi] = wilson(admitted.length, jobs.length);
  const attempts = jobs.map((x) => x.j.attemptsUsed as number);
  const firstShot = jobs.filter((x) => x.j.outcome === "admitted" && x.j.attemptsUsed === 1).length;
  const modelMs = jobs.map((x) => x.j.totals.modelMs as number);
  const callMs = jobs.flatMap((x) => x.j.attempts.map((a: any) => a.call.ms as number));
  const wallMs = jobs.map((x) => x.j.totals.wallMs as number);
  const ptok = jobs.map((x) => x.j.totals.promptTokens as number);
  const ctok = jobs.map((x) => x.j.totals.completionTokens as number);
  const cost = jobs.map((x) => (x.j.totals.promptTokens * pin + x.j.totals.completionTokens * pout) / 1e6);
  const evals = jobs.map((x) => x.j.attempts.filter((a: any) => a.cells).length);
  const tier1 = jobs.map((x, i) => (evals[i]! * IDS_PER_EVAL + (x.j.final ? IDS_MUTANT : 0)) * PER_ID);
  const retries = jobs.map((x) => x.j.attempts.reduce((a: number, t: any) => a + (t.call.infraRetries as number), 0));
  const modes: Record<string, number> = {};
  for (const x of jobs) {
    if (x.j.outcome === "admitted") {
      if (x.j.final.vacuity.vacuous) modes.vacuous = (modes.vacuous ?? 0) + 1;
      continue;
    }
    if (!x.j.final) {
      modes[x.j.outcome] = (modes[x.j.outcome] ?? 0) + 1;
      continue;
    }
    const cells = Object.values(x.j.final.admission.cells) as Array<{ observed: string[] }>;
    if (cells.every((c) => c.observed.length > 0 && c.observed.every((o) => o === "fail"))) {
      // Fails the same way in every world: the probe never reached its measurement.
      const rf = join(mdir, x.f.replace(".json", ".reeval.json"));
      const err = existsSync(rf) ? (JSON.parse(readFileSync(rf, "utf8")).evals.find((w: any) => w.world === "A")?.runs?.[0]?.testError ?? "") : "";
      const k = err === "" ? "fails-everywhere" : err.startsWith("AssertionError") ? "fails-everywhere: setup assertion" : "fails-everywhere: runtime error";
      modes[k] = (modes[k] ?? 0) + 1;
      continue;
    }
    for (const fm of x.j.final.admission.failures as string[]) modes[fm] = (modes[fm] ?? 0) + 1;
  }
  // Deterministic errors fed back, by class, and whether the next attempt was clear of that class.
  const fed: Record<string, { fed: number; cleared: number }> = {};
  for (const x of jobs) {
    const as = x.j.attempts as any[];
    as.forEach((a, i) => {
      if (!a.errors) return;
      const classes = new Set((a.errors as string).split("\n\n").map(errorClass));
      for (const c of classes) {
        fed[c] ??= { fed: 0, cleared: 0 };
        const next = as[i + 1];
        if (!next) continue;
        fed[c].fed++;
        const nextClasses = new Set(((next.errors ?? "") as string).split("\n\n").filter(Boolean).map(errorClass));
        if (!nextClasses.has(c)) fed[c].cleared++;
      }
    });
  }
  out.push(`## ${model}  (${m}, ${jobs[0]!.j.mode ?? "probe"}, temperature ${jobs[0]!.j.settings.temperature}, max tokens ${jobs[0]!.j.settings.maxTokens})`);
  out.push(`runs: ${jobs.map((x) => x.j.startedAt).toSorted()[0]} .. ${jobs.map((x) => x.j.startedAt).toSorted().at(-1)}`);
  out.push(`admitted ${admitted.length}/${jobs.length} (95% Wilson ${lo.toFixed(2)}–${hi.toFixed(2)}); first-shot ${firstShot}; admitted and non-vacuous ${nonVacuous.length}; static flag on admitted ${flagged.length}`);
  out.push(`outcomes: ${JSON.stringify(Object.fromEntries(["admitted", "rejected", "abstained", "infra-error"].map((o) => [o, jobs.filter((x) => x.j.outcome === o).length])))}`);
  out.push(`attempts used: ${JSON.stringify(Object.fromEntries([1, 2, 3, 4].map((k) => [k, attempts.filter((a) => a === k).length])))} mean ${mean(attempts).toFixed(1)}`);
  out.push(`failure modes (final drafts): ${JSON.stringify(modes)}`);
  out.push(`errors fed back -> cleared next attempt: ${JSON.stringify(fed)}`);
  out.push(`model ms per draft p50 ${Math.round(pct(modelMs, 0.5))} max ${Math.round(Math.max(...modelMs))}; per call p50 ${Math.round(pct(callMs, 0.5))} max ${Math.round(Math.max(...callMs))}; draft wall p50 ${Math.round(pct(wallMs, 0.5))}`);
  out.push(`platform timeouts retried (3046): ${retries.reduce((a, b) => a + b, 0)} over ${retries.filter((r) => r > 0).length} drafts`);
  out.push(`tokens per draft: prompt mean ${Math.round(mean(ptok))}, completion mean ${Math.round(mean(ctok))} (max ${Math.max(...ctok)})`);
  out.push(`cost per draft: model $${mean(cost).toFixed(4)} (total $${cost.reduce((a, b) => a + b, 0).toFixed(3)}), Tier 1 ids $${mean(tier1).toFixed(3)}`);
  for (const x of jobs) {
    const f = x.j.final;
    const cells = f ? Object.entries(f.admission.cells).map(([w, c]: [string, any]) => `${w}=${c.observed.join("/")}`).join(" ") : "";
    let reason = "";
    if (f && x.j.outcome !== "admitted") {
      const rf = join(mdir, x.f.replace(".json", ".reeval.json"));
      if (reeval && !existsSync(rf)) writeFileSync(rf, JSON.stringify(await evaluate(f.probe), null, 2));
      if (existsSync(rf)) {
        const r = JSON.parse(readFileSync(rf, "utf8"));
        const e = r.evals.find((w: any) => w.world === "A");
        reason = e?.bundleError ? `A bundle: ${String(e.bundleError).split("\n").slice(0, 2).join(" ")}` : `A: ${e?.runs?.[0]?.reason ?? ""} ${e?.runs?.[0]?.testError ? `[${e.runs[0].testError.slice(0, 90)}]` : ""}`;
      }
    }
    const extra = f ? ` vacuous=${f.vacuity.vacuous}${f.staticCheck?.unasserted?.length ? " static-flag" : ""}` : "";
    out.push(`  ${x.f}: ${x.j.outcome} att=${x.j.attemptsUsed} ${cells}${extra} ${reason.slice(0, 220)}`);
  }
  out.push("");
}
console.log(out.join("\n"));
