// Scores a swarm run from Keel's own public record of its project: the planted
// pairs against the sealed key, by loadgen's scorer, unchanged; and whether
// every landing came through a batch whose verification passed.
//
//   node examples/swarm/scripts/score.ts --run r… --project prj_… \
//     --key examples/swarm/runs/key-s42-w100.json [--keel https://keel.town]
//
// It reads the project's events without a token, as anyone may read a public
// project's: run it once the project is public.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { score } from "../../loadgen/src/bench.ts";
import { ties, type KeelEvent } from "../../loadgen/src/report.ts";
import { PAIR_KINDS } from "../src/run/pairs.ts";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    project: { type: "string" },
    key: { type: "string" },
    keel: { type: "string", default: "https://keel.town" },
  },
});
if (values.run === undefined || values.project === undefined)
  throw new Error("--run and --project are required");
const run = values.run;

const isEvent = (value: unknown): value is KeelEvent =>
  typeof value === "object" &&
  value !== null &&
  "at" in value &&
  "payload" in value &&
  typeof value.payload === "object" &&
  value.payload !== null &&
  "_tag" in value.payload;
const Page = v.object({ items: v.array(v.unknown()), nextCursor: v.optional(v.string()) });
const Key = v.object({
  pairs: v.array(
    v.object({
      pair: v.number(),
      kind: v.picklist(PAIR_KINDS),
      planted: v.boolean(),
      a: v.number(),
      b: v.number(),
    }),
  ),
});

async function eventsOf(keel: string, project: string): Promise<KeelEvent[]> {
  const all: KeelEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = new URL("/v1/events", keel);
    url.searchParams.set("project", project);
    url.searchParams.set("limit", "500");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    // oxlint-disable-next-line no-await-in-loop -- one page at a time, in order
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
    // oxlint-disable-next-line no-await-in-loop -- the page's body
    const page = v.parse(Page, await response.json());
    all.push(...page.items.filter(isEvent));
    if (page.items.length === 0 || page.nextCursor === undefined || page.nextCursor === cursor)
      break;
    cursor = page.nextCursor;
  }
  return all;
}

const events = await eventsOf(values.keel, values.project);
const labelOf = (e: KeelEvent): unknown =>
  Reflect.get(Object(Reflect.get(e.payload, "run")), "label");
/** Each worker's first change: the worker is the label's `<run>-<index>`. */
const firstChange = new Map<number, string>();
for (const e of events) {
  if (e.payload._tag !== "IntentDeclared") continue;
  const label = labelOf(e);
  if (typeof label !== "string" || !label.startsWith(`${run}-`)) continue;
  const index = Number(label.slice(run.length + 1));
  if (Number.isInteger(index) && !firstChange.has(index))
    firstChange.set(index, e.payload.changeId);
}
const ours = new Set(firstChange.values());

// Every landing of the run's changes, and the verdict on the batch that carried it.
const verdicts = new Map<string, { outcome: string; evidence: readonly string[] }>();
for (const e of events)
  if (e.payload._tag === "VerdictIssued")
    verdicts.set(e.payload.subject, { outcome: e.payload.outcome, evidence: e.payload.evidence });
let landed = 0;
const unverified: string[] = [];
for (const e of events) {
  if (e.payload._tag !== "TrunkAdvanced") continue;
  const batch = e.payload.groupId.split("@")[0] ?? "";
  for (const landing of e.payload.landings) {
    if (!ours.has(landing.changeId)) continue;
    landed += 1;
    const verdict = verdicts.get(batch);
    if (verdict?.outcome !== "land" || !verdict.evidence.some((x) => x.includes("suite: pass")))
      unverified.push(`${landing.changeId} (batch ${batch}: ${verdict?.outcome ?? "no verdict"})`);
  }
}
console.log(
  `${run}: ${firstChange.size} workers declared, ${landed} of their changes landed; ${landed - unverified.length} through a batch whose suite passed${unverified.length === 0 ? "" : `; not: ${unverified.join(", ")}`}`,
);

if (values.key !== undefined) {
  const { pairs } = v.parse(Key, JSON.parse(readFileSync(values.key, "utf8")));
  const result = score(pairs, (index) => firstChange.get(index), ties(events));
  console.log(JSON.stringify(result, null, 2));
}
