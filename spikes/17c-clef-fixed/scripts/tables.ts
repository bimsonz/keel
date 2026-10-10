// Renders the markdown tables in docs/spikes/17c-clef-fixed.md from
// results/eval-report.json (written by analyze.ts).
//   node scripts/tables.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS } from "./client.ts";

type W = { k: number; n: number; p: number | null; lo: number | null; hi: number | null };
type G = { t: number; precision: W; recall: W; decoyFpRate: W; coverage: W; escalated: W; errors: number; silentMisses: number; falseFlags: string[] };
const r = JSON.parse(readFileSync(join(RESULTS, "eval-report.json"), "utf8"));
const pct = (w: W) => (w.p === null ? "—" : `${(w.p * 100).toFixed(1)}%`);
const ci = (w: W) => (w.p === null ? "— (0/0)" : `${(w.p * 100).toFixed(1)}% (${w.k}/${w.n}) [${(w.lo! * 100).toFixed(1)}–${(w.hi! * 100).toFixed(1)}]`);

function sweepTable(title: string, sw: Record<string, G[]>) {
  console.log(`\n#### ${title}\n`);
  console.log("| t | rule | Precision | Recall | Decoy FP | Coverage | Escalated | Errors (FP / silent) |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (let k = 0; k < sw.all3.length; k++) {
    for (const rule of ["all3", "maj2"]) {
      const g = sw[rule][k];
      console.log(`| ${g.t.toFixed(2)} | ${rule === "all3" ? "all 3" : "2 of 3"} | ${ci(g.precision)} | ${ci(g.recall)} | ${ci(g.decoyFpRate)} | ${ci(g.coverage)} | ${pct(g.escalated)} | ${g.errors} (${g.falseFlags.length} / ${g.silentMisses}) |`);
    }
  }
}

function compact(title: string, sw: Record<string, G[]>) {
  console.log(`\n#### ${title} (compact: recall / decoy FP / coverage, errors)\n`);
  console.log(`| rule | ${sw.all3.map((g) => g.t.toFixed(2)).join(" | ")} |`);
  console.log(`|---|${sw.all3.map(() => "---").join("|")}|`);
  for (const rule of ["all3", "maj2"]) console.log(`| ${rule === "all3" ? "all 3" : "2 of 3"} | ${sw[rule].map((g) => `${pct(g.recall)} / ${pct(g.decoyFpRate)} / ${pct(g.coverage)}${g.errors ? `, **${g.errors}**` : ""}`).join(" | ")} |`);
}

console.log("### Ablation");
console.log("\n| Run | Agreement | Recall | Precision | Decoy FP | Coverage | False flags |");
console.log("|---|---|---|---|---|---|---|");
for (const [m, a] of Object.entries(r.ablation) as [string, { label: string; overall: { relabelledAgreement: W; gate: { recall: W; precision: W; decoyFpRate: W; coverage: W; falseFlags: string[] } } }][]) {
  const o = a.overall;
  console.log(`| ${a.label} (\`${m}\`) | ${ci(o.relabelledAgreement)} | ${ci(o.gate.recall)} | ${ci(o.gate.precision)} | ${ci(o.gate.decoyFpRate)} | ${ci(o.gate.coverage)} | ${o.gate.falseFlags.join(", ")} |`);
}

console.log("\n### By source, per run (agreement / recall / decoy FP)\n");
console.log("| Source | " + Object.keys(r.ablation).join(" | ") + " |");
console.log("|---|" + Object.keys(r.ablation).map(() => "---").join("|") + "|");
for (const s of ["s17", "forge-lite", "synthetic"]) {
  console.log(`| ${s} | ${Object.values(r.ablation).map((a) => { const b = (a as { bySource: Record<string, { relabelledAgreement: W; gate: { recall: W; decoyFpRate: W } }> }).bySource[s]; return `${ci(b.relabelledAgreement)} / ${pct(b.gate.recall)} / ${pct(b.gate.decoyFpRate)}`; }).join(" | ")} |`);
}

console.log("\n### Headline by predicate (main)\n");
console.log("| Predicate | n | Agreement | Recall | Precision | Decoy FP | Coverage |");
console.log("|---|---|---|---|---|---|---|");
for (const [p, s] of Object.entries(r.byPredicate) as [string, { n: number; relabelledAgreement: W; gate: { recall: W; precision: W; decoyFpRate: W; coverage: W } }][]) {
  console.log(`| ${p} | ${s.n} | ${ci(s.relabelledAgreement)} | ${ci(s.gate.recall)} | ${pct(s.gate.precision)} | ${ci(s.gate.decoyFpRate)} | ${pct(s.gate.coverage)} |`);
}

console.log("\n### Position (per run)\n");
console.log("| Run | Accuracy by slot 1/2/3 | Slot agrees with majority 1/2/3 | Odd one out by slot 1/2/3 | Odd one out by relabelling v0/v1/v2 | Agreement by rotation group (v0 / v1 / v2 first) |");
console.log("|---|---|---|---|---|---|");
for (const [m, a] of Object.entries(r.ablation) as [string, { position: { slotAccuracy: W[]; slotAgreesWithMajority: W[]; oddOneOutBySlot: number[]; oddOneOutByVariant: number[]; agreementByRotation: W[] } }][]) {
  const q = a.position;
  console.log(`| \`${m}\` | ${q.slotAccuracy.map(pct).join(" / ")} | ${q.slotAgreesWithMajority.map(pct).join(" / ")} | ${q.oddOneOutBySlot.join(" / ")} | ${q.oddOneOutByVariant.join(" / ")} | ${q.agreementByRotation.map(ci).join(" · ")} |`);
}

console.log("\n### Threshold sweep");
sweepTable("Overall (242 items)", r.sweep.overall);
for (const p of ["consistency", "ordering", "cardinality"]) sweepTable(`${p} (${r.byPredicate[p].n} items)`, r.sweep.byPredicate[p]);
for (const p of ["freshness", "presence", "authority", "purity", "bound", "shape"]) compact(`${p} (${r.byPredicate[p].n} items)`, r.sweep.byPredicate[p]);
compact("S17b's run, no fix, overall", r.sweep.s17bOverall);
compact("Touched anchors only (201 items)", r.sweep.touchedOnly);
for (const s of ["s17", "forge-lite", "synthetic"]) compact(`source ${s}`, r.sweep.bySource[s]);

console.log("\n### Recommended defaults\n");
console.log("| Scope | Lowest error-free t, all 3 (coverage) | Lowest error-free t, 2 of 3 (coverage) | Recommended | Coverage | Recall | Decided-error upper bound |");
console.log("|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(r.recommended) as [string, { all3: { t: number; coverage: W } | null; maj2: { t: number; coverage: W } | null; choice: string | { rule: string; t: number; coverage: W; recall: W; riskUpperBound: number } }][]) {
  const c = v.choice;
  console.log(`| ${k} | ${v.all3 ? `${v.all3.t.toFixed(2)} (${pct(v.all3.coverage)})` : "none"} | ${v.maj2 ? `${v.maj2.t.toFixed(2)} (${pct(v.maj2.coverage)})` : "none"} | ${typeof c === "string" ? c : `**${c.rule === "all3" ? "all 3" : "2 of 3"} ≥ ${c.t.toFixed(2)}**`} | ${typeof c === "string" ? "—" : ci(c.coverage)} | ${typeof c === "string" ? "—" : ci(c.recall)} | ${typeof c === "string" ? "—" : `${(c.riskUpperBound * 100).toFixed(1)}%`} |`);
}
