// Puts runs side by side: one column a run, from the files run.ts wrote.
//
//   node examples/swarm/scripts/report.ts examples/swarm/runs/<run>.json …
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { table } from "../src/run/report.ts";
import { RunReport } from "./admin.ts";

const Written = v.looseObject({
  ...RunReport.entries,
  shape: v.picklist(["one", "many"]),
  timedOut: v.boolean(),
});
const SHAPE = { one: "(a) one account", many: "(b) an account each" } as const;

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("name the runs' files: examples/swarm/runs/<run>.json …");
const runs = files.map((file) => v.parse(Written, JSON.parse(readFileSync(file, "utf8"))));
console.log(
  table(
    runs.map((r) => ({
      title: `${SHAPE[r.shape]} × ${r.run.workers}${r.timedOut ? " (timed out)" : ""}`,
      report: r.report,
    })),
  ),
);
