// An invited agent's commit on a deployed Keel, through the API alone: it
// edits its change's workspace with no clone, a commit on a head that moved
// is refused, and the commit it made lands.
//   KEEL_URL=<keel> node e2e/src/commit.ts <run>
//
// It takes no credential. A person, `cmt-<run>-p`, signs up by passkey and
// makes a private project, `commit`, in their own namespace from Keel's
// fixture template. An agent that holds nothing but a key signs itself up,
// the person invites it to that one project, it accepts, and the token it
// asks for that project reads it. Then, as that agent with that token, by
// the SDK alone and never a clone:
//   (1) it declares a change whose footprint is one file of the fixture: 201,
//       and the change's base, which the 201's workspace names and the
//       change's ChangeStarted on the project's feed agrees with;
//   (2) it reads that file at the base through the repo API and commits one
//       edit with the base as `expectedHead`: 200, a commit whose parent is
//       the base;
//   (2a) a second agent, invited to the same project, commits on that change
//       and refreshes its workspace's token, the lease's id in hand: each
//       is 404, change.not_found and workspace.not_found;
//   (2b) the change's own agent refreshes the token: 200, the same
//       workspace and remote with a new token, and a stock `git ls-remote`
//       of the remote with that token shows the workspace's main at the
//       first commit;
//   (2c) the file read at the base again is the same answer;
//   (3) it commits other edits on the base again, now stale, under another
//       key: refused 409 workspace.head_moved, naming the first commit as
//       the head now;
//   (4) it submits the first commit and long-polls the change's status: it
//       lands within six minutes, and the time from submit to landed is
//       printed;
//   (5) trunk compared from the base to its head lists that file and no
//       other, with the first edit in it and not the refused one.
// The edit is a comment line at the end of src/domain/visibility.ts. No test
// reads the file as text and the lockfile is untouched, so the project's
// verification, its vitest suite, passes it as it passes the template.
//
// Each run needs a run of its own, since a handle is taken for good. It
// leaves behind the person's account with its one project, whose trunk holds
// the landed commit, and the agent, joined to that project, whose key is gone
// with the run. No session, passkey, key or token is printed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateAgentKey, KeelClient, KeelProblem, signUp as signUpByKey } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import { declareWhenPooled } from "./lib/live.ts";
import { brief, FIXTURE, feedOf } from "./lib/s1.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: commit.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");
const PERSON = `cmt-${run}-p`;
const PROJECT = "commit";
/** The one file the change edits: a small source file of the fixture. */
const FILE = "src/domain/visibility.ts";
/** How long the feed is read for the change's ChangeStarted. */
const STARTED_MS = 60_000;
/** How long the submitted change has to land. */
const LANDING_MS = 6 * 60_000;
/** Where a submission ends: from these it moves no further. */
const SETTLED: ReadonlySet<string> = new Set(["landed", "bounced", "withdrawn", "superseded"]);
const key = (what: string) => `commit:${run}:${what}`;
const short = (sha: string | undefined) => sha?.slice(0, 8) ?? "none";
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures += 1;
};

/** The status of the last answer the agent's clients read: the SDK hands back only the body. */
let answered = 0;
const recorded = async (input: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  answered = response.status;
  return response;
};

/** An agent that signed itself up with a key: a client for its own account, and one whose tokens name a project. */
async function keyAgent(name: string) {
  const { signer } = await generateAgentKey();
  const account = await signUpByKey({ baseUrl: keelUrl, signer, name });
  console.log(`     agent ${account.handle} signed up by key: ${account.agentId}`);
  const client = (project?: string) =>
    new KeelClient({
      baseUrl: keelUrl,
      agentId: account.agentId,
      key: signer,
      run: "commit",
      fetch: recorded,
      ...(project === undefined ? {} : { project }),
    });
  return { ...account, own: client(), in: client };
}

/** The problem `act` was refused with, or undefined when it was answered. */
async function refusalOf(act: () => Promise<unknown>): Promise<KeelProblem | undefined> {
  try {
    await act();
    return undefined;
  } catch (error) {
    if (!(error instanceof KeelProblem)) throw error;
    return error;
  }
}

/** The refs a stock git sees at `remote`, presenting `token` as git's bearer. */
async function lsRemote(remote: string, token: string): Promise<Map<string, string>> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "ls-remote", remote],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  return new Map(
    stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [sha = "", ref = ""] = line.split("\t");
        return [ref, sha] as const;
      }),
  );
}

/** Long-polls a submitted change's status until it settles or `ms` passes, reading again past a server fault or two. */
async function settle(worker: KeelClient, changeId: string, ms: number) {
  const deadline = Date.now() + ms;
  let submission: Awaited<ReturnType<KeelClient["status"]>>["result"] | undefined;
  let faults = 0;
  while ((submission === undefined || !SETTLED.has(submission.state)) && Date.now() < deadline) {
    const wait = Math.max(0, Math.min(30, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      // oxlint-disable-next-line no-await-in-loop -- a long-poll asks again only once the last answer is read
      submission = (await worker.status(changeId, { wait })).result;
      faults = 0;
    } catch (error) {
      faults += 1;
      if (!(error instanceof KeelProblem) || error.status < 500 || faults === 3) throw error;
      console.log(`     a status read answered ${error.status} ${error.code}; reading again`);
      // oxlint-disable-next-line no-await-in-loop -- the pause before reading again is the point
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return submission;
}

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const { userId, namespace } = account.session;
  console.log(`     ${PERSON} signed up by passkey: ${userId}`);
  const person = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  const project = await person.createProject(
    { namespace, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  check(
    project.namespace.kind === "user" &&
      project.namespace.handle === PERSON &&
      project.visibility === "private",
    `the person makes ${PERSON}/${PROJECT} from ${FIXTURE}, private, in their own namespace: ${project.id}`,
  );

  const agent = await keyAgent(`cmt-${run}-agent`);
  const invited = await person.inviteToProject(project.id, agent.handle, {
    idempotencyKey: key("invite"),
  });
  const joined = await agent.own.acceptProjectInvitation(project.id, {
    idempotencyKey: key("accept"),
  });
  check(
    invited.state === "invited" && joined.state === "joined",
    `the person invites the agent to that one project and it accepts: ${invited.state}, then ${joined.state}`,
  );
  const worker = agent.in(project.id);
  const trunkAtStart = (await worker.commits(project.id, { limit: 1 })).items[0]?.sha;
  check(
    answered === 200 && trunkAtStart !== undefined,
    `the agent's token for that project reads it: ${answered}, trunk at ${short(trunkAtStart)}`,
  );

  // (1) a change on one file, and its base.
  const { cursor } = await worker.snapshot({ project: project.id });
  const declared = await declareWhenPooled(
    worker,
    {
      goal: `commit ${run}: a comment in ${FILE}, committed through the API`,
      footprint: [{ path: FILE, op: "edit" }],
    },
    key("declare"),
  );
  const declaredWith = answered;
  const changeId = declared.change.id;
  const lease = declared.lease.id;
  const feed = feedOf(worker, { project: project.id, ...(cursor === undefined ? {} : { cursor }) });
  const baseOf = () =>
    feed.seen.flatMap((e) =>
      e.payload._tag === "ChangeStarted" && e.payload.changeId === changeId
        ? [e.payload.baseSha]
        : [],
    )[0];
  await feed.until(() => baseOf() !== undefined, STARTED_MS);
  const base = declared.workspace.baseSha;
  check(
    declaredWith === 201 && base === baseOf() && declared.change.state === "working",
    `(1) declare: ${declaredWith}, ${changeId} ${declared.change.state}, the workspace's base ${short(base)}, as its ChangeStarted says (${short(baseOf())}; trunk was at ${short(trunkAtStart)})`,
  );
  if (base === undefined) return;

  // (2) the file at the base, and one commit on it.
  const blob = await worker.blob(project.id, FILE, { ref: base });
  const before = blob.content;
  check(
    answered === 200 && blob.commit === base && before !== undefined,
    `(2) the repo API reads ${FILE} at the base: ${answered}, ${blob.size} bytes at ${short(blob.commit)}`,
  );
  if (before === undefined) return;
  const ending = before.endsWith("\n") ? before : `${before}\n`;
  const kept = `${ending}// Committed through Keel's API with no clone, in run ${run}.\n`;
  const refused = `${ending}// Committed on a head that had moved, in run ${run}: never written.\n`;
  const { result: first } = await worker.commitEdits(
    changeId,
    {
      expectedHead: base,
      message: `Note in ${FILE} that it was committed through the API`,
      edits: [{ path: FILE, content: kept }],
    },
    { lease, idempotencyKey: key("commit") },
  );
  check(
    answered === 200 &&
      first.parent === base &&
      /^[0-9a-f]{40}$/.test(first.commitSha) &&
      first.commitSha !== base &&
      first.changed === 1,
    `(2) commitEdits on expectedHead ${short(base)}: ${answered}, commitSha ${short(first.commitSha)}, parent ${short(first.parent)}, ${first.changed} path(s) changed`,
  );

  // (2a) another agent in the project, holding the lease's id.
  const stranger = await keyAgent(`cmt-${run}-other`);
  await person.inviteToProject(project.id, stranger.handle, {
    idempotencyKey: key("invite:other"),
  });
  await stranger.own.acceptProjectInvitation(project.id, { idempotencyKey: key("accept:other") });
  const other = stranger.in(project.id);
  const strangersCommit = await refusalOf(() =>
    other.commitEdits(
      changeId,
      {
        expectedHead: first.commitSha,
        message: `Note in ${FILE} something, as another agent`,
        edits: [{ path: FILE, content: refused }],
      },
      { lease, idempotencyKey: key("commit:other") },
    ),
  );
  const strangersRefresh = await refusalOf(() =>
    other.refreshWorkspaceToken(declared.workspace.id, {
      lease,
      idempotencyKey: key("refresh:other"),
    }),
  );
  check(
    strangersCommit?.status === 404 &&
      strangersCommit.code === "change.not_found" &&
      strangersRefresh?.status === 404 &&
      strangersRefresh.code === "workspace.not_found",
    `(2a) another agent in the project, with the lease's id: commitEdits ${strangersCommit === undefined ? "answered" : `${strangersCommit.status} ${strangersCommit.code}`}, refreshWorkspaceToken ${strangersRefresh === undefined ? "answered" : `${strangersRefresh.status} ${strangersRefresh.code}`}`,
  );

  // (2b) the change's own agent refreshes its token, and git reads the workspace with it.
  const refreshed = await worker.refreshWorkspaceToken(declared.workspace.id, {
    lease,
    idempotencyKey: key("refresh"),
  });
  const refreshedWith = answered;
  const refs =
    refreshed.token === undefined
      ? new Map<string, string>()
      : await lsRemote(refreshed.remote, refreshed.token);
  check(
    refreshedWith === 200 &&
      refreshed.id === declared.workspace.id &&
      refreshed.remote === declared.workspace.remote &&
      refreshed.token !== undefined &&
      refreshed.token !== declared.workspace.token &&
      refreshed.baseSha === base,
    `(2b) refreshWorkspaceToken: ${refreshedWith}, the same workspace and remote, ${refreshed.token === undefined ? "no token" : refreshed.token === declared.workspace.token ? "the same token" : "a new token"}, expiring ${refreshed.expiresAt}`,
  );
  check(
    refs.get("refs/heads/main") === first.commitSha,
    `(2b) git ls-remote with the new token: main at ${short(refs.get("refs/heads/main"))} (the first commit is ${short(first.commitSha)}), ${refs.size} ref(s)`,
  );

  // (2c) the file at the base, read again.
  const again = await worker.blob(project.id, FILE, { ref: base });
  check(
    answered === 200 &&
      again.commit === base &&
      again.content === before &&
      again.size === blob.size,
    `(2c) ${FILE} at the base read again: ${answered}, ${again.content === before ? "the same" : "other"} content at ${short(again.commit)}`,
  );

  // (3) the same expectedHead again, now stale, with other edits under another key.
  let refusal: KeelProblem | undefined;
  try {
    await worker.commitEdits(
      changeId,
      {
        expectedHead: base,
        message: `Note in ${FILE} something else, on a head that moved`,
        edits: [{ path: FILE, content: refused }],
      },
      { lease, idempotencyKey: key("commit:stale") },
    );
  } catch (error) {
    if (!(error instanceof KeelProblem)) throw error;
    refusal = error;
  }
  const headNow = /moved from [0-9a-f]{40} to ([0-9a-f]{40})/.exec(refusal?.body.detail ?? "")?.[1];
  check(
    refusal?.status === 409 &&
      refusal.code === "workspace.head_moved" &&
      headNow === first.commitSha,
    `(3) commitEdits on the stale ${short(base)}: ${refusal === undefined ? `${answered}, not refused` : `${refusal.status} ${refusal.code}`}, naming the head now ${short(headNow)} (the first commit is ${short(first.commitSha)})`,
  );

  // (4) the first commit, submitted, lands.
  const submittedAt = Date.now();
  const submitted = await worker.submit(
    { changeId, commitSha: first.commitSha },
    { lease, idempotencyKey: key("submit") },
  );
  const submittedWith = answered;
  const settled = await settle(worker, changeId, LANDING_MS);
  const took = Date.now() - submittedAt;
  if (settled?.state === "bounced")
    console.log(`     bounced: ${brief(settled.verdict?.reasons ?? "no verdict")}`);
  check(
    submittedWith === 202 &&
      submitted.result.commitSha === first.commitSha &&
      settled?.state === "landed",
    `(4) submit ${short(first.commitSha)}: ${submittedWith}; ${settled?.state ?? "no status"} after ${seconds(took)}${settled?.state === "landed" ? " (submit to landed)" : `, of ${seconds(LANDING_MS)}`}`,
  );
  if (settled?.state !== "landed") return;

  // (5) trunk from the base to its head now.
  const landedHead = (await worker.commits(project.id, { limit: 1 })).items[0]?.sha ?? "";
  const compared = await worker.compare(project.id, base, { head: landedHead });
  const comparedWith = answered;
  const file = compared.files.find((f) => f.path === FILE);
  const holdsKept = file?.after === kept;
  const holdsRefused = file?.after === refused;
  check(
    comparedWith === 200 &&
      landedHead !== base &&
      compared.base === base &&
      compared.head === landedHead &&
      compared.files.length === 1 &&
      file?.status === "modified" &&
      holdsKept,
    `(5) compare ${short(base)}..${short(landedHead)}: ${comparedWith}, ${compared.files.length} file(s): ${compared.files.map((f) => `${f.path} ${f.status}`).join(", ") || "none"}; ${FILE} after is ${holdsKept ? "the first edit" : holdsRefused ? "the refused edit" : "neither edit"}`,
  );
}

try {
  await walk();
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`✗ stopped: ${error.status} ${error.code}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else if (error instanceof AccountRefused) console.log(`✗ stopped: ${error.message}`);
  else console.log(`✗ stopped: ${error instanceof Error ? error.name : "an error"}`);
  failures += 1;
}
console.log(failures === 0 ? "\nevery check holds" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
