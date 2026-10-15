// The lease's deadline, live against a deployed Keel: the agent holding a
// change reads its lease back, with no lapse time while Keel holds the change,
// and Keel's hand-back starts the lease's 15 minutes again.
//
//   KEEL_URL=<keel> node e2e/src/lease.ts <run>
//
// It takes no Keel credential. A person, `ls-<run>-p`, signs up by passkey,
// creates the project `lease` in their own namespace from the fixture
// template with verification off and vitest.config.ts protected, and enrols
// one agent, which declares, pushes an edit of the protected file and submits
// it, so Precheck bounces it. The change is withdrawn at the end. No session,
// passkey, credential or remote URL is printed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import { cloneWorkspace, commitAndPush } from "./lib/git.ts";
import { declareWhenPooled, feedOf, FIXTURE, tagOf } from "./lib/s1.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: lease.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");

const PERSON = `ls-${run}-p`;
const PROJECT = "lease";
const FILE = "vitest.config.ts";
const TTL_MS = 15 * 60_000;
const key = (what: string) => `lease:${run}:${what}`;
const SETTLE_MS = 10 * 60_000;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};
const prop = (value: unknown, name: string): unknown => Reflect.get(Object(value), name);
const ms = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);

const signedUp: { person?: KeelClient } = {};
const open: string[] = [];

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const me = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  signedUp.person = me;
  const handle = account.session.namespace;
  const project = await me.createProject(
    { namespace: handle, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  await me.putSettings(project.id, {
    protectedPaths: [FILE],
    maxBatchSize: 1,
    verification: "off",
  });
  console.log(`     project ${handle}/${PROJECT}: ${project.id}`);
  const enrolled = await me.enrolAgent(
    {
      name: "ls-agent",
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
  const { cursor } = await me.snapshot({ project: project.id });
  const feed = feedOf(me, { project: project.id, cursor });

  console.log("\n[1] the agent declares and reads its lease back; the person reads none");
  const declared = await declareWhenPooled(
    agent,
    { goal: "Note the lease check", footprint: [{ path: FILE, op: "edit" }], premises: [] },
    key("declare"),
    SETTLE_MS,
  );
  const changeId = declared.result.change.id;
  open.push(changeId);
  const lease = prop(await agent.change(changeId), "lease");
  check(prop(lease, "id") === declared.result.lease.id, "the holder reads its lease's id");
  check(
    ms(prop(lease, "lapsesAt")) - ms(prop(lease, "renewedAt")) === TTL_MS,
    "and when it lapses: 15 minutes after its renewal",
  );
  check(prop(await me.change(changeId), "lease") === undefined, "the person reads no lease");

  console.log("\n[2] it submits an edit of the protected file: Keel holds it, then bounces it");
  const { workspace } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dir = cloneWorkspace(workspace.remote, workspace.token);
  let commitSha: string;
  try {
    const path = join(dir, FILE);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// lease live ${run}\n`);
    commitSha = commitAndPush(dir, workspace.token, "ls-agent", `lease live ${run}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await agent.submit(
    { changeId, commitSha },
    { lease: declared.result.lease.id, idempotencyKey: key("submit") },
  );
  const held = await agent.change(changeId);
  if (["submitted", "deriving", "verifying", "queued"].includes(String(prop(held, "state"))))
    check(
      prop(prop(held, "lease"), "lapsesAt") === undefined &&
        prop(prop(held, "lease"), "id") !== undefined,
      `while Keel holds it (${String(prop(held, "state"))}), its lease shows no lapse time`,
    );
  else
    console.log(
      `     (already ${String(prop(held, "state"))} at the first read: the held read is skipped)`,
    );
  const ofChange = (type: string) =>
    feed.seen.filter((e) => tagOf(e) === type && prop(e.payload, "changeId") === changeId);
  await feed.until(() => ofChange("LeaseRestarted").length > 0, SETTLE_MS);

  console.log("\n[3] the bounce hands it back, and the lease's 15 minutes start again");
  const [bounced] = ofChange("ChangeBounced");
  const [restarted] = ofChange("LeaseRestarted");
  check(bounced !== undefined, "Precheck bounced it on the protected path");
  check(
    restarted !== undefined && bounced !== undefined && restarted.seq === bounced.seq + 1,
    "LeaseRestarted follows the bounce, in the same commit",
  );
  check(
    ofChange("ChangeParked").length === 0 && ofChange("LeaseLapsed").length === 0,
    "no park, no lapse",
  );
  const back = prop(await agent.change(changeId), "lease");
  check(
    restarted !== undefined && ms(prop(back, "renewedAt")) === ms(restarted.at),
    "the lease is renewed at the hand-back",
  );
  check(
    ms(prop(back, "lapsesAt")) - ms(prop(back, "renewedAt")) === TTL_MS,
    "and lapses 15 minutes after it",
  );
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
        { reason: `lease live check ${run} finished` },
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
else console.log("\nall lease live checks hold");
process.exit(failures > 0 ? 1 : 0);
