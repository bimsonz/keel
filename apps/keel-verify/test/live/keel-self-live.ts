// Keel verifies Keel, live: Keel's own repository, imported from GitHub into
// the maintainer's namespace, verified through its own flow (`.keel/flow.json`).
// Three changes: a docs-only one runs keel.docs alone and lands; a code change
// runs keel.check and keel.test and lands; a code change breaking a unit test
// bounces, its reasons citing keel.test's fail and the test. Each case prints
// its KeelVerify instance's steps with their durations.
//
//   KEEL_SESSION=<token> [KEEL_ORG=<org>] [KEEL_SELF_PROJECT=<name>] node apps/keel-verify/test/live/keel-self-live.ts <run>
//
// The session is the maintainer's, read from the environment and never
// printed. Every change the run declares and does not land is withdrawn.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneWorkspace, commitAndPush } from "../../../../e2e/src/lib/git.ts";
import { KeelClient, KeelProblem } from "../../../../packages/sdk/src/index.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const KEEL = join(ROOT, "apps/keel");
const KEEL_URL = process.env["KEEL_URL"] ?? "https://keel.town";
const SOURCE = { kind: "import", url: "https://github.com/bimsonz/keel", ref: "main" } as const;
const PROJECT = process.env["KEEL_SELF_PROJECT"] ?? "keel-self";
const SETTLE_MS = 40 * 60_000;

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: keel-self-live.ts <run>, the run a lower-case slug");
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
  const took = (s: unknown): string => {
    const start = Date.parse(String(Reflect.get(Object(s), "start") ?? ""));
    const end = Date.parse(String(Reflect.get(Object(s), "end") ?? ""));
    return Number.isFinite(start) && Number.isFinite(end)
      ? ` ${((end - start) / 1000).toFixed(1)} s`
      : "";
  };
  return {
    status: String(Reflect.get(Object(body), "status")),
    steps: steps.map((s) => `${stepName(s)}${took(s)}`),
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
  readonly name: "docs" | "code" | "broken";
  readonly expect: "land" | "bounce";
  /** The flow steps the plan must hold, and none of the others. */
  readonly steps: readonly string[];
  readonly path: string;
  readonly op: "create" | "edit";
  readonly write: (dir: string) => void;
}

const FLOW_STEPS = ["keel.docs", "keel.check", "keel.test"];
const edit = (dir: string, path: string, from: string, to: string) => {
  const file = join(dir, path);
  const before = readFileSync(file, "utf8");
  const after = before.replace(from, to);
  if (after === before) throw new Error(`${path} no longer holds ${JSON.stringify(from)}`);
  writeFileSync(file, after);
};

const CASES: readonly Case[] = [
  {
    name: "docs",
    expect: "land",
    steps: ["keel.docs"],
    path: `docs/self-proof/${run}.md`,
    op: "create",
    write: (dir) => {
      mkdirSync(join(dir, "docs/self-proof"), { recursive: true });
      writeFileSync(
        join(dir, `docs/self-proof/${run}.md`),
        `# Self proof ${run}\n\nA docs-only change Keel verified on its own repository.\n`,
      );
    },
  },
  {
    name: "code",
    expect: "land",
    steps: ["keel.check", "keel.test"],
    path: "packages/core/src/domain/kernel/tier.ts",
    op: "edit",
    write: (dir) =>
      edit(
        dir,
        "packages/core/src/domain/kernel/tier.ts",
        "export type TierChoice = typeof TierChoice.Type;\n",
        `export type TierChoice = typeof TierChoice.Type;\n\n// Self proof ${run}: a code change Keel verified on its own repository.\n`,
      ),
  },
  {
    name: "broken",
    expect: "bounce",
    steps: ["keel.check", "keel.test"],
    path: "packages/core/src/application/verification/probe-run.ts",
    op: "edit",
    write: (dir) =>
      edit(
        dir,
        "packages/core/src/application/verification/probe-run.ts",
        "if (exit !== PROBE_EXIT[outcome])",
        "if (exit === PROBE_EXIT[outcome])",
      ),
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
    { namespace: ORG, name: PROJECT, source: SOURCE },
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
      name: "keel-self-agent",
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
    const caseKey = `keel-self:${run}:${c.name}`;
    const declared = await declareWhenPooled(
      agent,
      {
        goal: `Keel verifies Keel ${run}: ${c.name}`,
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
      commitSha = commitAndPush(
        dir,
        workspace.token,
        "keel-self-agent",
        `Keel verifies Keel ${run}: ${c.name}`,
      );
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
    const verdict = verdicts.find((v) => field(v, "outcome") === c.expect);
    check(
      verdict !== undefined && field(verdict, "planHash") === planHash,
      `${c.name}: VerdictIssued ${verdict?.eventId ?? "(none)"} is ${c.expect} under the compiled plan's hash`,
    );
    const ran = formed === undefined ? [] : describeVerify(verifyInstanceOf(formed)).steps;
    const flowRan = FLOW_STEPS.filter((s) => ran.some((r) => r.startsWith(`${s}-`)));
    check(
      JSON.stringify(flowRan.toSorted()) === JSON.stringify([...c.steps].toSorted()),
      `${c.name}: the plan ran ${c.steps.join(" and ")} alone (ran ${flowRan.join(", ") || "none"})`,
    );
    if (c.expect === "land") {
      check(
        advanced !== undefined,
        `${c.name}: TrunkAdvanced ${advanced?.eventId ?? "(none)"} lands it`,
      );
      check(bounced === undefined, `${c.name}: never bounced`);
    } else {
      check(bounced !== undefined, `${c.name}: ChangeBounced ${bounced?.eventId ?? "(none)"}`);
      check(
        bounced !== undefined &&
          verdict !== undefined &&
          field(bounced, "verdictId") === field(verdict, "verdictId"),
        `${c.name}: ChangeBounced cites the bounce verdict`,
      );
      check(advanced === undefined, `${c.name}: never landed`);
      const reasons = bounced === undefined ? [] : field(bounced, "reasons");
      const text = JSON.stringify(reasons);
      check(/keel\.test: fail/.test(text), `${c.name}: its reasons cite keel.test's fail`);
      check(/probe-run/.test(text), `${c.name}: its reasons name the broken test`);
      console.log(`     reasons: ${text.slice(0, 1500)}`);
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
        { reason: `Keel self proof ${run} finished` },
        { idempotencyKey: `keel-self:${run}:abandon:${changeId}` },
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
console.log(failures === 0 ? "\nall keel-self live checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
