// S-0 against a deployed Keel: pnpm e2e:s0 [env] [--control]
//
//   (a) Two agents change disjoint files at once: both land, and trunk moves
//       twice, through verified candidates.
//   (b) Both agents change the same line: one lands, the other bounces with
//       next actions, and its inbox tells it so.
//   (c) A change that turns the fixture's tests red bounces, and trunk never
//       holds it: no advance in the run is unverified.
//
// `--control` runs (c) alone in forge-lite-control, whose verification is off
// (ProjectSettings.verification, set by the seed). There the red change lands,
// so the run must exit non-zero: it is S-0's negative control, and a green
// control run would mean S-0 cannot fail.
//
// Credentials come from `.keel/<env>.json` (scripts/seed.ts); KEEL_URL
// overrides the URL it holds. Only the SDK and system git touch Keel (R9).
// The run's record is written to `.keel/runs/<run>/s0.json`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type KeelClient, KeelProblem } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush } from "./lib/git.ts";
import { clientFor, readSeeded } from "./lib/seeded.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const environment = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "staging";
const control = process.argv.includes("--control");
const run = new Date().toISOString().replace(/[:.]/g, "-");
/** How long a change may take to land or bounce: Tier 2 runs forge-lite's whole suite. */
const SETTLE_MS = Number(process.env["S0_SETTLE_MS"] ?? 15 * 60_000);
const TERMINAL = new Set(["landed", "bounced", "withdrawn", "superseded", "parked"]);

const seeded = readSeeded(root, environment);
const observer = clientFor(seeded.keelUrl, seeded.observer);

const record: { run: string; environment: string; control: boolean; checks: unknown[] } = {
  run,
  environment,
  control,
  checks: [],
};
let failures = 0;
function check(ok: boolean, what: string, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  record.checks.push({ ok, what, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures += 1;
}

interface Work {
  readonly goal: string;
  readonly path: string;
  readonly op: "create" | "edit";
  readonly edit: (dir: string) => void;
}

interface Submitted {
  readonly agent: string;
  readonly client: KeelClient;
  readonly changeId: string;
  readonly commitSha: string;
}

/** Declare, clone the workspace, make the edit, push it and submit it, as an agent's harness would. */
async function work(client: KeelClient, agent: string, task: Work): Promise<Submitted> {
  const key = `s0:${run}:${agent}:${task.path}`;
  const declared = await client.declare(
    { goal: task.goal, footprint: [{ path: task.path, op: task.op }], premises: [] },
    { idempotencyKey: key },
  );
  const { change, workspace, lease } = declared.result;
  if (workspace.token === undefined)
    throw new Error(`${agent}: declare answered no workspace token`);
  const dir = cloneWorkspace(workspace.remote, workspace.token);
  try {
    task.edit(dir);
    const commitSha = commitAndPush(dir, workspace.token, agent, task.goal);
    await client.submit(
      { changeId: change.id, commitSha },
      { lease: lease.id, idempotencyKey: `${key}:submit` },
    );
    console.log(`     ${agent} submitted ${change.id} at ${commitSha.slice(0, 12)}`);
    return { agent, client, changeId: change.id, commitSha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The change's state once it lands or bounces, or as it stands at the deadline. */
async function settle(submitted: Submitted): Promise<string> {
  const deadline = Date.now() + SETTLE_MS;
  let state = "submitted";
  while (Date.now() < deadline) {
    const status = await submitted.client.status(submitted.changeId, { wait: 30 });
    state = status.result.state;
    if (TERMINAL.has(state)) break;
  }
  console.log(`     ${submitted.agent}'s ${submitted.changeId} is ${state}`);
  return state;
}

type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];

/** The end of the feed: the cursor from which this run's events are read. */
async function feedHead(): Promise<string> {
  let page = await observer.events({ limit: 500 });
  while (page.items.length > 0)
    page = await observer.events({ cursor: page.nextCursor, limit: 500 });
  return page.nextCursor;
}

async function feedSince(cursor: string): Promise<EventRecord[]> {
  const events: EventRecord[] = [];
  let page = await observer.events({ cursor, limit: 500 });
  while (page.items.length > 0) {
    events.push(...page.items);
    page = await observer.events({ cursor: page.nextCursor, limit: 500 });
  }
  return events;
}

const advancesOf = (events: readonly EventRecord[], projectId: string) =>
  events.flatMap((e) =>
    e.project === projectId && e.payload._tag === "TrunkAdvanced" ? [e.payload] : [],
  );

type Advance = ReturnType<typeof advancesOf>[number];

/** The changes an advance landed, from its landing records. */
const landedIn = (advance: Advance): readonly string[] => advance.landings.map((l) => l.changeId);

const addFile = (agent: string): Work => ({
  goal: `Add ${agent}'s S-0 note for run ${run}`,
  path: `s0/${run}/${agent}.md`,
  op: "create",
  edit: (dir) => {
    mkdirSync(join(dir, "s0", run), { recursive: true });
    writeFileSync(join(dir, "s0", run, `${agent}.md`), `${agent} was here in S-0 run ${run}.\n`);
  },
});

/** Both agents rewrite the same line of package.json, so the second to land conflicts with the first. */
const sameLine = (agent: string): Work => ({
  goal: `Describe forge-lite as ${agent} sees it (run ${run})`,
  path: "package.json",
  op: "edit",
  edit: (dir) => {
    const path = join(dir, "package.json");
    const before = readFileSync(path, "utf8");
    const after = before.replace(
      /"description": "[^"]*",/,
      `"description": "forge-lite, as ${agent} left it in S-0 run ${run}",`,
    );
    if (after === before) throw new Error("package.json has no description line to change");
    writeFileSync(path, after);
  },
});

/** Lets a writer delete a repository: forge-lite's permission matrix then fails. */
const redChange: Work = {
  goal: `Let writers delete repositories (run ${run})`,
  path: "src/domain/permissions.ts",
  op: "edit",
  edit: (dir) => {
    const path = join(dir, "src/domain/permissions.ts");
    const before = readFileSync(path, "utf8");
    const after = before.replace(`"delete-repo": "admin",`, `"delete-repo": "write",`);
    if (after === before) throw new Error("permissions.ts no longer holds the delete-repo row");
    writeFileSync(path, after);
  },
};

function agentsOf(project: string): [KeelClient, KeelClient] {
  const agents = seeded.projects[project]?.agents ?? [];
  const [a1, a2] = agents;
  if (a1 === undefined || a2 === undefined) throw new Error(`${project} needs two seeded agents`);
  return [clientFor(seeded.keelUrl, a1), clientFor(seeded.keelUrl, a2)];
}

async function arms(): Promise<void> {
  const project = control ? "forge-lite-control" : "forge-lite";
  const projectId = seeded.projects[project]?.id ?? "";
  const [a1, a2] = agentsOf(project);
  const from = await feedHead();
  console.log(`S-0 run ${run} in ${project} (${projectId}) from feed position ${from}`);

  const landedIds: string[] = [];
  if (!control) {
    console.log("(a) disjoint changes at once");
    const disjoint = await Promise.all([
      work(a1, "a1", addFile("a1")),
      work(a2, "a2", addFile("a2")),
    ]);
    const states = await Promise.all(disjoint.map(settle));
    check(
      states.every((s) => s === "landed"),
      "(a) both disjoint changes land",
      states,
    );
    landedIds.push(...disjoint.map((d) => d.changeId));

    console.log("(b) the same line, changed by both");
    const clash = await Promise.all([
      work(a1, "a1", sameLine("a1")),
      work(a2, "a2", sameLine("a2")),
    ]);
    const clashStates = await Promise.all(clash.map(settle));
    check(
      clashStates.toSorted().join(",") === "bounced,landed",
      "(b) one same-line change lands and the other bounces",
      clashStates,
    );
    const bounced = clash[clashStates.indexOf("bounced")];
    if (bounced !== undefined) {
      const status = await bounced.client.status(bounced.changeId);
      check(
        status.next.length > 0,
        "(b) the bounced change's status carries next actions",
        status.next,
      );
      const inbox = await bounced.client.inbox();
      check(
        inbox.result.notices.some((n) =>
          `${n.ref ?? ""} ${n.title} ${n.detail ?? ""}`.includes(bounced.changeId),
        ),
        "(b) the bounced agent's inbox names its change",
        inbox.result.notices.map((n) => n.title),
      );
    }
    landedIds.push(...clash.filter((_, i) => clashStates[i] === "landed").map((c) => c.changeId));
  }

  console.log(
    `(c) a change that turns the tests red${control ? ", where verification is off" : ""}`,
  );
  const red = await work(a1, "a1", redChange);
  const redState = await settle(red);
  check(redState === "bounced", "(c) the red change bounces", redState);

  const events = await feedSince(from);
  const advances = advancesOf(events, projectId);
  check(
    !advances.some((a) => landedIn(a).includes(red.changeId)),
    "(c) trunk never holds the red change",
    advances.map((a) => ({ to: a.to, landed: landedIn(a), verified: a.verified })),
  );
  // Each member lands as its own commit in the composed chain, so the advance's head is the last of them.
  check(
    advances.every(
      (a) => a.landings.length > 0 && a.landings[a.landings.length - 1]?.commitSha === a.to,
    ),
    "every advance's head is the commit its last landing names: the landed commits are on trunk",
    advances.map((a) => ({ to: a.to, commits: a.landings.map((l) => l.commitSha) })),
  );
  check(
    advances.every((a) => a.verified !== false),
    "(c) every advance in the run was verified: the red count is 0",
  );
  if (!control) {
    const moved = landedIds.filter((id) => advances.some((a) => landedIn(a).includes(id)));
    check(
      moved.length === landedIds.length &&
        new Set(advances.map((a) => a.to)).size >= landedIds.length,
      `trunk moved once per landed change (${landedIds.length}), each through its own verified advance`,
      { landed: landedIds, advances: advances.length },
    );
  }
}

try {
  await arms();
} catch (error) {
  failures += 1;
  const what =
    error instanceof KeelProblem
      ? `${error.message} (next: ${error.nextActions.map((n) => n.title).join("; ") || "none"})`
      : error instanceof Error
        ? error.message
        : String(error);
  console.log(`FAIL ${what}`);
  record.checks.push({ ok: false, what });
} finally {
  const dir = join(root, ".keel", "runs", run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s0.json"), `${JSON.stringify({ ...record, failures }, null, 2)}\n`);
  console.log(
    `\n${failures === 0 ? "S-0 green" : `S-0 red: ${failures} failed`} (record in .keel/runs/${run}/s0.json)`,
  );
}
process.exit(failures === 0 ? 0 : 1);
