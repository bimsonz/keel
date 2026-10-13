// Sets the console's fold of a project's log beside Keel's own reads of its
// conflicts, one conflict at a time, and says where the two differ. The
// console draws a conflict's page from its fold of the log; Keel answers the
// same conflict from its own fold of the same events. They are to agree.
//
//   node scripts/level.ts <origin> <namespace> <project>
//
// It reads only, as a visitor: the project must be public. Exit 1 where a
// conflict differs, or where Keel names one the fold does not hold.

import type { ConflictDetail, ConflictPage } from "../src/contract/keel/index.ts";
import { conflictDetailOf } from "../src/engine/conflict.ts";
import { World } from "../src/engine/world.ts";
import { createHttpDirectory, createHttpSource } from "../src/source/http.ts";

const [origin = "", namespace = "", name = ""] = process.argv.slice(2);
if (origin === "" || namespace === "" || name === "") {
  console.error("usage: node scripts/level.ts <origin> <namespace> <project>");
  process.exit(2);
}

/** Every path at which two answers differ, with what each holds there. */
function differences(mine: unknown, keels: unknown, at = ""): string[] {
  if (Object.is(mine, keels)) return [];
  const both = [mine, keels];
  if (both.every((side) => Array.isArray(side)) || both.every(isRecord)) {
    const [a, b] = [mine, keels].map((side) => (isRecord(side) ? side : {}));
    return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].flatMap((key) =>
      differences(a?.[key], b?.[key], at === "" ? key : `${at}.${key}`),
    );
  }
  return [`${at}: the fold has ${JSON.stringify(mine)}, Keel has ${JSON.stringify(keels)}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const project = await createHttpDirectory({ origin }).findProject(namespace, name);
if (project === null) {
  console.error(`Keel shows a visitor no project ${namespace}/${name}`);
  process.exit(1);
}
const source = createHttpSource(project, { origin });

// The whole log, from its beginning, as the page reads it.
const world = new World();
let cursor: string | undefined;
let read = 0;
let epoch: number | undefined;
for (;;) {
  // oxlint-disable-next-line no-await-in-loop -- a page names the next one
  const page = await source.readEvents(cursor === undefined ? {} : { cursor });
  for (const event of page.items) {
    epoch ??= Date.parse(event.at);
    world.apply(event, Date.parse(event.at) - epoch);
  }
  read += page.items.length;
  // A stretch of the log that holds none of this project's entries is an empty page whose cursor has moved on.
  if (page.nextCursor === cursor) break;
  cursor = page.nextCursor;
}
console.log(
  `${namespace}/${name} (${project.id}): ${read} events folded, ${world.conflicts.size} conflicts`,
);

const get = async <Body>(path: string): Promise<Body> => {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  const body: Body = await response.json();
  return body;
};

const listed = await get<ConflictPage>(
  `/v1/conflicts?project=${encodeURIComponent(project.id)}&limit=100`,
);
console.log(
  `Keel lists ${listed.items.length}: ${listed.totals.open} open, ${listed.totals.settled} settled`,
);

let apart = 0;
for (const row of listed.items) {
  // oxlint-disable-next-line no-await-in-loop -- one conflict at a time, so the output reads in order
  const keels = await get<ConflictDetail>(
    `/v1/conflicts/${encodeURIComponent(row.id)}?project=${encodeURIComponent(project.id)}`,
  );
  const mine = conflictDetailOf(world, row.id);
  const found = mine === null ? ["the fold holds no such conflict"] : differences(mine, keels);
  apart += found.length;
  console.log(`${row.label} ${row.id} ${row.state}: ${found.length === 0 ? "level" : "APART"}`);
  for (const line of found) console.log(`  ${line}`);
}
for (const id of world.conflicts.keys()) {
  if (listed.items.some((row) => row.id === id)) continue;
  apart += 1;
  console.log(`${id}: the fold holds it, and Keel's list does not`);
}
process.exit(apart === 0 ? 0 : 1);
