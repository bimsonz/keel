// Computes verdicts in code from Clef's chosen lattice values and reports, with
// Wilson 95% intervals: recall, precision, decoy FP rate, relabelled agreement,
// pairwise flip rate, unclear share; per predicate, per source, per language;
// both gates (probability mass and top choice); latency; truncation checks;
// and the two controls (reorder-only asks, S17's unsanitised items).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, percentile, save } from "./client.ts";
import { CONTEXT_LIMIT } from "../src/estimator.ts";
import { LATTICES, UNCLEAR, compare, violating, type Premise } from "../src/lattice.ts";
import type { Variant } from "../src/questions.ts";
import { sameProbabilities, wilson } from "./analyze-lib.ts";

interface Item {
  id: string;
  source: "s17" | "forge-lite" | "synthetic";
  kind: "core" | "decoy";
  decoyType?: string;
  language: string;
  family?: string;
  tags?: string[];
  premise: Premise;
  groundTruthEffect: { value: string };
  label: "contradiction" | "compatible";
}
interface Raw {
  mode: string;
  item: string;
  variants: Variant[];
  estimate: { bytes: number; estimatedTokens: number; oversize: boolean };
  skipped?: string;
  truncated?: boolean;
  ok?: boolean;
  ms?: number;
  clientMs?: number;
  retries?: number;
  output?: { answers: Record<string, { choice: string; probabilities: Record<string, number> }>; usage: { input_tokens: number } };
}
interface Ans { value: string; pChosen: number; pViolate: number }
type Verdict = "contradiction" | "compatible" | "abstain";

const docs = join(RESULTS, "..", "..", "..", "docs", "spikes");
const ds = JSON.parse(readFileSync(join(docs, "s17b-dataset.json"), "utf8")) as { items: Item[] };
const s17orig = JSON.parse(readFileSync(join(docs, "s17-dataset.json"), "utf8")) as { items: Item[] };
const raw = (mode: string) => JSON.parse(readFileSync(join(RESULTS, `eval-raw-${mode}.json`), "utf8")) as Raw[];

/** Answers per item, or null when the item abstains before any answer (estimator skip, error, truncation). */
function answersOf(rows: Raw[], items: Item[]): Map<string, Ans[] | null> {
  const out = new Map<string, Ans[] | null>();
  for (const item of items) {
    const r = rows.find((x) => x.item === item.id);
    if (!r || r.skipped || !r.ok || r.truncated || !r.output) { out.set(item.id, null); continue; }
    const viol = violating(item.premise);
    out.set(item.id, r.variants.map((v) => {
      const a = r.output!.answers[v.name];
      const p: Record<string, number> = {};
      for (const [id, prob] of Object.entries(a.probabilities)) p[v.valueOf[id]] = prob;
      const value = v.valueOf[a.choice];
      return { value, pChosen: p[value], pViolate: viol.reduce((s, x) => s + (p[x] ?? 0), 0) };
    }));
  }
  return out;
}

type Rule = (as: Ans[], item: Item, t: number) => Verdict;
const RULES: Record<string, Rule> = {
  // The gate: every relabelled ask puts >= t of its mass on premise-violating values.
  "keel-mass": (as, _item, t) => {
    if (as.some((a) => a.value === UNCLEAR)) return "abstain";
    if (as.every((a) => a.pViolate >= t)) return "contradiction";
    if (as.every((a) => 1 - a.pViolate >= t && a.pViolate < 0.5)) return "compatible";
    return "abstain";
  },
  // Can-fail variant: gate on the top choice of each ask instead of mass.
  "keel-top": (as, item) => {
    if (as.some((a) => a.value === UNCLEAR)) return "abstain";
    const v = as.map((a) => compare(item.premise, a.value));
    if (v.every((x) => x === "contradiction")) return "contradiction";
    if (v.every((x) => x === "compatible")) return "compatible";
    return "abstain";
  },
  // One ask (v0) only, mass gate.
  "single-mass": ([a], _item, t) => (a.value === UNCLEAR ? "abstain" : a.pViolate >= t ? "contradiction" : 1 - a.pViolate >= t ? "compatible" : "abstain"),
};

function gate(items: Item[], ans: Map<string, Ans[] | null>, rule: Rule, t: number) {
  let tp = 0, fp = 0, decoyFp = 0, compatFp = 0, decided = 0, wrong = 0;
  const misses: string[] = [], falseFlags: string[] = [], abstained: string[] = [];
  for (const item of items) {
    const as = ans.get(item.id);
    const v: Verdict = as ? rule(as, item, t) : "abstain";
    if (v === "abstain") abstained.push(item.id);
    else { decided++; if (v !== item.label) wrong++; }
    if (v === "contradiction") {
      if (item.label === "contradiction") tp++;
      else { fp++; falseFlags.push(item.id); if (item.kind === "decoy") decoyFp++; else compatFp++; }
    } else if (item.label === "contradiction") misses.push(item.id);
  }
  const contra = items.filter((i) => i.label === "contradiction").length;
  return {
    t,
    recall: wilson(tp, contra),
    precision: wilson(tp, tp + fp),
    decoyFpRate: wilson(decoyFp, items.filter((i) => i.kind === "decoy").length),
    compatibleFpRate: wilson(compatFp, items.filter((i) => i.kind === "core" && i.label === "compatible").length),
    coverage: wilson(decided, items.length),
    risk: wilson(wrong, decided),
    misses, falseFlags, abstained,
  };
}

function stability(items: Item[], ans: Map<string, Ans[] | null>) {
  const got = items.filter((i) => ans.get(i.id));
  const as = got.map((i) => ans.get(i.id)!);
  const agree = as.filter((a) => a.every((x) => x.value === a[0].value)).length;
  const flips = as.reduce((s, a) => s + [[0, 1], [0, 2], [1, 2]].filter(([x, y]) => a[x].value !== a[y].value).length, 0);
  const verdictAgree = got.filter((i) => {
    const a = ans.get(i.id)!;
    return a.every((x) => compare(i.premise, x.value) === compare(i.premise, a[0].value));
  }).length;
  const unclear = as.reduce((s, a) => s + a.filter((x) => x.value === UNCLEAR).length, 0);
  const v0Correct = got.filter((i) => ans.get(i.id)![0].value === i.groundTruthEffect.value).length;
  const allCorrect = got.filter((i) => ans.get(i.id)!.every((x) => x.value === i.groundTruthEffect.value)).length;
  return {
    answered: got.length,
    relabelledAgreement: wilson(agree, got.length),
    pairwiseFlipRate: wilson(flips, 3 * got.length),
    verdictAgreement: wilson(verdictAgree, got.length),
    unclearShare: wilson(unclear, 3 * got.length),
    v0ValueAccuracy: wilson(v0Correct, got.length),
    allThreeCorrect: wilson(allCorrect, got.length),
    disagreeing: got.filter((i) => { const a = ans.get(i.id)!; return !a.every((x) => x.value === a[0].value); })
      .map((i) => ({ id: i.id, truth: i.groundTruthEffect.value, chosen: ans.get(i.id)!.map((x) => x.value), pViolate: ans.get(i.id)!.map((x) => +x.pViolate.toFixed(3)) })),
  };
}

function summary(items: Item[], ans: Map<string, Ans[] | null>) {
  return { n: items.length, contradictions: items.filter((i) => i.label === "contradiction").length, decoys: items.filter((i) => i.kind === "decoy").length, gate: gate(items, ans, RULES["keel-mass"], 0.5), topChoice: gate(items, ans, RULES["keel-top"], 0.5), ...stability(items, ans) };
}

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const mainRows = raw("main");
const ans = answersOf(mainRows, ds.items);
const by = (key: (i: Item) => string) => {
  const groups = new Map<string, Item[]>();
  for (const i of ds.items) groups.set(key(i), [...(groups.get(key(i)) ?? []), i]);
  return Object.fromEntries([...groups].map(([k, v]) => [k, summary(v, ans)]));
};

const calls = mainRows.filter((r) => r.ok && r.ms !== undefined);
const ms = calls.map((r) => r.ms!);
const tokens = calls.map((r) => r.output!.usage.input_tokens);
const report = {
  calls: mainRows.length,
  errors: mainRows.filter((r) => !r.skipped && !r.ok).length,
  retries: mainRows.reduce((s, r) => s + (r.retries ?? 0), 0),
  overall: summary(ds.items, ans),
  bySource: by((i) => i.source),
  byPredicate: Object.fromEntries(Object.keys(LATTICES).map((p) => [p, summary(ds.items.filter((i) => i.premise.predicate === p), ans)])),
  byKind: by((i) => (i.kind === "core" ? `core-${i.label}` : `decoy-${i.decoyType}`)),
  byLanguage: by((i) => i.language),
  forgeLite: ds.items.filter((i) => i.source === "forge-lite").map((i) => ({ id: i.id, label: i.label, truth: i.groundTruthEffect.value, tags: i.tags, chosen: ans.get(i.id)?.map((a) => a.value), pViolate: ans.get(i.id)?.map((a) => +a.pViolate.toFixed(3)), verdict: ans.get(i.id) ? RULES["keel-mass"](ans.get(i.id)!, i, 0.5) : "abstain" })),
  thresholds: Object.fromEntries(["keel-mass", "single-mass"].map((r) => [r, THRESHOLDS.map((t) => gate(ds.items, ans, RULES[r], t))])),
  latency: {
    callP50: percentile(ms, 50), callP95: percentile(ms, 95), callMax: Math.max(...ms),
    perQuestionP50: +(percentile(ms, 50) / 3).toFixed(1), perQuestionP95: +(percentile(ms, 95) / 3).toFixed(1),
    clientP50: Math.round(percentile(calls.map((r) => r.clientMs!), 50)),
    inputTokensP50: percentile(tokens, 50), inputTokensMax: Math.max(...tokens),
  },
  truncation: {
    cap: CONTEXT_LIMIT.clef,
    estimatorMaxTokens: Math.max(...mainRows.map((r) => r.estimate.estimatedTokens)),
    estimatorOversize: mainRows.filter((r) => r.estimate.oversize).map((r) => r.item),
    postCallAtCap: mainRows.filter((r) => r.truncated).map((r) => r.item),
    minBytesPerToken: +Math.min(...calls.map((r) => r.estimate.bytes / r.output!.usage.input_tokens)).toFixed(3),
  },
  controls: {} as Record<string, unknown>,
};

// Control 1: reorder-only asks (same ids, criteria keys permuted).
const reorderAns = answersOf(raw("reorder"), ds.items);
const identical = raw("reorder").filter((r) => r.output && sameProbabilities(r.output.answers.v0.probabilities, r.output.answers.v1.probabilities) && sameProbabilities(r.output.answers.v0.probabilities, r.output.answers.v2.probabilities)).length;
report.controls.reorderOnly = { ...stability(ds.items, reorderAns), bitIdenticalProbabilitiesAcrossAsks: wilson(identical, raw("reorder").length), gate: gate(ds.items, reorderAns, RULES["keel-mass"], 0.5) };

// Control 2: S17's 40 items unsanitised, against the sanitised copies in this set.
const origAns = answersOf(raw("s17orig"), s17orig.items);
const s17sub = ds.items.filter((i) => i.source === "s17");
report.controls.s17Original = {
  original: { gate: gate(s17orig.items, origAns, RULES["keel-mass"], 0.5), ...stability(s17orig.items, origAns) },
  sanitised: { gate: gate(s17sub, ans, RULES["keel-mass"], 0.5), ...stability(s17sub, ans) },
  changedAnswers: s17sub.filter((i) => JSON.stringify(origAns.get(i.id)?.map((a) => a.value)) !== JSON.stringify(ans.get(i.id)?.map((a) => a.value)))
    .map((i) => ({ id: i.id, truth: i.groundTruthEffect.value, original: origAns.get(i.id)?.map((a) => a.value), sanitised: ans.get(i.id)?.map((a) => a.value) })),
};
// Exploratory (not the pre-registered method): a fixed yes/no question in slot 1, the three asks behind it.
const warmAns = answersOf(raw("warmup"), ds.items);
report.controls.warmupSlot = summary(ds.items, warmAns);
report.controls.warmupSlotBySource = Object.fromEntries(["s17", "forge-lite", "synthetic"].map((src) => [src, summary(ds.items.filter((i) => i.source === src), warmAns)]));
save("eval-report.json", report);

// Console summary.
const pc = (w: { p: number | null; lo: number | null; hi: number | null; k: number; n: number }) =>
  w.p === null ? "   n/a" : `${(w.p * 100).toFixed(1).padStart(5)}% [${(w.lo! * 100).toFixed(1)}-${(w.hi! * 100).toFixed(1)}] (${w.k}/${w.n})`;
const row = (name: string, s: ReturnType<typeof summary>) =>
  console.log(`${name.padEnd(22)} n=${String(s.n).padStart(3)} R ${pc(s.gate.recall)} | P ${pc(s.gate.precision)} | dFP ${pc(s.gate.decoyFpRate)} | agree ${pc(s.relabelledAgreement)} | cov ${pc(s.gate.coverage)}`);
console.log(`calls=${report.calls} errors=${report.errors} retries=${report.retries}`);
row("overall (mass gate)", report.overall);
const o = report.overall;
console.log(`${"overall (top choice)".padEnd(22)} n=${o.n} R ${pc(o.topChoice.recall)} | P ${pc(o.topChoice.precision)} | dFP ${pc(o.topChoice.decoyFpRate)} | cov ${pc(o.topChoice.coverage)}`);
console.log(`flip ${pc(o.pairwiseFlipRate)} | verdict-agree ${pc(o.verdictAgreement)} | unclear ${pc(o.unclearShare)} | v0 acc ${pc(o.v0ValueAccuracy)} | compatFP ${pc(o.gate.compatibleFpRate)}`);
console.log(`misses: ${o.gate.misses.join(", ")}\nfalse flags: ${o.gate.falseFlags.join(", ")}\nabstained: ${o.gate.abstained.join(", ")}`);
for (const [k, s] of Object.entries(report.bySource)) row(`source ${k}`, s);
for (const [k, s] of Object.entries(report.byPredicate)) row(`pred ${k}`, s);
for (const [k, s] of Object.entries(report.byKind)) row(`kind ${k}`, s);
for (const [k, s] of Object.entries(report.byLanguage)) row(`lang ${k}`, s);
console.log("thresholds keel-mass: " + report.thresholds["keel-mass"].map((g) => `t=${g.t} R${((g.recall.p ?? 0) * 100).toFixed(1)} P${((g.precision.p ?? 0) * 100).toFixed(1)} dFP${((g.decoyFpRate.p ?? 0) * 100).toFixed(1)} cov${((g.coverage.p ?? 0) * 100).toFixed(1)}`).join(" | "));
console.log(`latency ${JSON.stringify(report.latency)}`);
console.log(`truncation ${JSON.stringify(report.truncation)}`);
const ro = report.controls.reorderOnly as ReturnType<typeof stability> & { bitIdenticalProbabilitiesAcrossAsks: ReturnType<typeof wilson> };
console.log(`control reorder-only: agree ${pc(ro.relabelledAgreement)} flip ${pc(ro.pairwiseFlipRate)} bit-identical ${pc(ro.bitIdenticalProbabilitiesAcrossAsks)}`);
const so = report.controls.s17Original as { original: ReturnType<typeof stability> & { gate: ReturnType<typeof gate> }; sanitised: ReturnType<typeof stability> & { gate: ReturnType<typeof gate> }; changedAnswers: unknown[] };
console.log(`control S17 original: agree ${pc(so.original.relabelledAgreement)} R ${pc(so.original.gate.recall)} dFP ${pc(so.original.gate.decoyFpRate)} | sanitised: agree ${pc(so.sanitised.relabelledAgreement)} R ${pc(so.sanitised.gate.recall)} dFP ${pc(so.sanitised.gate.decoyFpRate)}`);
console.log(`changed answers: ${JSON.stringify(so.changedAnswers)}`);
console.log(`forge-lite: ${JSON.stringify(report.forgeLite)}`);
const ws = report.controls.warmupSlot as ReturnType<typeof summary>;
row("exploratory warm-up", ws);
console.log(`warm-up: flip ${pc(ws.pairwiseFlipRate)} | unclear ${pc(ws.unclearShare)} | v0 acc ${pc(ws.v0ValueAccuracy)} | all-3 correct ${pc(ws.allThreeCorrect)} | top-choice R ${pc(ws.topChoice.recall)} dFP ${pc(ws.topChoice.decoyFpRate)}`);
console.log(`warm-up misses: ${ws.gate.misses.join(", ")} | false flags: ${ws.gate.falseFlags.join(", ")}`);
console.log(`main all-3 correct ${pc(report.overall.allThreeCorrect)}`);
