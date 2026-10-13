// The live proof against a deployed Keel that an agent that holds only a key lands a change.
//   KEEL_URL=<keel> node e2e/src/a17.ts <run>
//
// No credential is given and none is kept. The script makes a key in memory,
// and everything after is done as the agent that key signs up as, in the run
// `<run>` names. Each run of the script is a new key, so a new agent.
//   (a) the key signs up: an agent with a handle made from the key, no sponsor
//       and no project, which whoami answers in the run its token names. A
//       token it asks for with no key behind it is taken as a plain bearer,
//       and refused beside a DPoP header;
//   (b) the agent makes a project in the namespace that is its own, from
//       Keel's fixture template. ProjectCreated on the project's feed is the
//       agent's, in that run;
//   (c) it declares a change there, pushes one file and submits. The change
//       lands verified, and every event the agent's commands committed on the
//       way names the run;
//   (d) the landed commit is written by the agent (its handle, at the agents'
//       host) and committed by Keel, names the agent and the run in its
//       Keel-Agent and Keel-Run trailers, and stock git verifies it against
//       the signers file Keel publishes and refuses it against a file that
//       names another key.
// No token, remote URL or key is printed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dpopProof, generateAgentKey, KeelClient, KeelProblem, signUp } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import {
  declareWhenPooled,
  holdsCommit,
  keelSigners,
  line,
  projectEvents,
  tagged,
} from "./lib/live.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(run))
  throw new Error("usage: a17.ts <run>, the run a lower-case slug");
const keelUrl = process.env.KEEL_URL;
if (keelUrl === undefined)
  throw new Error("KEEL_URL is not set: a17 needs the Keel to sign up at, and nothing else");
const HOST = new URL(keelUrl).host;
const PROJECT = "a17";
const TEMPLATE = "fixture-forge-lite";
/** How long the feed is read for ProjectCreated once the trunk's first event is on it. */
const CREATED_MS = 60_000;
const key = (what: string) => `a17:${run}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const dirs: string[] = [];

async function landWithOnlyAKey(baseUrl: string, label: string): Promise<void> {
  // (a) a key, and nothing else.
  const { signer } = await generateAgentKey();
  const signedUp = await signUp({ baseUrl, signer });
  const { agentId, handle } = signedUp;
  console.log(`     agent ${agentId}, handle ${handle}`);
  check(signedUp.created, "(a) a key made here signs up as a new agent");
  const again = await signUp({ baseUrl, signer });
  check(
    again.agentId === agentId && again.handle === handle && !again.created,
    "(a) the same key again is the same agent, and makes no other",
  );
  const account = new KeelClient({ baseUrl, agentId, key: signer, run: label });
  const me = (await account.whoami()).result;
  console.log(
    `     whoami: ${me.agent.handle}, run ${me.run?.label} (${me.run?.id}), holding ${me.agent.scopes.join(" ")}`,
  );
  check(
    me.agent.id === agentId && me.agent.handle === handle,
    "(a) whoami answers that agent, by the handle its sign-up gave",
  );
  check(
    me.agent.sponsor === undefined && me.agent.projectId === undefined,
    "(a) it has no sponsor and belongs to no project",
  );
  check(me.run?.label === label, `(a) its token names the run ${label}`);
  const runId = me.run?.id ?? "";

  // A token asked for with no key behind it, to hand to a tool that cannot sign. Alone it is the
  // agent; beside a proof it is not bound to it is refused, whoever made the proof.
  const { signer: another } = await generateAgentKey();
  const beside = { proof: false };
  const plain = new KeelClient({
    baseUrl,
    agentId,
    key: signer,
    run: label,
    bound: false,
    fetch: async (input, init) => {
      const headers = new Headers(init.headers);
      const bearer = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
      if (beside.proof && bearer !== undefined)
        headers.set(
          "dpop",
          await dpopProof(another, {
            method: init.method ?? "GET",
            url: input,
            accessToken: bearer,
          }),
        );
      return fetch(input, { ...init, headers });
    },
  });
  check(
    (await plain.whoami()).result.agent.id === agentId,
    "(a) a token it asks for with no key behind it is taken as a plain bearer",
  );
  beside.proof = true;
  const refused: unknown = await plain.whoami().then(
    () => undefined,
    (error: unknown) => error,
  );
  check(
    refused instanceof KeelProblem &&
      refused.status === 401 &&
      refused.code === "auth.invalid_token",
    "(a) and such a bearer beside a DPoP header, a real proof by another key, is refused 401 auth.invalid_token",
  );

  // (b) a project in the agent's own namespace.
  const asked = Date.now();
  const project = await account.createProject(
    { namespace: handle, name: PROJECT, source: { kind: "template", name: TEMPLATE } },
    { idempotencyKey: key("project") },
  );
  console.log(
    `     project ${handle}/${PROJECT}: ${project.id}, answered in ${Date.now() - asked} ms`,
  );
  check(
    project.namespace.kind === "agent" && project.namespace.handle === handle,
    "(b) the project is in the agent's own namespace, a namespace of kind agent",
  );
  // A token is for one project: the work is done with one that names this project, in the same run.
  const worker = new KeelClient({ baseUrl, agentId, key: signer, project: project.id, run: label });
  let initializedAt: number | undefined;
  const start = await projectEvents(worker, undefined, project.id, (seen) => {
    if (tagged(seen, "TrunkInitialized").length === 0) return false;
    initializedAt ??= Date.now();
    return tagged(seen, "ProjectCreated").length > 0 || Date.now() - initializedAt > CREATED_MS;
  });
  for (const e of start) console.log(`     ${line(e)}`);
  const created = tagged(start, "ProjectCreated")[0];
  console.log(`     ProjectCreated by ${created?.actor}, in run ${JSON.stringify(created?.run)}`);
  check(
    created?.actor === `agent:${agentId}`,
    "(b) ProjectCreated on the project's feed is the agent's own",
  );
  check(
    created?.run?.id === runId && created.run.label === label,
    "(b) and it names the run the project was made in",
  );
  const settings = await worker.settings(project.id);
  check(
    settings.verification === "required",
    "(b) the project asks for verification before a landing, as it was made",
  );

  // (c) a change, declared, pushed and submitted by the agent, lands verified.
  const { cursor } = await worker.snapshot({ project: project.id });
  const file = `notes/a17-${label}.md`;
  const text = `Landed by ${handle}, an agent that holds only a key, in run ${label}.\n`;
  const goal = `a17 ${label}: a note from an agent that holds only a key`;
  const declared = await declareWhenPooled(
    worker,
    { goal, footprint: [{ path: file, op: "create" }] },
    key("land"),
  );
  if (declared.workspace.token === undefined)
    throw new Error("declare answered no workspace token");
  const token = declared.workspace.token;
  const dir = cloneWorkspace(declared.workspace.remote, token);
  dirs.push(dir);
  git(dir, ["checkout", "-q", "-B", "main", "origin/main"]);
  const trunkAtStart = (await worker.commits(project.id, { limit: 1 })).items[0]?.sha ?? "";
  if (git(dir, ["rev-parse", "HEAD"]) !== trunkAtStart) {
    const { result: moved } = await worker.rebase(declared.change.id, {
      lease: declared.lease.id,
      idempotencyKey: key("rebase"),
    });
    git(dir, ["fetch", "-q", "origin", "keel/trunk"], token);
    git(dir, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    console.log(`     the slot was behind trunk: rebased onto ${moved.base.slice(0, 12)}`);
  }
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  const pushed = commitAndPush(dir, token, handle, goal);
  await worker.submit(
    { changeId: declared.change.id, commitSha: pushed },
    { lease: declared.lease.id, idempotencyKey: key("submit") },
  );
  console.log(`     ${declared.change.id} submitted at ${pushed.slice(0, 12)}`);
  const events = await projectEvents(
    worker,
    cursor,
    project.id,
    (seen) =>
      tagged(seen, "ChangeLanded", declared.change.id).length > 0 ||
      tagged(seen, "ChangeBounced", declared.change.id).length > 0,
  );
  const bounce = tagged(events, "ChangeBounced", declared.change.id)[0]?.payload;
  if (bounce !== undefined)
    console.log(`     bounced: ${JSON.stringify(Reflect.get(bounce, "reasons"))}`);
  const landedIt = tagged(events, "ChangeLanded", declared.change.id).length === 1;
  check(landedIt, "(c) the agent's change lands on its project's trunk");
  console.log("\n     chain of the change, with who caused each event and in which run:");
  for (const e of events)
    console.log(
      `     ${line(e)}${e.actor === undefined ? "" : `  by ${e.actor}`}${e.run === undefined ? "" : ` in ${e.run.label ?? e.run.id}`}`,
    );
  const own = events.filter((e) => e.actor === `agent:${agentId}`);
  check(
    own.length > 0 && own.every((e) => e.run?.id === runId && e.run.label === label),
    `(c) each of the ${own.length} events the agent's own commands committed names its run`,
  );
  // Nothing landed: there is no commit of the agent's on trunk to read.
  if (!landedIt) return;
  const landed =
    events.flatMap((e) =>
      e.payload._tag === "ChangeLanded" && e.payload.changeId === declared.change.id
        ? [e.payload.commitSha]
        : [],
    )[0] ?? "";
  const advanced = events.flatMap((e) =>
    e.payload._tag === "TrunkAdvanced" && e.payload.to === landed ? [e.payload] : [],
  )[0];
  check(
    advanced !== undefined && advanced.verified !== false,
    "(c) trunk advanced to the landed commit verified",
  );

  // (d) the landed commit, read with stock git from a workspace granted at trunk's head.
  const reader = await declareWhenPooled(
    worker,
    { goal: `a17 ${label}: read trunk`, footprint: [{ path: file, op: "edit" }] },
    key("reader"),
  );
  if (reader.workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dirR = cloneWorkspace(reader.workspace.remote, reader.workspace.token);
  dirs.push(dirR);
  const signers = await keelSigners(dirR, worker, baseUrl);
  check(
    holdsCommit(dirR, landed) && git(dirR, ["rev-parse", "HEAD"]) === landed,
    "(d) a workspace declared after the landing is granted at the landed commit",
  );
  if (holdsCommit(dirR, landed)) {
    const show = (format: string) => git(dirR, ["log", "-1", `--format=${format}`, landed]);
    const trailer = (name: string) => show(`%(trailers:key=${name},valueonly)`).trim();
    console.log(`     ${signers.show(landed, "%h %G? signed by %GS, committed %cI")}`);
    console.log(`     author    ${show("%an <%ae>")}`);
    console.log(`     committer ${show("%cn <%ce>")}`);
    for (const name of ["Change-Id", "Keel-Agent", "Keel-Run", "Declared-Author"])
      console.log(`     ${name}: ${trailer(name)}`);
    check(
      show("%an <%ae>") === `${handle} <${agentId}@agents.${HOST}>`,
      `(d) it is written by the agent: its handle, at agents.${HOST}`,
    );
    check(
      show("%cn <%ce>") === `Keel <${signers.principal}>`,
      `(d) and committed by Keel <${signers.principal}>`,
    );
    check(trailer("Keel-Agent") === agentId, "(d) its Keel-Agent trailer names the agent");
    check(trailer("Keel-Run") === runId, "(d) its Keel-Run trailer names the run");
    check(
      trailer("Change-Id") === declared.change.id,
      "(d) its Change-Id trailer names the change",
    );
    check(
      trailer("Declared-Author") === `${handle} <${handle}@agents.keel.invalid>`,
      "(d) what the pushed commit said of its author is kept as Declared-Author, and is not the author",
    );
    check(
      git(dirR, ["diff-tree", "--no-commit-id", "--name-only", "-r", landed]) === file &&
        git(dirR, ["show", `${landed}:${file}`]) === text.trim(),
      "(d) it adds the agent's file and nothing else",
    );
  }
  check(
    signers.verifies(signers.published, landed),
    "(d) git verifies it against the signers file Keel publishes at /.well-known/keel/allowed-signers",
  );
  check(
    !signers.verifies(signers.stranger, landed),
    "(d) against a signers file that names another key, git refuses it",
  );
  await worker.abandon(
    reader.change.id,
    {},
    { lease: reader.lease.id, idempotencyKey: key("reader:abandon") },
  );
}

try {
  await landWithOnlyAKey(keelUrl, run);
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
}
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nall a17 checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
