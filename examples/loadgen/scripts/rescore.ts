// Scores earlier runs again with the scorer in force, from Keel's record of
// the project, and writes runs/<run>.rescore.json beside each: the score the
// run was given, the score now, and the scorer's blobs. A run's own file is
// never rewritten.
//
//   node examples/loadgen/scripts/rescore.ts lg5a lg5b … [--keel https://keel.town]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { KeelClient, signerFromJwk } from "@keeltown/sdk";
import { score } from "../src/bench.ts";
import type { PairKey } from "../src/plan.ts";
import { ties, type KeelEvent } from "../src/report.ts";

const { values, positionals } = parseArgs({
  options: { keel: { type: "string", default: "https://keel.town" } },
  allowPositionals: true,
});
const runs = join(import.meta.dirname, "..", "runs");
const isKey = (x: unknown): x is PairKey[] => Array.isArray(x);
const pct = (x: unknown) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "–");
const blob = (file: string) =>
  execFileSync("git", ["hash-object", join(import.meta.dirname, "..", "src", file)], {
    encoding: "utf8",
  }).trim();
const scorer = { "report.ts": blob("report.ts"), "bench.ts": blob("bench.ts") };

const held: unknown = JSON.parse(
  readFileSync(join(homedir(), ".keel", "loadgen-agent.json"), "utf8"),
);
const agentId: unknown = Reflect.get(Object(held), "agentId");
if (typeof agentId !== "string") throw new Error("no loadgen account on this machine");
const key = await signerFromJwk(Reflect.get(Object(held), "privateJwk"));

for (const run of positionals) {
  const written: unknown = JSON.parse(readFileSync(join(runs, `${run}.json`), "utf8"));
  const sealed: unknown = JSON.parse(readFileSync(join(runs, `${run}.key.json`), "utf8"));
  const project: unknown = Reflect.get(Object(written), "projectId");
  const agents: unknown = Reflect.get(Object(written), "agents");
  const pairs: unknown = Reflect.get(Object(sealed), "pairs");
  if (typeof project !== "string" || !Array.isArray(agents) || !Array.isArray(pairs))
    throw new Error(`${run}'s files are not a run and its key`);
  const changeOf = new Map<number, string>();
  for (const a of agents) {
    const index: unknown = Reflect.get(Object(a), "index");
    const changeId: unknown = Reflect.get(Object(a), "changeId");
    if (typeof index === "number" && typeof changeId === "string") changeOf.set(index, changeId);
  }
  const reader = new KeelClient({
    baseUrl: values.keel,
    agentId,
    key,
    project,
    run: `lg-${run}-rescore`,
  });
  const events: KeelEvent[] = [];
  for (let cursor: string | undefined; ;) {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const page = await reader.events({
      project,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    events.push(...page.items.filter((e) => e.project === project));
    if (page.items.length === 0 || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  if (!isKey(pairs)) throw new Error("not a key");
  const now = score(pairs, (i) => changeOf.get(i), ties(events));
  const before: unknown = Reflect.get(Object(written), "bench");
  writeFileSync(
    join(runs, `${run}.rescore.json`),
    `${JSON.stringify({ run, scorer, rescoredAt: new Date().toISOString(), before, now }, null, 2)}\n`,
  );
  console.log(
    `${run}: recall ${pct(Reflect.get(Object(before), "recall"))} → ${pct(now.recall)}, decoy false positives ${pct(Reflect.get(Object(before), "falsePositiveRate"))} → ${pct(now.falsePositiveRate)}`,
  );
}
