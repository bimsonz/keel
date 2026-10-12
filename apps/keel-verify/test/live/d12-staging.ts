// The staging proof: Precheck on real changes through the deployed Keel.
//
//   node apps/keel-verify/test/live/d12-staging.ts <run>
//
// In a project of its own (d12-precheck, forked from the seeded fixture repo,
// so S-0's projects are untouched), one agent declares, pushes and submits:
//   (a) a file under .keel/guards/ → bounced by GUARD_PATHS;
//   (b0) config/<run>.json while protectedPaths is [] → compiled, the control;
//   (b) the same kind of file once protectedPaths is ["config/**"] → bounced,
//       with a submit and an escalate next action;
//   (c) a new file under src/ → PlanCompiled.
// Each case is judged from the project's event feed (ChangeSubmitted's eventId
// names the instance, precheck-<eventId>), and the Precheck instance's steps
// are read back with wrangler. The bootstrap secret comes from Terraform's
// output; no credential is printed. KEEL_URL overrides the workers.dev URL.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KeelClient, KeelProblem } from "../../../../packages/sdk/src/index.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const KEEL = join(ROOT, "apps/keel");
const KEEL_URL = process.env["KEEL_STAGING_URL"];
const FIXTURE = "fixture-forge-lite";
const PROJECT = "d12-precheck";
const SETTLE_MS = 5 * 60_000;

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: d12-staging.ts <run>, the run a lower-case slug");
const key = (role: string) => `d12:staging:${role}`;

const wrangler = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: KEEL,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_userconfig: "/dev/null", WRANGLER_SEND_METRICS: "false" },
  });

/** System git with no machine config, the token only in a header set through GIT_CONFIG_*. */
function git(cwd: string, args: readonly string[], token?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(token === undefined
        ? {}
        : {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
          }),
    },
  }).trim();
}

interface Case {
  readonly name: string;
  readonly path: string;
  readonly expect: "bounced" | "compiled";
  readonly protectedPaths: readonly string[];
}

const CASES: readonly Case[] = [
  { name: "a-guard", path: `.keel/guards/d12-${run}.ts`, expect: "bounced", protectedPaths: [] },
  { name: "b0-unprotected", path: `config/${run}-b0.json`, expect: "compiled", protectedPaths: [] },
  {
    name: "b-protected",
    path: `config/${run}-b.json`,
    expect: "bounced",
    protectedPaths: ["config/**"],
  },
  { name: "c-clean", path: `src/d12/${run}.ts`, expect: "compiled", protectedPaths: ["config/**"] },
];

type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];

async function feedHead(reader: KeelClient): Promise<string> {
  let page = await reader.events({ limit: 500 });
  while (page.items.length > 0) page = await reader.events({ cursor: page.nextCursor, limit: 500 });
  return page.nextCursor;
}

/** The feed's events about `changeId` from `cursor`, until `done` holds or the deadline passes. */
async function eventsOf(
  reader: KeelClient,
  cursor: string,
  changeId: string,
  done: (events: readonly EventRecord[]) => boolean,
): Promise<EventRecord[]> {
  const seen: EventRecord[] = [];
  const deadline = Date.now() + SETTLE_MS;
  let at = cursor;
  while (Date.now() < deadline) {
    const page = await reader.events({ cursor: at, limit: 500 });
    at = page.nextCursor;
    seen.push(...page.items.filter((e) => Reflect.get(e.payload, "changeId") === changeId));
    if (done(seen)) break;
    if (page.items.length === 0) await new Promise((r) => setTimeout(r, 3_000));
  }
  return seen;
}

function describePrecheck(id: string): { status: string; steps: string[]; decide: unknown } {
  const json: unknown = JSON.parse(
    wrangler("workflows", "instances", "describe", "keel-precheck", id, "--json"),
  );
  const body = Reflect.get(Object(json), "result") ?? json;
  const steps: unknown[] = Reflect.get(Object(body), "steps") ?? [];
  const named = steps.map((s) => String(Reflect.get(Object(s), "name") ?? "?"));
  const decide = steps.find((s) => /^decide(-\d+)?$/.test(String(Reflect.get(Object(s), "name"))));
  const output: unknown = Reflect.get(Object(decide), "output");
  let decided: unknown = output;
  if (typeof output === "string") {
    try {
      decided = JSON.parse(output);
    } catch {
      decided = output;
    }
  }
  return { status: String(Reflect.get(Object(body), "status")), steps: named, decide: decided };
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

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

try {
  // The lane user governs: it creates the project and enrols the agent, which it sponsors.
  const session = process.env["KEEL_SESSION"];
  if (session === undefined) throw new Error("set KEEL_SESSION to the maintainer's session");
  const operator = new KeelClient({ baseUrl: KEEL_URL, session });
  const project = await operator.createProject(
    { org: process.env["KEEL_ORG"] ?? "keel", name: PROJECT, source: FIXTURE },
    { idempotencyKey: key("project") },
  );
  console.log(`     project ${PROJECT}: ${project.id}`);
  const agentEnrolled = await operator.enrolAgent(
    {
      name: "d12-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId: project.id,
    },
    { idempotencyKey: key("agent") },
  );
  const agent = new KeelClient({
    baseUrl: KEEL_URL,
    clientId: agentEnrolled.clientId,
    clientSecret: agentEnrolled.clientSecret,
  });

  for (const c of CASES) {
    const settings = await operator.putSettings(project.id, {
      protectedPaths: [...c.protectedPaths],
      maxBatchSize: 1,
      verification: "required",
    });
    console.log(
      `\n[${c.name}] ${c.path} with protectedPaths ${JSON.stringify(settings.protectedPaths)}`,
    );
    const cursor = await feedHead(agent);
    const caseKey = `d12:${run}:${c.name}`;
    const declared = await declareWhenPooled(
      agent,
      {
        goal: `staging ${run}: ${c.name}`,
        footprint: [{ path: c.path, op: "create" }],
        premises: [],
      },
      caseKey,
    );
    const { change, workspace, lease } = declared.result;
    if (workspace.token === undefined) throw new Error("declare answered no workspace token");
    const dir = mkdtempSync(join(tmpdir(), "keel-d12-"));
    let commitSha: string;
    try {
      git(dir, ["clone", "-q", workspace.remote, "."], workspace.token);
      mkdirSync(join(dir, dirname(c.path)), { recursive: true });
      writeFileSync(join(dir, c.path), `// D1.2 staging run ${run}, case ${c.name}\n`);
      const identity = [
        "-c",
        "user.name=d12-agent",
        "-c",
        "user.email=d12-agent@agents.keel.invalid",
      ];
      git(dir, ["add", "-A"]);
      git(dir, [...identity, "commit", "-q", "-m", `staging ${run}: ${c.name}`]);
      git(dir, ["push", "-q", "origin", "HEAD:refs/heads/main"], workspace.token);
      commitSha = git(dir, ["rev-parse", "HEAD"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await agent.submit(
      { changeId: change.id, commitSha },
      { lease: lease.id, idempotencyKey: `${caseKey}:submit` },
    );
    console.log(`     submitted ${change.id} at ${commitSha.slice(0, 12)}`);

    const events = await eventsOf(agent, cursor, change.id, (seen) =>
      seen.some((e) => e.payload._tag === "ChangeBounced" || e.payload._tag === "PlanCompiled"),
    );
    console.log(`     events: ${events.map((e) => e.payload._tag).join(", ")}`);
    const submitted = events.find((e) => e.payload._tag === "ChangeSubmitted");
    const bounced = events.find((e) => e.payload._tag === "ChangeBounced")?.payload;
    const compiled = events.find((e) => e.payload._tag === "PlanCompiled")?.payload;
    if (bounced?._tag === "ChangeBounced") {
      console.log(`     reasons: ${JSON.stringify(bounced.reasons)}`);
      for (const next of bounced.nextActions ?? [])
        console.log(
          `     next: ${next.kind} ${next.operationId ?? ""} "${next.title}" ${JSON.stringify(next.args ?? {})}`,
        );
    }
    if (compiled?._tag === "PlanCompiled") console.log(`     plan: ${JSON.stringify(compiled)}`);
    const status = await agent.status(change.id);
    console.log(`     state: ${status.result.state}`);
    if (submitted !== undefined) {
      const instance = `precheck-${submitted.eventId}`;
      const described = describePrecheck(instance);
      console.log(`     ${instance}: ${described.status}, steps ${described.steps.join(" → ")}`);
      console.log(`     decide: ${JSON.stringify(described.decide)}`);
    }

    if (c.expect === "bounced") {
      check(bounced !== undefined && compiled === undefined, `${c.name}: bounced, never compiled`);
      const actions = bounced?._tag === "ChangeBounced" ? (bounced.nextActions ?? []) : [];
      check(actions.length > 0, `${c.name}: the bounce carries next actions`);
      check(
        actions.some((a) => JSON.stringify(a.args ?? {}).includes(c.path)),
        `${c.name}: a next action names ${c.path}`,
      );
      if (c.name === "b-protected")
        check(
          actions.some((a) => a.operationId === "submit") &&
            actions.some((a) => a.kind === "escalate"),
          `${c.name}: a submit and an escalate action`,
        );
    } else {
      check(
        compiled !== undefined && bounced === undefined,
        `${c.name}: PlanCompiled, never bounced`,
      );
    }
  }
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(failures === 0 ? "\nall D1.2 staging checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
