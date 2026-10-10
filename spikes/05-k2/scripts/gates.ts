// Pass/fail gates over the saved results.
//
//   node scripts/gates.ts [--produce-p99-ms 2000] [--consume-rps 2000]
//
// produce: every results/produce-*.json run named in PRODUCE_RUNS must have
//          call-latency p99 < --produce-p99-ms.
// consume: each drain in CONSUME_RUNS (results/consume-<name>.json, a nudged Projector
//          draining a 30k backlog) must show recordsPerSec >= --consume-rps, and the
//          live checker must have found no dup/regress/gap.
// Exits 1 if any gate fails. Run with --produce-p99-ms 1 to see the gate go red.
import { existsSync, readFileSync } from "node:fs";
import { arg, results } from "./lib.ts";

const PRODUCE_RUNS = ["seq1k", "single10k", "b100", "b1000", "b100x10", "backlog-b1000", "backlog-b100x10", "lag"];
const CONSUME_RUNS = ["drain", "drain10k"];
const p99Max = Number(arg("produce-p99-ms", "2000"));
const rpsMin = Number(arg("consume-rps", "2000"));

let failed = 0;
for (const run of PRODUCE_RUNS) {
  const f = new URL(`produce-${run}.json`, results);
  if (!existsSync(f)) {
    console.log(`UNTESTED produce ${run}: no results file`);
    continue;
  }
  const d = JSON.parse(readFileSync(f, "utf8")) as { records: number; callLatencyMs: { n: number; p99: number } };
  const ok = d.callLatencyMs.p99 < p99Max;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} produce ${run.padEnd(9)} p99 ${d.callLatencyMs.p99} ms < ${p99Max} ms (n=${d.callLatencyMs.n} calls, ${d.records} records)`);
}

for (const name of CONSUME_RUNS) {
  const f = new URL(`consume-${name}.json`, results);
  if (!existsSync(f)) {
    console.log(`UNTESTED consume ${name}: no results file`);
    continue;
  }
  const d = JSON.parse(readFileSync(f, "utf8")) as { stats: { records: number; recordsPerSec: number; cfg: { maxRecords: number }; findings: Record<string, number> } };
  const okRate = d.stats.recordsPerSec >= rpsMin;
  const clean = Object.keys(d.stats.findings).length === 0;
  if (!okRate || !clean) failed++;
  console.log(
    `${okRate && clean ? "PASS" : "FAIL"} consume ${name.padEnd(9)} ${d.stats.recordsPerSec} records/s >= ${rpsMin} (max_records ${d.stats.cfg.maxRecords}, ${d.stats.records} records); order/dup findings ${JSON.stringify(d.stats.findings)}`,
  );
}
// The live-lag run is paced by its producer, so only its order/dup findings are gated.
const lag = new URL("consume-lag.json", results);
if (existsSync(lag)) {
  const d = JSON.parse(readFileSync(lag, "utf8")) as { stats: { records: number; uniqueIds: number; findings: Record<string, number> } };
  const clean = Object.keys(d.stats.findings).length === 0;
  if (!clean) failed++;
  console.log(`${clean ? "PASS" : "FAIL"} consume lag       order/dup findings ${JSON.stringify(d.stats.findings)} (${d.stats.records} records, ${d.stats.uniqueIds} unique)`);
} else console.log("UNTESTED consume lag: no results file");
process.exit(failed ? 1 : 0);
