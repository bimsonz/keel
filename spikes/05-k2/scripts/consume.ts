// Drive a Projector DO against a K2 subscription.
//
//   node scripts/consume.ts --name drain --start earliest --max 1000 [--per-alarm 1]
//        [--chaos none|shuffle|dup] [--max-batches 0] [--baseline-first] [--phase setup|wait|all]
//
// setup: create subscription keel-spike-05-<name> (through the Worker's /k2 pass-through,
//        so the consume token never leaves the Worker), reset projector <name> with the
//        config, and nudge it once (unless --no-nudge: the producer nudges instead).
// wait:  poll the projector's stats until the alarm loop has gone idle (no alarm
//        pending and at least one empty pull), the batch cap is hit, or --timeout s.
// Writes results/consume-<name>.json.
import { arg, call, save, sleep } from "./lib.ts";

const name = arg("name");
const phase = arg("phase", "all");
const start = arg("start", "earliest");
const cfg = {
  sub: "",
  workerId: arg("worker", `projector-${name}`),
  maxRecords: Number(arg("max", "1000")),
  batchesPerAlarm: Number(arg("per-alarm", "1")),
  chaos: arg("chaos", "none") as "none" | "shuffle" | "dup",
  maxBatches: Number(arg("max-batches", "0")),
  baselineFromFirst: process.argv.includes("--baseline-first"),
};
const timeoutS = Number(arg("timeout", "900"));
const subName = `keel-spike-05-${name}`;

type Stats = {
  alarmPending: number | null;
  counters: { empty: number; alarms: number; nudges: number; armed: number };
  batches: number;
  records: number;
  recordsPerSec: number;
  events: { kind: string }[];
};

let created: unknown = null;
if (phase === "setup" || phase === "all") {
  const r = await call<{ success: boolean; result: { id: string } }>("/k2/subscriptions", { body: { name: subName, start_at: { type: start } } });
  if (r.status !== 200 || !r.body.success) throw new Error(`create subscription ${r.status}: ${JSON.stringify(r.body)}`);
  created = { status: r.status, ms: Math.round(r.ms), k2Ms: Number(r.headers.get("x-k2-ms")), body: r.body };
  cfg.sub = r.body.result.id;
  const reset = await call(`/projector/${name}/reset`, { body: cfg });
  if (reset.status !== 200) throw new Error(`reset ${reset.status}`);
  save(`consume-${name}.setup.json`, { subName, start, created, cfg, at: Date.now() });
  if (!process.argv.includes("--no-nudge")) await call(`/projector/${name}/nudge`, { method: "POST" });
  console.error(`${name}: subscription ${subName} created (${start}), projector reset${process.argv.includes("--no-nudge") ? "" : " and nudged"}`);
}

if (phase === "wait" || phase === "all") {
  const t0 = Date.now();
  let s: Stats | undefined;
  for (;;) {
    await sleep(2000);
    s = (await call<Stats>(`/projector/${name}/stats`)).body;
    process.stderr.write(`${name}: ${s.records} records in ${s.batches} batches, ${s.recordsPerSec} rec/s, alarms ${s.counters.alarms}, empty ${s.counters.empty}, pending ${s.alarmPending ? "yes" : "no"}\n`);
    const idle = s.alarmPending === null && s.counters.empty > 0;
    const capped = cfg.maxBatches > 0 && s.batches >= cfg.maxBatches && s.alarmPending === null;
    const stuck = s.alarmPending === null && s.events.some((e) => e.kind.endsWith("error"));
    if (idle || capped || stuck || Date.now() - t0 > timeoutS * 1000) break;
  }
  save(`consume-${name}.json`, { subName, start, stats: s, waitedMs: Date.now() - t0 });
  console.log(JSON.stringify(s, null, 1));
}
