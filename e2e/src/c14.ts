// C1.4's live proof against a deployed Keel: node e2e/src/c14.ts <run> [env]
//
// In a project of its own (c14-rebase, forked from the seeded fixture repo, so
// S-0's projects are untouched), two agents rewrite the same line:
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
//       and both land with no rebase, each merged by hunk onto trunk.
// The operator credential comes from `.keel/<env>.json` under KEEL_SEEDED_ROOT
// (the repo root by default). No remote URL or credential is printed.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import { readSeeded, userClient } from "./lib/seeded.ts";

const [run, environment = "staging"] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: c14.ts <run> [env], the run a lower-case slug");
const root =
  process.env["KEEL_SEEDED_ROOT"] ??
  execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const FIXTURE = "fixture-forge-lite";
const PROJECT = "c14-rebase";
const SETTLE_MS = 15 * 60_000;
const key = (what: string) => `c14:${environment}:${what}`;

const seeded = readSeeded(root, environment);
const keelUrl = process.env["KEEL_URL"] ?? seeded.keelUrl;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

type EventRecord = Awaited<ReturnType<KeelClient["events"]>>["items"][number];
type Declared = Awaited<ReturnType<KeelClient["declare"]>>["result"];

/** The project's events after `cursor`, read until `done` holds or the deadline passes. */
async function projectEvents(
  reader: KeelClient,
  cursor: string,
  projectId: string,
  done: (events: readonly EventRecord[]) => boolean,
): Promise<EventRecord[]> {
  const seen: EventRecord[] = [];
  const deadline = Date.now() + SETTLE_MS;
  let at = cursor;
  while (Date.now() < deadline) {
    const page = await reader.events({ cursor: at, limit: 500 });
    at = page.nextCursor;
    seen.push(...page.items.filter((e) => e.project === projectId));
    if (done(seen)) break;
    if (page.items.length === 0) await new Promise((r) => setTimeout(r, 3_000));
  }
  return seen;
}

const tagged = (events: readonly EventRecord[], tag: string, changeId?: string) =>
  events.filter(
    (e) =>
      e.payload._tag === tag &&
      (changeId === undefined || Reflect.get(e.payload, "changeId") === changeId),
  );

/** One line per event, ids and shas short, as e2e:chain prints them. */
function line(e: EventRecord): string {
  const keep = ["changeId", "workspaceId", "ref", "sha", "commitSha", "base", "from", "to", "head"];
  const parts = keep.flatMap((k) => {
    const v = Reflect.get(e.payload, k);
    if (typeof v !== "string") return [];
    return [`${k}=${/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 12) : v}`];
  });
  const landings: unknown = Reflect.get(e.payload, "landings");
  if (Array.isArray(landings))
    parts.push(
      `landings=[${landings.map((l) => `${String(Reflect.get(Object(l), "changeId"))}@${String(Reflect.get(Object(l), "commitSha")).slice(0, 12)}`).join(", ")}]`,
    );
  return `${e.at}  ${e.payload._tag.padEnd(22)} ${parts.join(" ")}`;
}

/** The repo name at the end of a workspace's remote; the host, which carries the account id, is dropped. */
const repoName = (remote: string) => (remote.split("/").pop() ?? "").replace(/\.git$/, "");

async function declareWhenPooled(client: KeelClient, goal: string, idempotencyKey: string) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    try {
      return (
        await client.declare(
          { goal, footprint: [{ path: "package.json", op: "edit" }], premises: [] },
          { idempotencyKey },
        )
      ).result;
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

/** Rewrites package.json's description, as S-0's same-line case does. */
function describeAs(dir: string, text: string): void {
  const path = join(dir, "package.json");
  const before = readFileSync(path, "utf8");
  const after = before.replace(/"description": "[^"]*",/, `"description": "${text}",`);
  if (after === before) throw new Error("package.json has no description line to change");
  writeFileSync(path, after);
}

async function enrolled(operator: KeelClient, name: string, projectId: string) {
  const agent = await operator.enrolAgent(
    { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId },
    { idempotencyKey: key(`agent:${name}`) },
  );
  return new KeelClient({
    baseUrl: keelUrl,
    clientId: agent.clientId,
    clientSecret: agent.clientSecret,
  });
}

const dirs: string[] = [];
try {
  const operator = userClient(keelUrl, seeded.seedUser);
  const project = await operator.createProject(
    { org: seeded.seedUser.handle, name: PROJECT, source: FIXTURE },
    { idempotencyKey: key("project") },
  );
  await operator.putSettings(project.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  console.log(`     project ${PROJECT}: ${project.id}`);
  const first = await enrolled(operator, "c14-first", project.id);
  const second = await enrolled(operator, "c14-second", project.id);
  // The snapshot's cursor is the head of the log: an agent's page of events is one window of
  // the whole log filtered to its project, so an empty page is not the end of it.
  const { cursor } = await first.snapshot({ project: project.id });
  console.log(`     feed cursor ${cursor}`);

  const a: Declared = await declareWhenPooled(first, `C1.4 ${run}: first`, `c14:${run}:a`);
  const b: Declared = await declareWhenPooled(second, `C1.4 ${run}: second`, `c14:${run}:b`);
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
  // A slot forked before trunk last moved is behind it. The first change then starts from
  // trunk's head, as an agent told to rebase would, so (a) holds on any run of this project.
  const trunkAtStart = (await first.commits(project.id, { limit: 1 })).items[0]?.sha ?? "";
  for (const [who, dir] of [
    ["first", dirA],
    ["second", dirB],
  ] as const)
    console.log(
      `     ${who}'s base ${git(dir, ["rev-parse", "HEAD"]).slice(0, 12)}, trunk's head ${trunkAtStart.slice(0, 12)}`,
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
  for (const [i, h] of hunks.entries()) {
    const d = await declareWhenPooled(h.client, `C1.5 ${run}: ${i}`, `c14:${run}:hunk${i}`);
    if (d.workspace.token === undefined) throw new Error("declare answered no workspace token");
    const dir = cloneWorkspace(d.workspace.remote, d.workspace.token);
    dirs.push(dir);
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

  console.log("\n     chain:");
  for (const e of events) console.log(`     ${line(e)}`);
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall C1.4 staging checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
