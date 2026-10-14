// The live proof of a rebase against a deployed Keel:
//   KEEL_URL=<keel> KEEL_SESSION=<token> KEEL_NAMESPACE=<handle> node e2e/src/c14.ts <run>
//
// KEEL_SESSION is a user's bearer session, read and never printed. That user
// creates the project in KEEL_NAMESPACE (a namespace it may create projects in: its own
// is named by its handle), sets it up, and sponsors its two agents. In a
// project of its own (c14-rebase, forked from the fixture repo, so S-0's
// projects are untouched), two agents rewrite the same line:
//   (a) the first lands (rebased onto trunk first, when its slot was forked
//       before trunk last moved);
//   (b) the second bounces textually, with `rebase` as its first next action;
//   (c) it rebases (POST /v1/changes/{id}/rebase), merges keel/trunk as the
//       bounce says (`git fetch origin keel/trunk && git merge FETCH_HEAD`),
//       resolves, pushes and submits again, and lands;
//   (d) trunk read back holds the resolution, with the first change below it;
//   (e) b2: every agent push shows one WorkspacePushed from a `<prj>-ws-<ulid>`
//       workspace, and neither the mirror syncs nor the keel/trunk push show any;
//   (f) before merging, the rebased change's old commit, which doesn't descend
//       from its new base, is refused with `rebase` (Precheck);
//   (g) two more changes insert lines in different parts of package.json
//       and both land with no rebase, each merged by hunk onto trunk;
//   (h) the pool keeps its ready workspaces on trunk: both agents' workspaces
//       were granted on trunk's head (after an earlier run's landings, that is
//       the pool's refresh), and no push of Keel's own shows as a
//       WorkspacePushed anywhere in the run;
//   (i) Keel signs what it lands: one more workspace, taken only to read trunk,
//       holds the run's landed commits, and stock git verifies each against
//       the signers file Keel publishes, and none against a file that names
//       another key. Each names Keel at this host as its committer, and as
//       its author the agent whose change it is, under Keel's agents domain,
//       with what the pushed commit said of its author kept as a trailer.
// It ends with each promotion's wall time by trunk's own clock. No remote URL
// or credential is printed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import {
  type Declared,
  type EventRecord,
  declareWhenPooled,
  holdsCommit,
  keelSigners,
  line,
  projectEvents,
  tagged,
} from "./lib/live.ts";

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: c14.ts <run>, the run a lower-case slug");
const needed = (name: string): string => {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(
      `${name} is not set: c14 needs KEEL_URL, KEEL_SESSION (a user's session) and KEEL_NAMESPACE (the project's namespace, by handle)`,
    );
  return value;
};
const keelUrl = needed("KEEL_URL");
const session = needed("KEEL_SESSION");
const ORG = needed("KEEL_NAMESPACE");
const FIXTURE = "fixture-forge-lite";
const PROJECT = "c14-rebase";
const key = (what: string) => `c14:${what}`;
/** Every change of this scenario edits the fixture's package.json. */
const footprint = () => [{ path: "package.json", op: "edit" as const }];

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

/** The time from one event to another, by the clock that wrote them. */
const ms = (from: EventRecord, to: EventRecord) => Date.parse(to.at) - Date.parse(from.at);

/**
 * Each promotion's wall time by trunk's own clock, one line per group: from
 * PromotionStarted to PromotionComposed, and on to the TrunkAdvanced or
 * PromotionDeclined that ended it. The push pass between the last two weighs
 * the group's pack, admits it against its org's repo bytes, pushes it and
 * reads trunk back.
 */
function promotionTimes(events: readonly EventRecord[]): string[] {
  const lines: string[] = [];
  let started: EventRecord | undefined;
  let composed: EventRecord | undefined;
  for (const e of events) {
    const tag = e.payload._tag;
    if (tag === "PromotionStarted") [started, composed] = [e, undefined];
    if (tag === "PromotionComposed") composed = e;
    if ((tag === "TrunkAdvanced" || tag === "PromotionDeclined") && started !== undefined) {
      const push = composed === undefined ? "" : `, composed to end ${ms(composed, e)} ms`;
      lines.push(`${tag} ${ms(started, e)} ms after PromotionStarted${push}`);
      started = undefined;
    }
  }
  return lines;
}

/** The repo name at the end of a workspace's remote; the host, which carries the account id, is dropped. */
const repoName = (remote: string) => (remote.split("/").pop() ?? "").replace(/\.git$/, "");

/** Rewrites package.json's description, as S-0's same-line case does. */
function describeAs(dir: string, text: string): void {
  const path = join(dir, "package.json");
  const before = readFileSync(path, "utf8");
  const after = before.replace(/"description": "[^"]*",/, `"description": "${text}",`);
  if (after === before) throw new Error("package.json has no description line to change");
  writeFileSync(path, after);
}

/**
 * The run's agent by that name: enrolled once, and found again by the key on
 * every later run. The key's last part is its generation: an enrolment is
 * replayed only while Keel reads the request as it first did, so a deploy
 * that changes what an enrolment holds needs the next one.
 */
async function enrolled(operator: KeelClient, name: string, projectId: string) {
  const agent = await operator.enrolAgent(
    { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId },
    { idempotencyKey: key(`agent:${name}:2`) },
  );
  return new KeelClient({
    baseUrl: keelUrl,
    clientId: agent.clientId,
    clientSecret: agent.clientSecret,
  });
}

const dirs: string[] = [];
try {
  const operator = new KeelClient({ baseUrl: keelUrl, session });
  // Made once, and found by its name on every later run. A key replays only while Keel reads
  // the request as it first did, and a deploy has changed how a project's start is written.
  const project =
    (await operator.project(ORG, PROJECT).catch((error: unknown) => {
      if (error instanceof KeelProblem && error.status === 404) return undefined;
      throw error;
    })) ??
    (await operator.createProject(
      { namespace: ORG, name: PROJECT, source: { kind: "template", name: FIXTURE } },
      { idempotencyKey: key("project:2") },
    ));
  await operator.putSettings(project.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  console.log(`     project ${ORG}/${PROJECT}: ${project.id}`);
  const first = await enrolled(operator, "c14-first", project.id);
  const second = await enrolled(operator, "c14-second", project.id);
  // The snapshot's cursor is the head of the log: an agent's page of events is one window of
  // the whole log filtered to its project, so an empty page is not the end of it.
  const { cursor } = await first.snapshot({ project: project.id });
  console.log(`     feed cursor ${cursor}`);

  const a: Declared = await declareWhenPooled(
    first,
    { goal: `rebase ${run}: first`, footprint: footprint() },
    `c14:${run}:a`,
  );
  const b: Declared = await declareWhenPooled(
    second,
    { goal: `rebase ${run}: second`, footprint: footprint() },
    `c14:${run}:b`,
  );
  for (const [who, d] of [
    ["first", a],
    ["second", b],
  ] as const)
    console.log(`     ${who}: ${d.change.id} in ${repoName(d.workspace.remote)}`);
  if (a.workspace.token === undefined || b.workspace.token === undefined)
    throw new Error("declare answered no workspace token");
  const tokenA = a.workspace.token;
  const tokenB = b.workspace.token;

  const dirA = cloneWorkspace(a.workspace.remote, tokenA);
  const dirB = cloneWorkspace(b.workspace.remote, tokenB);
  dirs.push(dirA, dirB);
  // A workspace is granted at trunk's head, whenever trunk last moved: (h) holds it to that.
  // Where it fails, the first change is rebased onto trunk so the rest of the run still reads.
  const trunkAtStart = (await first.commits(project.id, { limit: 1 })).items[0]?.sha ?? "";
  for (const [who, dir] of [
    ["first", dirA],
    ["second", dirB],
  ] as const)
    console.log(
      `     ${who}'s base ${git(dir, ["rev-parse", "HEAD"]).slice(0, 12)}, trunk's head ${trunkAtStart.slice(0, 12)}`,
    );
  check(
    [dirA, dirB].every((dir) => git(dir, ["rev-parse", "HEAD"]) === trunkAtStart),
    "(h) both workspaces were granted on trunk's head",
  );
  if (git(dirA, ["rev-parse", "HEAD"]) !== trunkAtStart) {
    const { result: moved } = await first.rebase(a.change.id, {
      lease: a.lease.id,
      idempotencyKey: `c14:${run}:a:rebase`,
    });
    git(dirA, ["fetch", "-q", "origin", "keel/trunk"], tokenA);
    git(dirA, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    console.log(`     first's slot was behind trunk: rebased onto ${moved.base.slice(0, 12)}`);
  }
  const textA = `forge-lite, as the first agent left it in rebase run ${run}`;
  const textB = `forge-lite, as the second agent left it in rebase run ${run}`;
  describeAs(dirA, textA);
  describeAs(dirB, textB);
  const shaA = commitAndPush(dirA, tokenA, "c14-first", `rebase ${run}: first`);
  const shaB = commitAndPush(dirB, tokenB, "c14-second", `rebase ${run}: second`);

  // (a) the first lands.
  await first.submit(
    { changeId: a.change.id, commitSha: shaA },
    { lease: a.lease.id, idempotencyKey: `c14:${run}:a:submit` },
  );
  console.log(`     first submitted at ${shaA.slice(0, 12)}`);
  let events = await projectEvents(
    first,
    cursor,
    project.id,
    (seen) =>
      tagged(seen, "ChangeLanded", a.change.id).length > 0 ||
      tagged(seen, "ChangeBounced", a.change.id).length > 0,
  );
  check(tagged(events, "ChangeLanded", a.change.id).length === 1, "(a) the first change lands");

  // (b) the second, made on the old base, bounces textually.
  await second.submit(
    { changeId: b.change.id, commitSha: shaB },
    { lease: b.lease.id, idempotencyKey: `c14:${run}:b:submit` },
  );
  console.log(`     second submitted at ${shaB.slice(0, 12)}`);
  events = await projectEvents(
    first,
    cursor,
    project.id,
    (seen) =>
      tagged(seen, "ChangeBounced", b.change.id).length > 0 ||
      tagged(seen, "ChangeLanded", b.change.id).length > 0,
  );
  const bounce = tagged(events, "ChangeBounced", b.change.id)[0]?.payload;
  const actions: readonly { readonly operationId?: string; readonly title: string }[] =
    bounce === undefined ? [] : (Reflect.get(bounce, "nextActions") ?? []);
  console.log(`     reasons: ${JSON.stringify(bounce && Reflect.get(bounce, "reasons"))}`);
  for (const next of actions) console.log(`     next: ${next.operationId ?? ""} "${next.title}"`);
  check(bounce !== undefined, "(b) the second change bounces");
  check(actions[0]?.operationId === "rebase", "(b) its first next action is rebase");
  check(
    actions.some((n) => n.title.includes("git fetch origin keel/trunk && git merge FETCH_HEAD")),
    "(b) a next action names the merge commands",
  );

  // (c) rebase, merge keel/trunk, resolve, push, submit again.
  const { result: rebased } = await second.rebase(b.change.id, {
    lease: b.lease.id,
    idempotencyKey: `c14:${run}:b:rebase`,
  });
  const trunkHead = rebased.base;
  console.log(`     rebased: ref ${rebased.ref}, base ${trunkHead.slice(0, 12)}`);
  git(dirB, ["fetch", "-q", "origin", "keel/trunk"], tokenB);
  check(git(dirB, ["rev-parse", "FETCH_HEAD"]) === trunkHead, "(c) keel/trunk is trunk's head");

  // (f) the old commit doesn't descend from the new base: refused with rebase.
  await second.submit(
    { changeId: b.change.id, commitSha: shaB },
    { lease: b.lease.id, idempotencyKey: `c14:${run}:b:off-base` },
  );
  events = await projectEvents(
    first,
    cursor,
    project.id,
    (seen) => tagged(seen, "ChangeBounced", b.change.id).length > 1,
  );
  const offBase = tagged(events, "ChangeBounced", b.change.id)[1]?.payload;
  const offBaseActions: readonly { readonly operationId?: string; readonly title: string }[] =
    offBase === undefined ? [] : (Reflect.get(offBase, "nextActions") ?? []);
  console.log(`     off base: ${JSON.stringify(offBase && Reflect.get(offBase, "reasons"))}`);
  for (const next of offBaseActions)
    console.log(`     next: ${next.operationId ?? ""} "${next.title}"`);
  check(offBase !== undefined, "(f) the unmerged commit is refused");
  check(
    offBaseActions.some((n) => n.operationId === "rebase"),
    "(f) the refusal names rebase",
  );
  const identity = [
    "-c",
    "user.name=c14-second",
    "-c",
    "user.email=c14-second@agents.keel.invalid",
  ];
  let conflicted = false;
  try {
    git(dirB, [...identity, "merge", "-q", "FETCH_HEAD"]);
  } catch {
    conflicted = true;
  }
  check(conflicted, "(c) merging keel/trunk conflicts on the line both changed");
  const resolved = `forge-lite, as both agents left it in rebase run ${run}`;
  git(dirB, ["checkout", "--theirs", "package.json"]);
  describeAs(dirB, resolved);
  git(dirB, ["add", "package.json"]);
  git(dirB, [...identity, "commit", "-q", "--no-edit"]);
  git(dirB, ["push", "-q", "origin", "HEAD:refs/heads/main"], tokenB);
  const shaMerge = git(dirB, ["rev-parse", "HEAD"]);
  console.log(`     merged and pushed ${shaMerge.slice(0, 12)}`);
  await second.submit(
    { changeId: b.change.id, commitSha: shaMerge },
    { lease: b.lease.id, idempotencyKey: `c14:${run}:b:resubmit` },
  );
  events = await projectEvents(
    first,
    cursor,
    project.id,
    (seen) =>
      tagged(seen, "ChangeLanded", b.change.id).length > 0 ||
      tagged(seen, "ChangeBounced", b.change.id).length > 2,
  );
  check(tagged(events, "ChangeRebased", b.change.id).length === 1, "(c) ChangeRebased once");
  check(tagged(events, "ChangeLanded", b.change.id).length === 1, "(c) the rebased change lands");
  check(tagged(events, "TrunkAdvanced").length === 2, "(c) trunk advanced twice");

  // (d) trunk read back.
  const blob = await first.blob(project.id, "package.json");
  const text = String(Reflect.get(Object(blob), "content") ?? "");
  check(text.includes(resolved), "(d) trunk's package.json holds the resolution");
  const commits = await first.commits(project.id, { limit: 3 });
  const history = commits.items.map((c) => `${c.sha.slice(0, 12)} ${c.message.split("\n")[0]}`);
  console.log(`     trunk: ${history.join(" | ")}`);

  // (e) b2: one WorkspacePushed per agent push, none for the mirror or keel/trunk.
  const pushed = tagged(events, "WorkspacePushed");
  for (const e of pushed) console.log(`     ${line(e)}`);
  const pushedShas = pushed.map((e) => String(Reflect.get(e.payload, "sha"))).toSorted();
  check(
    JSON.stringify(pushedShas) === JSON.stringify([shaA, shaB, shaMerge].toSorted()),
    "(e) WorkspacePushed for exactly the three agent pushes",
  );
  check(
    pushed.every((e) => Reflect.get(e.payload, "ref") === "refs/heads/main"),
    "(e) no WorkspacePushed for refs/heads/keel/trunk",
  );
  check(
    [a, b].every((d) =>
      new RegExp(`^${project.id.replace("_", "-").toLowerCase()}-ws-[0-9a-z]{26}$`).test(
        repoName(d.workspace.remote),
      ),
    ),
    "(e) both workspaces are named <prj>-ws-<ulid>",
  );

  // (g) two changes to different parts of one file both land, no rebase.
  const hunks = [
    {
      client: first,
      who: "first",
      after: '  "license": "MIT",\n',
      line: `  "keywords": ["c14-${run}-d"],\n`,
    },
    { client: second, who: "second", after: "{\n", line: `  "author": "c14-${run}-e",\n` },
  ];
  const declaredHunks: Declared[] = [];
  const hunkShas: string[] = [];
  for (const [i, h] of hunks.entries()) {
    const d = await declareWhenPooled(
      h.client,
      { goal: `hunks ${run}: ${i}`, footprint: footprint() },
      `c14:${run}:hunk${i}`,
    );
    if (d.workspace.token === undefined) throw new Error("declare answered no workspace token");
    const dir = cloneWorkspace(d.workspace.remote, d.workspace.token);
    dirs.push(dir);
    console.log(`     hunk change ${i}'s base ${git(dir, ["rev-parse", "HEAD"]).slice(0, 12)}`);
    const path = join(dir, "package.json");
    const before = readFileSync(path, "utf8");
    if (!before.includes(h.after))
      throw new Error(`package.json has no ${JSON.stringify(h.after)}`);
    writeFileSync(path, before.replace(h.after, `${h.after}${h.line}`));
    const sha = commitAndPush(dir, d.workspace.token, `c14-${h.who}`, `hunks ${run}: ${i}`);
    await h.client.submit(
      { changeId: d.change.id, commitSha: sha },
      { lease: d.lease.id, idempotencyKey: `c14:${run}:hunk${i}:submit` },
    );
    console.log(`     hunk change ${i}: ${d.change.id} submitted at ${sha.slice(0, 12)}`);
    declaredHunks.push(d);
    hunkShas.push(sha);
  }
  events = await projectEvents(first, cursor, project.id, (seen) =>
    declaredHunks.every(
      (d) =>
        tagged(seen, "ChangeLanded", d.change.id).length > 0 ||
        tagged(seen, "ChangeBounced", d.change.id).length > 0,
    ),
  );
  for (const d of declaredHunks) {
    const bounced = tagged(events, "ChangeBounced", d.change.id)[0]?.payload;
    if (bounced !== undefined)
      console.log(
        `     ${d.change.id} bounced: ${JSON.stringify(Reflect.get(bounced, "reasons"))}`,
      );
  }
  check(
    declaredHunks.every((d) => tagged(events, "ChangeLanded", d.change.id).length === 1),
    "(g) both same-file changes land",
  );
  check(
    declaredHunks.every((d) => tagged(events, "ChangeRebased", d.change.id).length === 0),
    "(g) neither was rebased",
  );
  const merged = String(
    Reflect.get(Object(await first.blob(project.id, "package.json")), "content") ?? "",
  );
  check(
    hunks.every((h) => merged.includes(h.line)) && merged.includes(resolved),
    "(g) trunk's package.json holds both inserted lines and the earlier resolution",
  );

  const agentPushes = new Set([shaA, shaB, shaMerge, ...hunkShas]);
  const notAgents = tagged(events, "WorkspacePushed").filter(
    (e) => !agentPushes.has(String(Reflect.get(e.payload, "sha"))),
  );
  for (const e of notAgents) console.log(`     not an agent's: ${line(e)}`);
  check(notAgents.length === 0, "(h) every WorkspacePushed in the run is an agent's push");

  // (i) Keel signs what it lands. The reader is declared as soon as the last landing is read,
  // before the pool's own refresh may have run: its workspace is granted at trunk's head all
  // the same, so its plain clone holds everything the run landed. It is abandoned once read.
  const reader = await declareWhenPooled(
    first,
    { goal: `rebase ${run}: read trunk`, footprint: footprint() },
    `c14:${run}:reader`,
  );
  if (reader.workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dirR = cloneWorkspace(reader.workspace.remote, reader.workspace.token);
  dirs.push(dirR);
  const landed = (await first.commits(project.id, { limit: 4 })).items.map((c) => c.sha);
  const held = landed.filter((sha) => holdsCommit(dirR, sha));
  const { principal, published, stranger, verifies, show } = await keelSigners(
    dirR,
    first,
    keelUrl,
  );
  for (const sha of held)
    console.log(`     ${show(sha, "%h %G? signed by %GS, committed by %cn <%ce> %cI")}`);
  check(
    git(dirR, ["rev-parse", "HEAD"]) === landed[0],
    "(i) the reader's workspace, declared as the last change landed, was granted at trunk's head",
  );
  check(
    held.length === landed.length && landed.length === 4,
    `(i) the reader's workspace holds ${held.length} of the 4 landed commits`,
  );
  check(
    held.every((sha) => verifies(published, sha)),
    "(i) git verifies every landed commit against Keel's published signers file",
  );
  check(
    held.every((sha) => !verifies(stranger, sha)),
    "(i) against a signers file that names another key, git verifies none of them",
  );
  check(
    held.every(
      (sha) => git(dirR, ["log", "-1", "--format=%cn <%ce>", sha]) === `Keel <${principal}>`,
    ),
    `(i) each names Keel <${principal}> as its committer`,
  );
  // Who landed what: each change's agent, as Keel authenticated it, never what its commit says.
  const [firstId = "", secondId = ""] = await Promise.all(
    [first, second].map(async (client) => (await client.whoami()).result.agent.id),
  );
  const agentOf = new Map([
    [a.change.id, firstId],
    [b.change.id, secondId],
    ...declaredHunks.map((d, i): [string, string] => [d.change.id, i === 0 ? firstId : secondId]),
  ]);
  const trailer = (sha: string, name: string) =>
    git(dirR, ["log", "-1", `--format=%(trailers:key=${name},valueonly)`, sha]).trim();
  const agentsHost = `agents.${new URL(keelUrl).host}`;
  for (const sha of held)
    console.log(
      `     ${git(dirR, ["log", "-1", "--format=%h author %an <%ae>", sha])}; declared ${trailer(sha, "Declared-Author")}`,
    );
  check(
    held.every((sha) => {
      const agent = agentOf.get(trailer(sha, "Change-Id"));
      return (
        agent !== undefined &&
        trailer(sha, "Keel-Agent") === agent &&
        git(dirR, ["log", "-1", "--format=%ae", sha]) === `${agent}@${agentsHost}`
      );
    }),
    `(i) each is authored by the agent whose change it is, at ${agentsHost}, and names it in Keel-Agent`,
  );
  check(
    held.every((sha) =>
      /^c14-(first|second) <c14-(first|second)@agents\.keel\.invalid>$/.test(
        trailer(sha, "Declared-Author"),
      ),
    ),
    "(i) each keeps what its pushed commit said of its author, as Declared-Author",
  );
  await first.abandon(
    reader.change.id,
    {},
    { lease: reader.lease.id, idempotencyKey: `c14:${run}:reader:abandon` },
  );

  console.log("\n     chain:");
  for (const e of events) console.log(`     ${line(e)}`);
  console.log("\n     promotions:");
  for (const timed of promotionTimes(events)) console.log(`     ${timed}`);
} catch (error) {
  if (error instanceof KeelProblem) {
    // The request id is what finds this failure in Keel's logs.
    console.log(
      `FAIL ${error.message} (${error.status}, request ${error.requestId}, ${new Date().toISOString()})`,
    );
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall rebase checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
