// A run's live event chain, read from the seed user's feed: pnpm e2e:chain [env] <cursor> [project]
//
// Prints every event after `cursor` (the feed position S-0 prints when it
// starts) in one project, oldest first, one line each with the fields a reader
// needs to follow a change from declare to landing or bounce. With no project,
// forge-lite. The chain goes to stdout; pipe it beside the run's record.
import { execFileSync } from "node:child_process";
import { readSeeded, userClient } from "./lib/seeded.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const [environment = "staging", cursor, projectName = "forge-lite"] = process.argv.slice(2);
if (cursor === undefined) {
  console.error("usage: pnpm e2e:chain [env] <cursor> [project]");
  process.exit(2);
}
const seeded = readSeeded(root, environment);
const projectId = seeded.projects[projectName]?.id;
if (projectId === undefined) throw new Error(`no seeded project ${projectName}`);
const reader = userClient(seeded.keelUrl, seeded.seedUser);

/** The fields of a payload worth a line: ids, outcomes and shas, short. */
function brief(payload: Readonly<Record<string, unknown>>): string {
  const keep = [
    "changeId",
    "batchId",
    "candidateId",
    "verdictId",
    "outcome",
    "reason",
    "verified",
    "from",
    "to",
    "head",
    "commitSha",
    "base",
  ];
  const parts = keep.flatMap((key) => {
    const value = payload[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return [];
    const text = String(value);
    return [`${key}=${/^[0-9a-f]{40}$/.test(text) ? text.slice(0, 12) : text}`];
  });
  const landings = payload["landings"];
  if (Array.isArray(landings))
    parts.push(
      `landings=[${landings
        .map(
          (l: { changeId?: string; commitSha?: string }) =>
            `${l.changeId ?? "?"}@${(l.commitSha ?? "").slice(0, 12)}`,
        )
        .join(", ")}]`,
    );
  const members = payload["members"];
  if (Array.isArray(members) && members.every((m) => typeof m === "string"))
    parts.push(`members=[${members.join(", ")}]`);
  return parts.join(" ");
}

let page = await reader.events({ cursor, limit: 500 });
let count = 0;
while (page.items.length > 0) {
  for (const event of page.items) {
    if (event.project !== projectId) continue;
    count += 1;
    const payload: Readonly<Record<string, unknown>> = event.payload;
    console.log(
      `${event.at}  ${event.label ?? ""}\t${event.payload._tag.padEnd(20)} ${brief(payload)}`,
    );
  }
  page = await reader.events({ cursor: page.nextCursor, limit: 500 });
}
console.log(`${count} events in ${projectName} (${projectId}) after ${cursor}`);
