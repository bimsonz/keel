// Computes verdicts in code from each model's chosen lattice value and
// reports recall/precision/decoy FP across thresholds, unclear share,
// permuted agreement and flip rate, and latency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, percentile, save } from "./client.ts";
import { compare, violating, UNCLEAR, type Premise } from "../src/lattice.ts";
import type { Variant } from "../src/questions.ts";

interface Item {
  id: string;
  kind: "core" | "decoy";
  decoyType?: string;
  premise: Premise;
  groundTruthEffect: { value: string };
  label: "contradiction" | "compatible";
}
interface Raw {
  mode: "joint" | "separate" | "batch64";
  item: string;
  variants?: Variant[];
  batchVariants?: Record<string, Variant>;
  ok: boolean;
  ms: number;
  clientMs: number;
  retries: number;
  output: { answers: Record<string, { choice: string; probabilities: Record<string, number>; confidence: number }>; usage: { input_tokens: number } };
}
interface Ans { value: string; p: Record<string, number>; pChosen: number; pViolate: number; confidence: number }

const ds = JSON.parse(readFileSync(join(RESULTS, "..", "..", "..", "docs", "spikes", "s17-dataset.json"), "utf8")) as { items: Item[] };
const byId = new Map(ds.items.map((i) => [i.id, i]));
const THRESHOLDS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const PRIMARY = { rule: "keel-mass", t: 0.5 };

function decode(item: Item, v: Variant, a: Raw["output"]["answers"][string]): Ans {
  const p: Record<string, number> = {};
  for (const [id, prob] of Object.entries(a.probabilities)) p[v.valueOf[id]] = prob;
  const value = v.valueOf[a.choice];
  const viol = violating(item.premise);
  return { value, p, pChosen: p[value], pViolate: viol.reduce((s, x) => s + (p[x] ?? 0), 0), confidence: a.confidence };
}

type Rule = (answers: Ans[], item: Item, t: number) => "contradiction" | "compatible" | "abstain";
const verdictOf = (item: Item, a: Ans) => compare(item.premise, a.value);
const RULES: Record<string, Rule> = {
  // one ask (v0), argmax value, its probability must reach t
  "single-argmax": ([a], item, t) => (a.pChosen < t ? "abstain" : verdictOf(item, a)),
  // one ask (v0), probability mass on violating values
  "single-mass": ([a], _item, t) => (a.value === UNCLEAR ? "abstain" : a.pViolate >= t ? "contradiction" : 1 - a.pViolate >= t ? "compatible" : "abstain"),
  // Keel: all three permutations must agree on the value; min probability >= t
  "keel-argmax": (as, item, t) => {
    if (!as.every((a) => a.value === as[0].value)) return "abstain";
    if (Math.min(...as.map((a) => a.pChosen)) < t) return "abstain";
    return verdictOf(item, as[0]);
  },
  // Keel: every permutation must put >= t mass on violating values (or all on non-violating)
  "keel-mass": (as, _item, t) => {
    if (as.some((a) => a.value === UNCLEAR)) return "abstain";
    if (as.every((a) => a.pViolate >= t)) return "contradiction";
    if (as.every((a) => 1 - a.pViolate >= t && a.pViolate < 0.5)) return "compatible";
    return "abstain";
  },
};

function metrics(answersByItem: Map<string, Ans[]>, rule: Rule, t: number) {
  let tp = 0, fp = 0, fn = 0, decoyFp = 0, compatFp = 0, decided = 0, wrong = 0;
  const contra = ds.items.filter((i) => i.label === "contradiction").length;
  const decoys = ds.items.filter((i) => i.kind === "decoy").length;
  const compat = ds.items.filter((i) => i.kind === "core" && i.label === "compatible").length;
  const misses: string[] = [], falseFlags: string[] = [];
  for (const item of ds.items) {
    const as = answersByItem.get(item.id)!;
    const v = rule(as, item, t);
    if (v !== "abstain") { decided++; if (v !== item.label) wrong++; }
    if (v === "contradiction") {
      if (item.label === "contradiction") tp++;
      else { fp++; falseFlags.push(item.id); if (item.kind === "decoy") decoyFp++; else compatFp++; }
    } else if (item.label === "contradiction") { fn++; misses.push(item.id); }
  }
  return {
    t,
    recall: tp / contra,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    decoyFpRate: decoyFp / decoys,
    compatibleFpRate: compatFp / compat,
    coverage: decided / ds.items.length,
    risk: decided === 0 ? null : wrong / decided,
    tp, fp, fn, misses, falseFlags,
  };
}

const report: Record<string, unknown> = { primary: PRIMARY };
for (const model of ["clef-flash", "clef"]) {
  const raw = JSON.parse(readFileSync(join(RESULTS, `eval-raw-${model}.json`), "utf8")) as Raw[];
  const retries = raw.reduce((s, r) => s + (r.retries ?? 0), 0);
  const modeReport: Record<string, unknown> = {};
  for (const mode of ["joint", "separate"] as const) {
    const answersByItem = new Map<string, Ans[]>();
    for (const item of ds.items) {
      const rows = raw.filter((r) => r.mode === mode && r.item === item.id);
      const as: Ans[] = [];
      for (const vname of ["v0", "v1", "v2"]) {
        const row = rows.find((r) => r.variants!.some((v) => v.name === vname))!;
        const v = row.variants!.find((x) => x.name === vname)!;
        as.push(decode(item, v, row.output.answers[vname]));
      }
      answersByItem.set(item.id, as);
    }
    const all = [...answersByItem.values()].flat();
    const items = [...answersByItem.entries()];
    const allAgree = items.filter(([, as]) => as.every((a) => a.value === as[0].value)).length / items.length;
    const pairs = items.flatMap(([, as]) => [[as[0], as[1]], [as[0], as[2]], [as[1], as[2]]]);
    const flip = pairs.filter(([a, b]) => a.value !== b.value).length / pairs.length;
    const verdictAgree = items.filter(([id, as]) => {
      const it = byId.get(id)!;
      return as.every((a) => compare(it.premise, a.value) === compare(it.premise, as[0].value));
    }).length / items.length;
    const v0Correct = items.filter(([id, as]) => as[0].value === byId.get(id)!.groundTruthEffect.value).length / items.length;
    const perItem = items.map(([id, as]) => ({
      id,
      truth: byId.get(id)!.groundTruthEffect.value,
      label: byId.get(id)!.label,
      chosen: as.map((a) => a.value),
      pChosen: as.map((a) => +a.pChosen.toFixed(3)),
      pViolate: as.map((a) => +a.pViolate.toFixed(3)),
    }));
    const rules = Object.fromEntries(
      Object.entries(RULES).map(([name, rule]) => [name, THRESHOLDS.map((t) => metrics(answersByItem, rule, t))]),
    );
    modeReport[mode] = {
      unclearShare: all.filter((a) => a.value === UNCLEAR).length / all.length,
      v0ValueAccuracy: v0Correct,
      permutedAgreementAll3: allAgree,
      flipRatePairwise: flip,
      verdictAgreementAll3: verdictAgree,
      rules,
      perItem,
    };
  }
  // joint vs separate: same question, does sharing a call change the answer?
  const jointVsSeparate = (() => {
    let same = 0, n = 0, maxDelta = 0;
    for (const item of ds.items) {
      const j = raw.find((r) => r.mode === "joint" && r.item === item.id)!;
      for (const vname of ["v0", "v1", "v2"]) {
        const s = raw.find((r) => r.mode === "separate" && r.item === item.id && r.variants![0].name === vname)!;
        const ja = j.output.answers[vname], sa = s.output.answers[vname];
        n++;
        if (ja.choice === sa.choice) same++;
        for (const k of Object.keys(ja.probabilities)) maxDelta = Math.max(maxDelta, Math.abs(ja.probabilities[k] - sa.probabilities[k]));
      }
    }
    return { sameChoice: same / n, maxProbabilityDelta: +maxDelta.toFixed(4) };
  })();
  // 64-question batch: C01.v0 in the batch vs C01.v0 asked alone
  const b64 = raw.filter((r) => r.mode === "batch64");
  const alone = raw.find((r) => r.mode === "separate" && r.item === "C01" && r.variants![0].name === "v0")!;
  const inBatch = b64[0].output.answers["C01.v0"];
  const lat = (rows: Raw[], n: number) => ({
    calls: rows.length,
    callP50: percentile(rows.map((r) => r.ms), 50),
    callP95: percentile(rows.map((r) => r.ms), 95),
    perQuestionP50: +(percentile(rows.map((r) => r.ms), 50) / n).toFixed(1),
    perQuestionP95: +(percentile(rows.map((r) => r.ms), 95) / n).toFixed(1),
    clientP50: Math.round(percentile(rows.map((r) => r.clientMs), 50)),
    inputTokensP50: percentile(rows.map((r) => r.output.usage.input_tokens), 50),
  });
  report[model] = {
    calls: raw.length,
    errors: raw.filter((r) => !r.ok).length,
    retries,
    modes: modeReport,
    jointVsSeparate,
    batch64CrossQuestion: {
      aloneChoice: alone.output.answers.v0.choice,
      aloneProbabilities: alone.output.answers.v0.probabilities,
      inBatchChoice: inBatch.choice,
      inBatchProbabilities: inBatch.probabilities,
      batchDeterministic: b64.every((r) => JSON.stringify(r.output.answers) === JSON.stringify(b64[0].output.answers)),
    },
    latency: {
      q1: lat(raw.filter((r) => r.mode === "separate"), 1),
      q3: lat(raw.filter((r) => r.mode === "joint"), 3),
      q64: lat(b64, 64),
    },
  };
}
save("eval-report.json", report);

// compact console summary
const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);
for (const model of ["clef-flash", "clef"]) {
  const r = report[model] as any;
  console.log(`\n=== ${model}  calls=${r.calls} errors=${r.errors} retries=${r.retries}`);
  for (const mode of ["joint", "separate"]) {
    const m = r.modes[mode];
    console.log(`-- ${mode}: v0 value acc ${pct(m.v0ValueAccuracy)}  unclear ${pct(m.unclearShare)}  agree(all3) ${pct(m.permutedAgreementAll3)}  flip ${pct(m.flipRatePairwise)}  verdict-agree ${pct(m.verdictAgreementAll3)}`);
    for (const [rule, rows] of Object.entries(m.rules) as [string, any[]][]) {
      console.log(`   ${rule.padEnd(14)} ` + rows.map((x) => `t=${x.t}: R${pct(x.recall)} P${pct(x.precision)} dFP${pct(x.decoyFpRate)} cov${pct(x.coverage)}`).join(" | "));
    }
  }
  console.log(`   joint-vs-separate ${JSON.stringify(r.jointVsSeparate)}`);
  console.log(`   batch64 C01.v0: alone=${r.batch64CrossQuestion.aloneChoice} inBatch=${r.batch64CrossQuestion.inBatchChoice} deterministic=${r.batch64CrossQuestion.batchDeterministic}`);
  console.log(`   latency ${JSON.stringify(r.latency)}`);
}
