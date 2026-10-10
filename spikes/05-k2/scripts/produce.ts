// Drive the LogProducer DO: produce --count records in --chunk-sized requests, either
// one record per send() (--mode single) or --batch records per send() (--mode batch).
// Writes results/produce-<run>.json with per-call latency percentiles and throughput.
//
//   node scripts/produce.ts --run single --mode single --count 10000 --chunk 2000
//   node scripts/produce.ts --run b100 --mode batch --batch 100 --count 10000 --chunk 10000
//   node scripts/produce.ts --run hint-enam --producer p-enam --hint enam --mode single --count 30
// --lanes n runs n concurrent in-order senders, each owning its own entities.
// --producer names the DO (default p); its entities are prefixed with it unless it is p.
import { arg, call, save } from "./lib.ts";
import { summarise } from "../src/check.ts";

type Chunk = { records: number; calls: number; bytes: number; wallMs: number; lat: number[]; errors: unknown[]; colo: string; nudge: unknown };

const run = arg("run");
const mode = arg("mode") as "single" | "batch";
const count = Number(arg("count"));
const chunk = Number(arg("chunk", String(count)));
const batchSize = Number(arg("batch", "1"));
const nudge = process.argv.includes("--nudge") ? arg("nudge") : undefined;
const gapMs = Number(arg("gap", "0"));
const lanes = Number(arg("lanes", "1"));
const producer = arg("producer", "p");
const hint = process.argv.includes("--hint") ? arg("hint") : undefined;
const ns = producer === "p" ? undefined : producer;
const qs = `?producer=${producer}${hint ? `&hint=${hint}` : ""}`;

const lat: number[] = [];
const errors: unknown[] = [];
const colos = new Set<string>();
let records = 0;
let calls = 0;
let bytes = 0;
let doWallMs = 0;
const t0 = performance.now();
const startedAt = Date.now();
while (records < count) {
  const n = Math.min(chunk, count - records);
  const r = await call<Chunk>(`/produce${qs}`, { body: { run, mode, count: n, batchSize, nudge, gapMs, lanes, ns } });
  if (r.status !== 200) throw new Error(`produce ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}`);
  lat.push(...r.body.lat);
  errors.push(...r.body.errors);
  colos.add(r.body.colo);
  records += r.body.records;
  calls += r.body.calls;
  bytes += r.body.bytes;
  doWallMs += r.body.wallMs;
  process.stderr.write(`${run}: ${records}/${count} (chunk p50 ${summarise(r.body.lat).p50} ms, wall ${r.body.wallMs} ms)\n`);
}
const localWallMs = Math.round(performance.now() - t0);
const out = {
  run,
  mode,
  batchSize: mode === "single" ? 1 : batchSize,
  lanes,
  producer,
  hint: hint ?? null,
  records,
  calls,
  bytes,
  avgRecordBytes: Math.round(bytes / records),
  startedAt,
  doWallMs,
  localWallMs,
  recordsPerSecInDo: Math.round((records / doWallMs) * 1000),
  callLatencyMs: summarise(lat),
  errors,
  colos: [...colos],
  lat,
};
save(`produce-${run}.json`, out);
const { lat: _omit, ...summary } = out;
console.log(JSON.stringify(summary, null, 1));
