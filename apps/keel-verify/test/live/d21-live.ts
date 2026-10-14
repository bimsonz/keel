// The live check that a change verifies under the plan Precheck compiled
// for it, through the deployed Keel.
//
//   KEEL_SESSION=<token> [KEEL_ORG=<org>] node apps/keel-verify/test/live/d21-live.ts <run>
//
// KEEL_SESSION is the bearer session of a maintainer of KEEL_ORG
// (`keel` by default), which governs the project; it is read, never printed. In a project of its own (d21-live,
// forked from the seeded fixture repo), one agent declares, pushes and submits:
//   land:   a new file under src/ → Precheck compiles a plan, ChangeQueued
//           carries its hash, KeelVerify's verdict is `land` under that hash,
//           and TrunkAdvanced lands the change;
//   bounce: forge-lite's red patch (the manual clock stops) → the same chain up
//           to a `bounce` verdict under its own plan's hash, ChangeBounced, and
//           no landing. This is the arm that can fail.
// Each case is judged from the project's event feed. KeelVerify's instance is
// `keel-verify-<projectId>-<laneName>-<BatchFormed eventId>`, read back with wrangler. What is
// deployed to keel-verify is read before and after the run, and must be the
// same. Every change the run leaves open is abandoned at the end. KEEL_URL
// overrides keel.town.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneWorkspace, commitAndPush } from "../../../../e2e/src/lib/git.ts";
import { KeelClient, KeelProblem } from "../../../../packages/sdk/src/index.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const KEEL = join(ROOT, "apps/keel");
const KEEL_URL = process.env["KEEL_URL"] ?? "https://keel.town";
const FIXTURE = "fixture-forge-lite";
const PROJECT = "d21-live";
const SETTLE_MS = 10 * 60_000;

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: d21-live.ts <run>, the run a lower-case slug");
const session = process.env["KEEL_SESSION"];
if (session === undefined) throw new Error("set KEEL_SESSION to the maintainer's session");
const ORG = process.env["KEEL_ORG"] ?? "keel";

const wrangler = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: KEEL,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_userconfig: "/dev/null", WRANGLER_SEND_METRICS: "false" },
  });

/** The maintainer: it creates the project, puts its settings and enrols its agent, which it sponsors. */
function operatorClient(): KeelClient {
  return new KeelClient({ baseUrl: KEEL_URL, session: session ?? "" });
}

type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];
const tagOf = (e: EventRecord): string => e.payload._tag;
const field = (e: EventRecord, key: string): unknown => Reflect.get(e.payload, key);
/** KeelVerify's instance for a batch, as its lane names it: `keel-verify-<projectId>-<laneName>-<BatchFormed eventId>`. */
const verifyInstanceOf = (formed: EventRecord): string =>
  `keel-verify-${String(field(formed, "projectId"))}-${String(field(formed, "laneId")).split(":").at(-1) ?? ""}-${formed.eventId}`;

async function feedHead(reader: KeelClient): Promise<string> {
  let page = await reader.events({ limit: 500 });
  while (page.items.length > 0) page = await reader.events({ cursor: page.nextCursor, limit: 500 });
  return page.nextCursor;
}

/**
 * The feed's events about `changeId` from `cursor`: its own, its batches'
 * (BatchFormed and BatchVerified name it a member; a VerdictIssued names one of
 * its batches), and a TrunkAdvanced that lands it. Read until `done` holds.
 */
async function eventsOf(
  reader: KeelClient,
  cursor: string,
  changeId: string,
  done: (events: readonly EventRecord[]) => boolean,
): Promise<EventRecord[]> {
  const seen: EventRecord[] = [];
  const batches = new Set<string>();
  const about = (e: EventRecord): boolean => {
    if (field(e, "changeId") === changeId) return true;
    const members = field(e, "members");
    if (Array.isArray(members) && members.includes(changeId)) {
      const batchId = field(e, "batchId");
      if (typeof batchId === "string") batches.add(batchId);
      return true;
    }
    const subject = field(e, "subject");
    if (tagOf(e) === "VerdictIssued" && (subject === changeId || batches.has(String(subject))))
      return true;
    const landings = field(e, "landings");
    return (
      Array.isArray(landings) &&
      landings.some((l: unknown) => Reflect.get(Object(l), "changeId") === changeId)
    );
  };
  const deadline = Date.now() + SETTLE_MS;
  let at = cursor;
  while (Date.now() < deadline && !done(seen)) {
    const page = await reader.events({ cursor: at, limit: 500, wait: 20 });
    at = page.nextCursor;
    seen.push(...page.items.filter(about));
  }
  // The feed is in projection order, not causal order: one more page picks up a straggler.
  const last = await reader.events({ cursor: at, limit: 500, wait: 5 });
  seen.push(...last.items.filter(about));
  return seen;
}

/** Declares, waiting out a pool that is still forking (a new project's) under the same key. */
async function declareWhenPooled(
  client: KeelClient,
  intent: Parameters<KeelClient["declare"]>[0],
  idempotencyKey: string,
): Promise<Awaited<ReturnType<KeelClient["declare"]>>> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    try {
      return await client.declare(intent, { idempotencyKey });
    } catch (error) {
      if (
        !(error instanceof KeelProblem) ||
        error.code !== "workspace.pool_exhausted" ||
        Date.now() > deadline
      )
        throw error;
      console.log(`     pool still forking; retrying in ${error.retryAfterMs ?? 5_000} ms`);
      await new Promise((r) => setTimeout(r, error.retryAfterMs ?? 5_000));
    }
  }
}

/** A Workflow step's name as the API reports it. */
const stepName = (s: unknown) => String(Reflect.get(Object(s), "name") ?? "?");

function describeVerify(id: string): { status: string; steps: string[]; verdict: unknown } {
  const json: unknown = JSON.parse(
    wrangler("workflows", "instances", "describe", "keel-verify-batch", id, "--json"),
  );
  const body = Reflect.get(Object(json), "result") ?? json;
  const steps: unknown[] = Reflect.get(Object(body), "steps") ?? [];
  const verdict: unknown = Reflect.get(
    Object(steps.find((s) => /^verdict(-\d+)?$/.test(stepName(s)))),
    "output",
  );
  let decoded: unknown = verdict;
  if (typeof verdict === "string") {
    try {
      decoded = JSON.parse(verdict);
    } catch {
      decoded = verdict;
    }
  }
  return {
    status: String(Reflect.get(Object(body), "status")),
    steps: steps.map(stepName),
    verdict: decoded,
  };
}

/**
 * What is deployed to a Worker, as wrangler reports it: its versions and
 * their shares. Read before and after a run, since a tail is never started:
 * enabling one replaces every Durable Object of the Worker.
 */
const deployed = (worker: string): string =>
  wrangler("deployments", "status", "--name", worker)
    .trim()
    .split("\n")
    .filter((l) => /version|Version|%/.test(l))
    .join(" | ");

interface Case {
  readonly name: "land" | "bounce";
  readonly path: string;
  readonly op: "create" | "edit";
  readonly write: (dir: string) => void;
}

const CASES: readonly Case[] = [
  {
    name: "land",
    path: `src/d21/${run}.ts`,
    op: "create",
    write: (dir) => {
      mkdirSync(join(dir, dirname(`src/d21/${run}.ts`)), { recursive: true });
      writeFileSync(join(dir, `src/d21/${run}.ts`), `export const d21Live = "${run}";\n`);
    },
  },
  {
    name: "bounce",
    path: "src/clock.ts",
    op: "edit",
    write: (dir) => {
      const file = join(dir, "src/clock.ts");
      const before = readFileSync(file, "utf8");
      const after = before.replace("this.#now += ms;", "this.#now += 0;");
      if (after === before) throw new Error("src/clock.ts no longer holds the manual clock's step");
      writeFileSync(file, after);
    },
  },
];

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const open: { changeId: string }[] = [];
const serving: Record<string, string> = {};
let operator: KeelClient | undefined;
try {
  serving["keel-verify"] = deployed("keel-verify");
  console.log(`     keel-verify deployed: ${serving["keel-verify"]}`);
  operator = operatorClient();
  const project = await operator.createProject(
    { namespace: ORG, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: `live:${PROJECT}:project` },
  );
  console.log(`     project ${PROJECT}: ${project.id}`);
  await operator.putSettings(project.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  const enrolled = await operator.enrolAgent(
    {
      name: "d21-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId: project.id,
    },
    { idempotencyKey: `live:${PROJECT}:agent` },
  );
  const agent = new KeelClient({
    baseUrl: KEEL_URL,
    clientId: enrolled.clientId,
    clientSecret: enrolled.clientSecret,
  });

  for (const c of CASES) {
    console.log(`\n[${c.name}] ${c.op} ${c.path}`);
    const cursor = await feedHead(agent);
    const caseKey = `d21:${run}:${c.name}`;
    const declared = await declareWhenPooled(
      agent,
      {
        goal: `verify ${run}: ${c.name}`,
        footprint: [{ path: c.path, op: c.op }],
        premises: [],
      },
      caseKey,
    );
    const { change, workspace, lease } = declared.result;
    open.push({ changeId: change.id });
    if (workspace.token === undefined) throw new Error("declare answered no workspace token");
    const dir = cloneWorkspace(workspace.remote, workspace.token);
    let commitSha: string;
    try {
      c.write(dir);
      commitSha = commitAndPush(dir, workspace.token, "d21-agent", `verify ${run}: ${c.name}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const submittedAt = Date.now();
    await agent.submit(
      { changeId: change.id, commitSha },
      { lease: lease.id, idempotencyKey: `${caseKey}:submit` },
    );
    console.log(`     change ${change.id} submitted at ${commitSha.slice(0, 12)}`);

    // Settled once trunk advances or the change bounces, whichever the case expects or not.
    const events = await eventsOf(agent, cursor, change.id, (seen) =>
      seen.some((e) => tagOf(e) === "TrunkAdvanced" || tagOf(e) === "ChangeBounced"),
    );
    const settledMs = Date.now() - submittedAt;
    for (const e of events)
      console.log(`     ${e.eventId} ${tagOf(e)} ${JSON.stringify(e.payload).slice(0, 300)}`);
    const one = (tag: string) => events.find((e) => tagOf(e) === tag);
    const compiled = one("PlanCompiled");
    const queued = one("ChangeQueued");
    const formed = one("BatchFormed");
    const verdicts = events.filter((e) => tagOf(e) === "VerdictIssued");
    const advanced = one("TrunkAdvanced");
    const bounced = one("ChangeBounced");
    const planHash = compiled === undefined ? undefined : field(compiled, "planHash");
    console.log(`     settled in ${settledMs} ms; plan ${String(planHash)}`);
    if (formed !== undefined) {
      const instance = verifyInstanceOf(formed);
      const described = describeVerify(instance);
      console.log(`     ${instance}: ${described.status}, steps ${described.steps.join(" → ")}`);
      console.log(`     verdict step: ${JSON.stringify(described.verdict).slice(0, 600)}`);
    }

    check(typeof planHash === "string", `${c.name}: Precheck compiled a plan`);
    check(
      queued !== undefined && field(queued, "planHash") === planHash,
      `${c.name}: ChangeQueued ${queued?.eventId ?? "(none)"} carries the compiled plan's hash`,
    );
    check(formed !== undefined, `${c.name}: a batch formed with the change in it`);
    const verdict = verdicts.find((v) => field(v, "outcome") === c.name);
    check(
      verdict !== undefined && field(verdict, "planHash") === planHash,
      `${c.name}: VerdictIssued ${verdict?.eventId ?? "(none)"} is ${c.name} under the compiled plan's hash`,
    );
    if (c.name === "land") {
      check(
        advanced !== undefined,
        `land: TrunkAdvanced ${advanced?.eventId ?? "(none)"} lands it`,
      );
      check(bounced === undefined, "land: never bounced");
    } else {
      check(bounced !== undefined, `bounce: ChangeBounced ${bounced?.eventId ?? "(none)"}`);
      check(
        bounced !== undefined &&
          verdict !== undefined &&
          field(bounced, "verdictId") === field(verdict, "verdictId"),
        "bounce: ChangeBounced cites the bounce verdict",
      );
      check(advanced === undefined, "bounce: never landed");
      const reasons = bounced === undefined ? [] : field(bounced, "reasons");
      console.log(`     reasons: ${JSON.stringify(reasons).slice(0, 600)}`);
    }
  }
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // A landed change is done; anything else the run declared is withdrawn.
  for (const { changeId } of open) {
    try {
      const status = await operator?.change(changeId);
      const state = status?.state;
      if (state === "landed" || state === "withdrawn" || state === "superseded") continue;
      await operator?.abandon(
        changeId,
        { reason: `verify check ${run} finished` },
        { idempotencyKey: `d21:${run}:abandon:${changeId}` },
      );
      console.log(`     abandoned ${changeId} (was ${String(state)})`);
    } catch (error) {
      console.log(
        `FAIL abandon ${changeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
    }
  }
  for (const [worker, before] of Object.entries(serving)) {
    let after: string;
    try {
      after = deployed(worker);
    } catch (error) {
      after = `unread (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`;
    }
    check(after === before, `${worker}'s deployment is the one the run began on`);
    if (after !== before) console.log(`     ${worker} now: ${after}`);
  }
}
console.log(failures === 0 ? "\nall verify checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
