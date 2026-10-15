// An adopted change's submit, live against a deployed Keel: a change that was
// bounced, parked once its lease lapsed, and adopted takes a commit pushed to
// its workspace with the adoption's token.
//
//   KEEL_URL=<keel> node e2e/src/adopt.ts <run>
//
// It takes no Keel credential. A person, `ad-<run>-p`, signs up by passkey,
// creates the project `adopt` in their own namespace from the fixture
// template with verification off and vitest.config.ts protected, and enrols one
// agent, which:
//   [1] declares, pushes an edit of vitest.config.ts and submits it: Precheck bounces
//       it on the protected path, and the change waits on its agent;
//   [2] renews nothing for 15 minutes, so the lease's deadline parks it;
//   [3] adopts the change, pushes a second commit with the adoption's token
//       and submits it, which Keel takes: ChangeSubmitted at that commit.
// Every change the run declared is withdrawn at the end. No session, passkey,
// credential or remote URL is printed.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import { declareWhenPooled, feedOf, FIXTURE, tagOf } from "./lib/s1.ts";

const [run, scenario = "new-commit"] = process.argv.slice(2);
if (scenario !== "new-commit" && scenario !== "pushed-before")
  throw new Error("usage: adopt.ts <run> [new-commit|pushed-before]");
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: adopt.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");

const PERSON = `ad-${run}-p`;
const PROJECT = "adopt";
const key = (what: string) => `adopt:${run}:${what}`;
const SETTLE_MS = 10 * 60_000;
/** The lease's 15 minutes, and time for the deadline's alarm to make the lapse visible. */
const LAPSE_MS = 22 * 60_000;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};
const prop = (value: unknown, name: string): unknown => Reflect.get(Object(value), name);
const at = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const signedUp: { person?: KeelClient } = {};
const open: string[] = [];

/** Clones the workspace with `token`, appends a line to `file`, commits, pushes and answers the commit. */
function pushEdit(remote: string, token: string, file: string, line: string): string {
  const dir = cloneWorkspace(remote, token);
  try {
    const path = join(dir, file);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, `${before}\n// ${line}\n`);
    return commitAndPush(dir, token, "ad-agent", `adopt live ${run}: ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const me = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  signedUp.person = me;
  const handle = account.session.namespace;
  console.log(`     ${PERSON} signed up by passkey: ${account.session.userId}`);
  const project = await me.createProject(
    { namespace: handle, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  await me.putSettings(project.id, {
    protectedPaths: ["vitest.config.ts"],
    maxBatchSize: 1,
    verification: "off",
  });
  console.log(`     project ${handle}/${PROJECT}: ${project.id}`);
  const enrolled = await me.enrolAgent(
    {
      name: "ad-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId: project.id,
    },
    { idempotencyKey: key("agent") },
  );
  const agent = new KeelClient({
    baseUrl: keelUrl,
    clientId: enrolled.clientId,
    clientSecret: enrolled.clientSecret,
  });
  console.log(`     agent ad-agent: ${enrolled.agent.id}`);
  const { cursor } = await me.snapshot({ project: project.id });
  const feed = feedOf(me, { project: project.id, cursor });

  if (scenario === "pushed-before") return pushedBefore(agent, me, feed);
  console.log(
    `\n[1] ${at()} declare, push an edit of vitest.config.ts, submit: Precheck bounces it`,
  );
  const declared = await declareWhenPooled(
    agent,
    {
      goal: "Note the adoption check in the README",
      footprint: [{ path: "vitest.config.ts", op: "edit" }],
      premises: [],
    },
    key("declare"),
    SETTLE_MS,
  );
  const changeId = declared.result.change.id;
  open.push(changeId);
  const { workspace, lease } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const first = pushEdit(workspace.remote, workspace.token, "vitest.config.ts", "first");
  await agent.submit(
    { changeId, commitSha: first },
    { lease: lease.id, idempotencyKey: key("submit-1") },
  );
  console.log(`     ${changeId} submitted at ${first.slice(0, 12)}`);
  const bounceDeadline = Date.now() + SETTLE_MS;
  while ((await me.change(changeId)).state !== "bounced" && Date.now() < bounceDeadline)
    await sleep(5_000);
  check((await me.change(changeId)).state === "bounced", "Precheck bounced it on vitest.config.ts");

  console.log(`\n[2] ${at()} nothing renews the lease: its deadline parks the change`);
  const lapseDeadline = Date.now() + LAPSE_MS;
  let parked = await me.change(changeId);
  while (parked.state !== "parked" && Date.now() < lapseDeadline) {
    await sleep(30_000);
    parked = await me.change(changeId);
  }
  check(parked.state === "parked", `parked for the lapse at ${at()} (state ${parked.state})`);

  console.log(`\n[3] ${at()} adopt, push a second commit with the adoption's token, submit`);
  const adopted = await agent.adopt(changeId, { idempotencyKey: key("adopt") });
  const result = prop(adopted, "result") ?? adopted;
  console.log(`     adopt answered: ${Object.keys(Object(result)).join(", ")}`);
  const grant = prop(result, "workspace") ?? prop(result, "grant");
  const leaseId = String(
    prop(prop(result, "lease"), "id") ?? prop(prop(result, "change"), "leaseId"),
  );
  const remote = String(prop(grant, "remote"));
  const token = String(prop(grant, "token"));
  check(prop(grant, "token") !== undefined, "the adoption answers a workspace token");
  const second = pushEdit(remote, token, "adopt-notes.ts", "second");
  console.log(`     pushed ${second.slice(0, 12)} to the change's workspace`);
  let refused: string | undefined;
  try {
    await agent.submit(
      { changeId, commitSha: second },
      { lease: leaseId, idempotencyKey: key("submit-2") },
    );
  } catch (error) {
    if (!(error instanceof KeelProblem)) throw error;
    refused = `${error.status} ${error.code}: ${error.message} (request ${error.requestId})`;
  }
  check(
    refused === undefined,
    `the submit at the second commit is taken${refused === undefined ? "" : `, not refused ${refused}`}`,
  );
  if (refused !== undefined) {
    // Is any commit found, or none? The first was in the workspace before the adoption.
    try {
      await agent.submit(
        { changeId, commitSha: first },
        { lease: leaseId, idempotencyKey: key("submit-first-again") },
      );
      console.log("     the first commit, submitted again under the adoption's lease, is taken");
    } catch (error) {
      console.log(
        `     the first commit, submitted again, is refused too: ${error instanceof KeelProblem ? `${error.code} (request ${error.requestId})` : String(error)}`,
      );
    }
  }
  const takenAtSecond = () =>
    feed.seen.some(
      (e) =>
        tagOf(e) === "ChangeSubmitted" &&
        prop(e.payload, "changeId") === changeId &&
        prop(e.payload, "commitSha") === second,
    );
  await feed.until(takenAtSecond, 60_000);
  check(takenAtSecond(), "ChangeSubmitted at the second commit is on the project's feed");
}

/**
 * The commit pushed under the first lease, submitted under the adoption's: the
 * agent declares and pushes, renews nothing, and once its deadline has parked
 * the change it adopts, pushes nothing new (the workspace already holds the
 * commit) and submits that commit, which Keel takes.
 */
async function pushedBefore(
  agent: KeelClient,
  me: KeelClient,
  feed: ReturnType<typeof feedOf>,
): Promise<void> {
  console.log(`\n[1] ${at()} declare and push a commit under the first lease; no submit`);
  const declared = await declareWhenPooled(
    agent,
    {
      goal: "Note the adoption check",
      footprint: [{ path: "adopt-notes.ts", op: "create" }],
      premises: [],
    },
    key("declare"),
    SETTLE_MS,
  );
  const changeId = declared.result.change.id;
  open.push(changeId);
  const { workspace } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const pushed = pushEdit(workspace.remote, workspace.token, "adopt-notes.ts", "pushed before");
  console.log(`     ${changeId} holds ${pushed.slice(0, 12)} in its workspace`);

  console.log(`\n[2] ${at()} nothing renews the lease: its deadline parks the change`);
  const lapseDeadline = Date.now() + LAPSE_MS;
  let parked = await me.change(changeId);
  while (parked.state !== "parked" && Date.now() < lapseDeadline) {
    await sleep(30_000);
    parked = await me.change(changeId);
  }
  check(parked.state === "parked", `parked for the lapse at ${at()} (state ${parked.state})`);

  console.log(`\n[3] ${at()} adopt, push nothing new, submit the commit pushed before`);
  const adopted = prop(await agent.adopt(changeId, { idempotencyKey: key("adopt") }), "result");
  const grant = prop(adopted, "workspace");
  const leaseId = String(prop(prop(adopted, "lease"), "id"));
  // The workspace already holds the commit: a push of the same head moves nothing.
  const dir = cloneWorkspace(String(prop(grant, "remote")), String(prop(grant, "token")));
  try {
    check(
      git(dir, ["rev-parse", "HEAD"]) === pushed,
      "the workspace's main is the commit pushed before",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  let refused: string | undefined;
  try {
    await agent.submit(
      { changeId, commitSha: pushed },
      { lease: leaseId, idempotencyKey: key("submit") },
    );
  } catch (error) {
    if (!(error instanceof KeelProblem)) throw error;
    refused = `${error.status} ${error.code} (request ${error.requestId})`;
  }
  check(
    refused === undefined,
    `the submit of the commit pushed before is taken${refused === undefined ? "" : `, not refused ${refused}`}`,
  );
  const taken = () =>
    feed.seen.some(
      (e) =>
        tagOf(e) === "ChangeSubmitted" &&
        prop(e.payload, "changeId") === changeId &&
        prop(e.payload, "commitSha") === pushed,
    );
  if (refused === undefined) await feed.until(taken, 60_000);
  check(taken(), "ChangeSubmitted at that commit is on the project's feed");
}

try {
  await walk();
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.status} ${error.message} (request ${error.requestId})`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else if (error instanceof AccountRefused) console.log(`FAIL stopped: ${error.message}`);
  else
    console.log(
      `FAIL ${(error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "<remote>")}`,
    );
} finally {
  const { person } = signedUp;
  for (const changeId of open) {
    if (person === undefined) break;
    try {
      const state = (await person.change(changeId)).state;
      if (["landed", "withdrawn", "superseded", "integrating"].includes(state)) continue;
      await person.abandon(
        changeId,
        { reason: `adopt live check ${run} finished` },
        { idempotencyKey: key(`abandon:${changeId}`) },
      );
      console.log(`     abandoned ${changeId} (was ${state})`);
    } catch (error) {
      console.log(
        `FAIL abandon ${changeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
    }
  }
}
if (failures > 0) console.log(`\n${failures} check(s) failed`);
else console.log("\nall adopt live checks hold");
process.exit(failures > 0 ? 1 : 0);
