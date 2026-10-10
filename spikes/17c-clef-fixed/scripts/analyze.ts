// S17c analysis. Verdicts are computed in code from Clef's probabilities; all
// intervals are Wilson 95%.
//   headline   S17b's gate unchanged (keel-mass, t = 0.5) on the main run, by
//              source, predicate, kind and language
//   ablation   no fix (S17b's main run, read from S17b's results) -> c1 (fix 1)
//              -> c2 (fixes 1 + 2) -> main (fixes 1 + 2 + 3)
//   position   per slot and per rotation, for every run
//   flags      S17b's 9 false flags, before and after, and any new ones
//   forge-lite F01-F08 per run, with B' (F03) called out
//   sweep      thresholds 0.50-0.95 under "all 3 asks" and "majority (2 of 3)",
//              overall and per predicate, with the recommended default
//
// Sweep rule (fixed before the runs were read). Each ask votes:
//   contradiction  if its mass on premise-violating values is >= t
//   compatible     if its mass on the other lattice values is >= t
//   no vote        otherwise, or if its top choice is "unclear"
// "all 3" decides when the three votes agree; "majority" when at least two
// agree. Anything else escalates. Recall counts an escalated contradiction as
// not flagged; a contradiction decided compatible is a silent miss.
// Recommended default per predicate: the lowest t whose decided verdicts hold
// no error (no false flag, no silent miss). Decided sets only shrink as t
// rises, so this is the highest-coverage error-free setting. If no t is error
// free, the recommendation is "always escalate". Between the two rules, the
// one with more coverage at its threshold wins; a tie goes to "all 3".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, percentile, save } from "./client.ts";
import { CONTEXT_LIMIT } from "../src/estimator.ts";
import { LATTICES, UNCLEAR, compare, violating, type Premise } from "../src/lattice.ts";
import type { Variant } from "../src/questions.ts";
import { wilson } from "./analyze-lib.ts";

interface Item {
  id: string;
  source: "s17" | "forge-lite" | "synthetic";
  kind: "core" | "decoy";
  decoyType?: string;
  language: string;
  premise: Premise;
  groundTruthEffect: { value: string };
  label: "contradiction" | "compatible";
  rotation: number;
  anchors: { view: string; touched: boolean };
}
interface Raw {
  item: string;
  variants: Variant[];
  slots?: string[];
  estimate: { bytes: number; estimatedTokens: number; oversize: boolean };
  skipped?: string;
  truncated?: boolean;
  ok?: boolean;
  ms?: number;
  clientMs?: number;
  retries?: number;
  output?: { answers: Record<string, { choice: string; probabilities: Record<string, number> }>; usage: { input_tokens: number } };
}
interface Ans { variant: string; slot: number; value: string; pViolate: number; pCompat: number }
type Verdict = "contradiction" | "compatible" | "abstain";
type W = ReturnType<typeof wilson>;

const docs = join(RESULTS, "..", "..", "..", "docs", "spikes");
const ds = JSON.parse(readFileSync(join(docs, "s17c-dataset.json"), "utf8")) as { items: Item[] };
const S17B_RESULTS = join(RESULTS, "..", "..", "17b-clef-scale", "results");
const raw = (mode: string): Raw[] => JSON.parse(readFileSync(mode === "s17b" ? join(S17B_RESULTS, "eval-raw-main.json") : join(RESULTS, `eval-raw-${mode}.json`), "utf8"));
const RUNS = ["s17b", "c1", "c2", "main"].filter((m) => m === "s17b" || existsSync(join(RESULTS, `eval-raw-${m}.json`)));
const RUN_LABEL: Record<string, string> = { s17b: "no fix (S17b main)", c1: "fix 1: comments stripped", c2: "fixes 1+2: + position balance", main: "fixes 1+2+3: + anchor scoping" };

/** Answers per item in variant order (v0, v1, v2), each with the slot it was asked in; null if the item abstained before answering. */
function answersOf(rows: Raw[]): Map<string, Ans[] | null> {
  const out = new Map<string, Ans[] | null>();
  for (const item of ds.items) {
    const r = rows.find((x) => x.item === item.id);
    if (!r || r.skipped || !r.ok || r.truncated || !r.output) { out.set(item.id, null); continue; }
    const viol = new Set(violating(item.premise));
    const slots = r.slots ?? r.variants.map((v) => v.name);
    out.set(item.id, r.variants.map((v) => {
      const a = r.output!.answers[v.name];
      let pViolate = 0;
      let pCompat = 0;
      for (const [id, prob] of Object.entries(a.probabilities)) {
        const value = v.valueOf[id];
        if (value === UNCLEAR) continue;
        if (viol.has(value)) pViolate += prob;
        else pCompat += prob;
      }
      return { variant: v.name, slot: slots.indexOf(v.name), value: v.valueOf[a.choice], pViolate, pCompat };
    }));
  }
  return out;
}

// S17b's gate, unchanged: every ask >= t on violating mass flags; compatible needs every ask's complement >= t.
function keelMass(as: Ans[], t: number): Verdict {
  if (as.some((a) => a.value === UNCLEAR)) return "abstain";
  if (as.every((a) => a.pViolate >= t)) return "contradiction";
  if (as.every((a) => 1 - a.pViolate >= t && a.pViolate < 0.5)) return "compatible";
  return "abstain";
}

type Rule = "all3" | "maj2";
function sweepVerdict(as: Ans[], t: number, rule: Rule): Verdict {
  const votes = as.map((a) => (a.value === UNCLEAR ? null : a.pViolate >= t ? "contradiction" : a.pCompat >= t ? "compatible" : null));
  const need = rule === "all3" ? 3 : 2;
  const c = votes.filter((v) => v === "contradiction").length;
  const k = votes.filter((v) => v === "compatible").length;
  if (c >= need && k < need) return "contradiction";
  if (k >= need && c < need) return "compatible";
  return "abstain";
}

function gate(items: Item[], verdictOf: (i: Item) => Verdict) {
  let tp = 0, fp = 0, decoyFp = 0, compatFp = 0, decided = 0, wrong = 0, silent = 0;
  const misses: string[] = [], falseFlags: string[] = [], silentMisses: string[] = [];
  for (const item of items) {
    const v = verdictOf(item);
    if (v !== "abstain") { decided++; if (v !== item.label) wrong++; }
    if (v === "contradiction") {
      if (item.label === "contradiction") tp++;
      else { fp++; falseFlags.push(item.id); if (item.kind === "decoy") decoyFp++; else compatFp++; }
    } else if (item.label === "contradiction") {
      misses.push(item.id);
      if (v === "compatible") { silent++; silentMisses.push(item.id); }
    }
  }
  return {
    recall: wilson(tp, items.filter((i) => i.label === "contradiction").length),
    precision: wilson(tp, tp + fp),
    decoyFpRate: wilson(decoyFp, items.filter((i) => i.kind === "decoy").length),
    compatibleFpRate: wilson(compatFp, items.filter((i) => i.kind === "core" && i.label === "compatible").length),
    coverage: wilson(decided, items.length),
    escalated: wilson(items.length - decided, items.length),
    risk: wilson(wrong, decided),
    errors: wrong,
    silentMisses: silent,
    misses, falseFlags, silentMissIds: silentMisses,
  };
}

const allSame = (a: Ans[]) => a.every((x) => x.value === a[0].value);
function stability(items: Item[], ans: Map<string, Ans[] | null>) {
  const got = items.filter((i) => ans.get(i.id));
  const as = got.map((i) => ans.get(i.id)!);
  return {
    answered: got.length,
    relabelledAgreement: wilson(as.filter(allSame).length, got.length),
    pairwiseFlipRate: wilson(as.reduce((s, a) => s + [[0, 1], [0, 2], [1, 2]].filter(([x, y]) => a[x].value !== a[y].value).length, 0), 3 * got.length),
    verdictAgreement: wilson(got.filter((i) => { const a = ans.get(i.id)!; return a.every((x) => compare(i.premise, x.value) === compare(i.premise, a[0].value)); }).length, got.length),
    unclearShare: wilson(as.reduce((s, a) => s + a.filter((x) => x.value === UNCLEAR).length, 0), 3 * got.length),
    v0ValueAccuracy: wilson(got.filter((i) => ans.get(i.id)![0].value === i.groundTruthEffect.value).length, got.length),
    allThreeCorrect: wilson(got.filter((i) => ans.get(i.id)!.every((x) => x.value === i.groundTruthEffect.value)).length, got.length),
    disagreeing: got.filter((i) => !allSame(ans.get(i.id)!)).map((i) => ({ id: i.id, truth: i.groundTruthEffect.value, byVariant: ans.get(i.id)!.map((x) => x.value), bySlot: [0, 1, 2].map((s) => ans.get(i.id)!.find((x) => x.slot === s)!.value) })),
  };
}

function summary(items: Item[], ans: Map<string, Ans[] | null>) {
  return {
    n: items.length,
    contradictions: items.filter((i) => i.label === "contradiction").length,
    decoys: items.filter((i) => i.kind === "decoy").length,
    gate: gate(items, (i) => (ans.get(i.id) ? keelMass(ans.get(i.id)!, 0.5) : "abstain")),
    ...stability(items, ans),
  };
}

/** Slot s is the odd one out: the other two agree and s differs. */
const odd = (v: string[], s: number) => { const o = [0, 1, 2].filter((k) => k !== s); return v[o[0]] === v[o[1]] && v[s] !== v[o[0]]; };
const modal = (v: string[]) => (v[0] === v[1] || v[0] === v[2] ? v[0] : v[1] === v[2] ? v[1] : null);

/** Per slot (insertion position) and per rotation: S17b's finding was that the first-inserted ask is the odd one out. */
function position(items: Item[], ans: Map<string, Ans[] | null>) {
  const got = items.filter((i) => ans.get(i.id));
  const bySlot = (i: Item) => [0, 1, 2].map((s) => ans.get(i.id)!.find((x) => x.slot === s)!.value);
  return {
    slotAccuracy: [0, 1, 2].map((s) => wilson(got.filter((i) => bySlot(i)[s] === i.groundTruthEffect.value).length, got.length)),
    slotAgreesWithMajority: [0, 1, 2].map((s) => wilson(got.filter((i) => { const v = bySlot(i); return modal(v) !== null && v[s] === modal(v); }).length, got.length)),
    oddOneOutBySlot: [0, 1, 2].map((s) => got.filter((i) => odd(bySlot(i), s)).length),
    variantAccuracy: [0, 1, 2].map((k) => wilson(got.filter((i) => ans.get(i.id)![k].value === i.groundTruthEffect.value).length, got.length)),
    oddOneOutByVariant: [0, 1, 2].map((k) => got.filter((i) => odd(ans.get(i.id)!.map((x) => x.value), k)).length),
    agreementByRotation: [0, 1, 2].map((r) => { const g = got.filter((i) => i.rotation === r); return { first: `v${r}`, ...wilson(g.filter((i) => allSame(ans.get(i.id)!)).length, g.length) }; }),
  };
}

const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
function sweep(items: Item[], ans: Map<string, Ans[] | null>) {
  return Object.fromEntries((["all3", "maj2"] as Rule[]).map((rule) => [rule, THRESHOLDS.map((t) => ({ t, ...gate(items, (i) => (ans.get(i.id) ? sweepVerdict(ans.get(i.id)!, t, rule) : "abstain")) }))])) as Record<Rule, ({ t: number } & ReturnType<typeof gate>)[]>;
}
function recommend(sw: ReturnType<typeof sweep>) {
  const pick = (rule: Rule) => sw[rule].find((g) => g.errors === 0) ?? null;
  const a = pick("all3");
  const m = pick("maj2");
  const best = !a && !m ? null : !m || (a && (a.coverage.p ?? 0) >= (m.coverage.p ?? 0)) ? { rule: "all3", g: a! } : { rule: "maj2", g: m! };
  return {
    all3: a && { t: a.t, coverage: a.coverage, recall: a.recall },
    maj2: m && { t: m.t, coverage: m.coverage, recall: m.recall },
    choice: best ? { rule: best.rule, t: best.g.t, coverage: best.g.coverage, recall: best.g.recall, decided: best.g.coverage.k, riskUpperBound: best.g.risk.hi } : ("always escalate" as const),
  };
}

const answers = Object.fromEntries(RUNS.map((m) => [m, answersOf(raw(m))]));
const ans = answers.main ?? answers.c2 ?? answers.c1;
const items = ds.items;
const group = (key: (i: Item) => string, a = ans) => {
  const groups = new Map<string, Item[]>();
  for (const i of items) groups.set(key(i), [...(groups.get(key(i)) ?? []), i]);
  return Object.fromEntries([...groups].map(([k, v]) => [k, summary(v, a)]));
};
const PRED = Object.keys(LATTICES);
const kindOf = (i: Item) => (i.kind === "core" ? `core-${i.label}` : `decoy-${i.decoyType}`);
const S17B_FALSE_FLAGS = ["D02", "F03", "S021", "S027", "S059", "S060", "S146", "S147", "S148"];
const show = (a: Ans[] | null | undefined) => (a ? { chosen: a.map((x) => x.value), pViolate: a.map((x) => +x.pViolate.toFixed(3)), verdict: keelMass(a, 0.5) } : { chosen: null, pViolate: [], verdict: "abstain" as Verdict });

const mainRows = raw(RUNS.at(-1)!);
const calls = mainRows.filter((r) => r.ok && r.ms !== undefined);
const ms = calls.map((r) => r.ms!);
const tokens = calls.map((r) => r.output!.usage.input_tokens);
const touched = items.filter((i) => i.anchors.touched);
const ours = RUNS.filter((m) => m !== "s17b");
const report = {
  runs: Object.fromEntries(RUNS.map((m) => { const rows = raw(m); return [m, { calls: rows.length, errors: rows.filter((r) => !r.skipped && !r.ok).length, skipped: rows.filter((r) => r.skipped).length, retries: rows.reduce((s, r) => s + (r.retries ?? 0), 0) }]; })),
  overall: summary(items, ans),
  bySource: group((i) => i.source),
  byPredicate: Object.fromEntries(PRED.map((p) => [p, summary(items.filter((i) => i.premise.predicate === p), ans)])),
  byKind: group(kindOf),
  byLanguage: group((i) => i.language),
  touchedOnly: summary(touched, ans),
  // Keel's production policy: an untouched anchor is decided in code (the prior value stands); Clef is asked only about touched anchors.
  untouchedDecidedInCode: gate(items, (i) => (!i.anchors.touched ? "compatible" : ans.get(i.id) ? keelMass(ans.get(i.id)!, 0.5) : "abstain")),
  ablation: Object.fromEntries(RUNS.map((m) => [m, {
    label: RUN_LABEL[m],
    overall: summary(items, answers[m]),
    bySource: Object.fromEntries(["s17", "forge-lite", "synthetic"].map((s) => [s, summary(items.filter((i) => i.source === s), answers[m])])),
    byPredicate: Object.fromEntries(PRED.map((p) => [p, summary(items.filter((i) => i.premise.predicate === p), answers[m])])),
    byKind: group(kindOf, answers[m]),
    position: position(items, answers[m]),
  }])),
  s17bFalseFlags: S17B_FALSE_FLAGS.map((id) => { const i = items.find((x) => x.id === id)!; return { id, kind: kindOf(i), truth: i.groundTruthEffect.value, view: i.anchors.view, touched: i.anchors.touched, runs: Object.fromEntries(RUNS.map((m) => [m, show(answers[m].get(id))])) }; }),
  forgeLite: items.filter((i) => i.source === "forge-lite").map((i) => ({ id: i.id, label: i.label, truth: i.groundTruthEffect.value, view: i.anchors.view, runs: Object.fromEntries(RUNS.map((m) => [m, show(answers[m].get(i.id))])) })),
  sweep: {
    overall: sweep(items, ans),
    byPredicate: Object.fromEntries(PRED.map((p) => [p, sweep(items.filter((i) => i.premise.predicate === p), ans)])),
    bySource: Object.fromEntries(["s17", "forge-lite", "synthetic"].map((s) => [s, sweep(items.filter((i) => i.source === s), ans)])),
    touchedOnly: sweep(touched, ans),
    s17bOverall: sweep(items, answers.s17b),
  },
  recommended: {} as Record<string, ReturnType<typeof recommend>>,
  latency: {
    callP50: percentile(ms, 50), callP95: percentile(ms, 95), callMax: Math.max(...ms),
    perQuestionP50: +(percentile(ms, 50) / 3).toFixed(1), perQuestionP95: +(percentile(ms, 95) / 3).toFixed(1),
    clientP50: Math.round(percentile(calls.map((r) => r.clientMs!), 50)),
    inputTokensP50: percentile(tokens, 50), inputTokensMax: Math.max(...tokens),
  },
  truncation: {
    cap: CONTEXT_LIMIT.clef,
    estimatorMaxTokens: Math.max(...ours.flatMap((m) => raw(m).map((r) => r.estimate.estimatedTokens))),
    estimatorOversize: ours.flatMap((m) => raw(m).filter((r) => r.estimate.oversize).map((r) => `${m}:${r.item}`)),
    postCallAtCap: ours.flatMap((m) => raw(m).filter((r) => r.truncated).map((r) => `${m}:${r.item}`)),
    minBytesPerToken: +Math.min(...ours.flatMap((m) => raw(m).filter((r) => r.ok && r.output).map((r) => r.estimate.bytes / r.output!.usage.input_tokens))).toFixed(3),
  },
};
report.recommended.overall = recommend(report.sweep.overall);
report.recommended.touchedOnly = recommend(report.sweep.touchedOnly);
for (const p of PRED) report.recommended[p] = recommend(report.sweep.byPredicate[p]);
save("eval-report.json", report);

// ---------- console ----------
const pc = (w: W) => (w.p === null ? "   n/a" : `${(w.p * 100).toFixed(1).padStart(5)}% [${(w.lo! * 100).toFixed(1)}-${(w.hi! * 100).toFixed(1)}] (${w.k}/${w.n})`);
const short = (w: W) => (w.p === null ? "n/a" : `${(w.p * 100).toFixed(1)}`);
const row = (name: string, s: ReturnType<typeof summary>) =>
  console.log(`${name.padEnd(24)} n=${String(s.n).padStart(3)} R ${pc(s.gate.recall)} | P ${pc(s.gate.precision)} | dFP ${pc(s.gate.decoyFpRate)} | agree ${pc(s.relabelledAgreement)} | cov ${pc(s.gate.coverage)}`);
console.log(`runs ${JSON.stringify(report.runs)}`);
console.log(`\n== headline: ${RUN_LABEL[RUNS.at(-1)!]}, S17b gate (keel-mass t=0.5)`);
row("overall", report.overall);
const o = report.overall;
console.log(`flip ${pc(o.pairwiseFlipRate)} | verdict-agree ${pc(o.verdictAgreement)} | unclear ${pc(o.unclearShare)} | v0 acc ${pc(o.v0ValueAccuracy)} | all-3 correct ${pc(o.allThreeCorrect)} | compatFP ${pc(o.gate.compatibleFpRate)}`);
console.log(`misses: ${o.gate.misses.join(", ")} | silent: ${o.gate.silentMissIds.join(", ")}\nfalse flags: ${o.gate.falseFlags.join(", ")}`);
console.log(`disagreeing: ${o.disagreeing.map((d) => `${d.id}(${d.truth}: slots ${d.bySlot.join("/")})`).join(" ")}`);
for (const [k, s] of Object.entries(report.bySource)) row(`source ${k}`, s);
for (const [k, s] of Object.entries(report.byPredicate)) row(`pred ${k}`, s);
for (const [k, s] of Object.entries(report.byKind)) row(`kind ${k}`, s);
for (const [k, s] of Object.entries(report.byLanguage)) row(`lang ${k}`, s);
row("touched anchors only", report.touchedOnly);
const u = report.untouchedDecidedInCode;
console.log(`untouched decided in code: R ${pc(u.recall)} | P ${pc(u.precision)} | dFP ${pc(u.decoyFpRate)} | cov ${pc(u.coverage)} | false flags ${u.falseFlags.join(", ")}`);
console.log(`\n== ablation (agreement, recall, precision, decoy FP, coverage at the S17b gate)`);
for (const m of RUNS) {
  const a = report.ablation[m];
  row(`${m}`, a.overall);
  for (const s of ["s17", "forge-lite", "synthetic"]) row(`  ${m} ${s}`, a.bySource[s]);
  console.log(`  ${m} false flags: ${a.overall.gate.falseFlags.join(", ")} | misses: ${a.overall.gate.misses.join(", ")}`);
}
console.log(`\n== agreement by predicate across runs`);
console.log(`${"".padEnd(12)} ${RUNS.map((m) => m.padStart(16)).join("")}`);
for (const p of PRED) console.log(`${p.padEnd(12)} ${RUNS.map((m) => { const w = report.ablation[m].byPredicate[p].relabelledAgreement; return `${short(w).padStart(5)} (${w.k}/${w.n})`.padStart(16); }).join("")}`);
console.log(`\n== agreement by kind across runs`);
for (const k of Object.keys(report.byKind)) console.log(`${k.padEnd(30)} ${RUNS.map((m) => { const w = report.ablation[m].byKind[k].relabelledAgreement; return `${short(w).padStart(5)} (${w.k}/${w.n})`.padStart(16); }).join("")}`);
console.log(`\n== position`);
for (const m of RUNS) {
  const q = report.ablation[m].position;
  console.log(`${m.padEnd(5)} slot acc ${q.slotAccuracy.map(short).join("/")} | slot=majority ${q.slotAgreesWithMajority.map(short).join("/")} | odd one out by slot ${q.oddOneOutBySlot.join("/")} | by variant ${q.oddOneOutByVariant.join("/")} | variant acc ${q.variantAccuracy.map(short).join("/")}`);
  console.log(`      agreement by first ask: ${q.agreementByRotation.map((r) => `${r.first}: ${pc(r)}`).join("  ")}`);
}
console.log(`\n== S17b's 9 false flags`);
for (const f of report.s17bFalseFlags) console.log(`${f.id.padEnd(5)} ${f.kind.padEnd(30)} truth ${f.truth.padEnd(16)} ${RUNS.map((m) => `${m}: ${f.runs[m].chosen ? f.runs[m].chosen!.join("/") : "-"} ${f.runs[m].verdict}`).join(" | ")}`);
console.log(`\n== forge-lite`);
for (const f of report.forgeLite) console.log(`${f.id} ${f.label.padEnd(13)} truth ${f.truth.padEnd(12)} view ${f.view.padEnd(9)} ${RUNS.map((m) => `${m}: ${f.runs[m].chosen ? f.runs[m].chosen!.join("/") : "-"} [${f.runs[m].pViolate.join(",")}] ${f.runs[m].verdict}`).join(" | ")}`);
console.log(`\n== sweep (${RUNS.at(-1)})`);
const sw = (name: string, s: ReturnType<typeof sweep>) => {
  for (const rule of ["all3", "maj2"] as Rule[]) {
    console.log(`${name} ${rule}: ` + s[rule].map((g) => `t=${g.t.toFixed(2)} R${short(g.recall)} P${short(g.precision)} dFP${short(g.decoyFpRate)} cov${short(g.coverage)} err${g.errors} sil${g.silentMisses}`).join(" | "));
  }
};
sw("overall", report.sweep.overall);
sw("touched", report.sweep.touchedOnly);
for (const p of PRED) sw(p, report.sweep.byPredicate[p]);
console.log(`\n== recommended defaults`);
for (const [k, r] of Object.entries(report.recommended)) console.log(`${k.padEnd(12)} all3 ${r.all3 ? `t=${r.all3.t} cov ${short(r.all3.coverage)} R ${short(r.all3.recall)}` : "none"} | maj2 ${r.maj2 ? `t=${r.maj2.t} cov ${short(r.maj2.coverage)} R ${short(r.maj2.recall)}` : "none"} | choice ${typeof r.choice === "string" ? r.choice : `${r.choice.rule} t=${r.choice.t} cov ${pc(r.choice.coverage)} R ${pc(r.choice.recall)} risk-hi ${r.choice.riskUpperBound}`}`);
console.log(`\nlatency ${JSON.stringify(report.latency)}`);
console.log(`truncation ${JSON.stringify(report.truncation)}`);
