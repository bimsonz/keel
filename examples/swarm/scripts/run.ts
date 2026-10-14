// Runs the swarm once and writes its report: starts the run, follows it until
// every worker's change has ended (or --minutes pass, when it stops the run),
// and writes the run's numbers to examples/swarm/runs/<run>.json, all from
// Keel's own record of the project.
//
//   SWARM_URL=… SWARM_ADMIN_TOKEN=… node examples/swarm/scripts/run.ts \
//     --shape one --workers 5 --seed 42 --project prj_… [--minutes 30]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type * as v from "valibot";
import { table } from "../src/run/report.ts";
import { Anything, RunReport, Started, swarmAdmin } from "./admin.ts";

const { values } = parseArgs({
  options: {
    shape: { type: "string" },
    workers: { type: "string" },
    seed: { type: "string", default: "42" },
    project: { type: "string" },
    minutes: { type: "string", default: "30" },
  },
});
if (values.shape !== "one" && values.shape !== "many") throw new Error("--shape is one or many");
if (values.project === undefined || values.workers === undefined)
  throw new Error("--project and --workers are required");
const admin = swarmAdmin();

const ENDED = new Set(["landed", "withdrawn", "superseded", "parked"]);
const started = await admin(Started, "POST", "/admin/runs", {
  shape: values.shape,
  workers: Number(values.workers),
  seed: Number(values.seed),
  project: values.project,
});
console.log(
  `run ${started.id}: ${values.workers} workers, shape ${values.shape}, seed ${values.seed}`,
);
const deadline = Date.now() + Number(values.minutes) * 60_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function follow(): Promise<v.InferOutput<typeof RunReport>> {
  const now = await admin(RunReport, "GET", "/admin/run");
  const { report } = now;
  console.log(
    `${new Date().toISOString().slice(11, 19)} dispatched ${now.run.dispatched}/${now.run.workers}, declared ${report.declared}, landed ${report.landed}, bounces ${report.bounces}, model calls ${now.run.modelCalls}`,
  );
  const done =
    now.run.dispatched >= now.run.workers && now.records.every((r) => ENDED.has(r.outcome));
  if (done || Date.now() > deadline) return now;
  await pause(30_000);
  return follow();
}

const last = await follow();
const finished =
  last.run.dispatched >= last.run.workers && last.records.every((r) => ENDED.has(r.outcome));
await admin(Anything, "POST", "/admin/run/stop");
const final = await admin(RunReport, "GET", "/admin/run");
const dir = join(import.meta.dirname, "..", "runs");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `${final.run.id}.json`),
  `${JSON.stringify({ shape: values.shape, seed: Number(values.seed), endedAt: new Date().toISOString(), timedOut: !finished, ...final }, null, 2)}\n`,
);
console.log(
  `\n${table([{ title: `${values.shape} × ${final.run.workers}`, report: final.report }])}`,
);
