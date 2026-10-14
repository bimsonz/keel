// C1.F's live proof of MergeBox against a deployed Keel:
//   KEEL_URL=<keel> KEEL_SESSION=<token> KEEL_NAMESPACE=<handle> node e2e/src/c1f.ts <run>
//
// KEEL_SESSION is a user's bearer session, read and never printed. It runs in
// c14's project, c14-rebase, which it finds and never makes (the namespace is
// at its project quota), with two agents of its own that the user sponsors.
// A first change lands three files under c1f/<run>/, so each run edits files
// no other run has. Then, case by case, two changes are declared together on
// trunk's head and the first lands; the second, made on the base the first
// moved, is one GitCore refuses (packages/gitcore/src/merge.ts), so MergeBox
// takes it:
//   (a) a mode change: the first edits tool.sh, the second only makes it
//       executable. GitCore refuses `mode-change` (guardChanges: a side's
//       before and after differ in mode); the second lands, and trunk's
//       tool.sh is the first's text at 100755;
//   (b) a similar rename with an edit: the first edits notes.txt's 2nd line,
//       the second renames it moved.txt and edits its 9th. GitCore refuses
//       `modify-delete` (mergeTree: one side edits the path the other deletes,
//       met before guardRenames); the second lands, and trunk has moved.txt
//       with both edits and no notes.txt;
//   (c) a true conflict: both rewrite race.txt's 2nd line. GitCore refuses
//       `overlap` (mergeFile, by mergeText), and git conflicts too: the second
//       bounces with the VerdictIssued `composition-refused: conflict <path>`,
//       no candidate is assembled for it, and it is abandoned;
//   (d) each MergeBox landing's CandidateAssembled, read through the events
//       API, names composer mergebox at tier 2, GitCore's refusal in its
//       tierReason, and the box's check {canary: "found", tokens: "none"};
//   (e) Keel signs what MergeBox composed: one more workspace, taken only to
//       read trunk, holds both landings; stock git verifies each against the
//       signers file Keel publishes and neither against a file that names
//       another key; each names Keel at this host as its committer, and the
//       second agent, under Keel's agents domain, as its author.
// It ends with (f) each compose's cost by Keel's own clock, from the change's
// submit and from its BatchFormed, informational. No remote URL or credential
// is printed.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
} from "./lib/live.ts";

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: c1f.ts <run>, the run a lower-case slug");
const needed = (name: string): string => {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(
      `${name} is not set: c1f needs KEEL_URL, KEEL_SESSION (a user's session) and KEEL_NAMESPACE (c14-rebase's namespace, by handle)`,
    );
  return value;
};
const keelUrl = needed("KEEL_URL");
const session = needed("KEEL_SESSION");
const ORG = needed("KEEL_NAMESPACE");
const PROJECT = "c14-rebase";
const key = (what: string) => `c1f:${what}`;

/** The run's own files. */
const DIR = `c1f/${run}`;
const TOOL = `${DIR}/tool.sh`;
const NOTES = `${DIR}/notes.txt`;
const MOVED = `${DIR}/moved.txt`;
const RACE = `${DIR}/race.txt`;

const tool = (by: string) => `#!/bin/sh\necho "C1.F run ${run}: ${by}"\n`;
const race = (winner: string) => `C1.F run ${run}\nwinner: ${winner}\nend\n`;
/** Ten lines, so a rename that edits one stays far above git's 50% similarity. */
const NOTE_LINES = Array.from({ length: 10 }, (_, i) => `note ${i + 1} of C1.F run ${run}\n`);
/** notes.txt with each `[line, how]` (line from 0) edited. */
const notes = (...edits: readonly (readonly [number, string])[]) =>
  NOTE_LINES.map((text, i) => {
    const how = edits.find(([at]) => at === i)?.[1];
    return how === undefined ? text : text.replace("\n", `, ${how}\n`);
  }).join("");
const STOOD: [number, string] = [1, "edited where it stood"];
const MOVING: [number, string] = [8, "edited as it moved"];

type Footprint = NonNullable<Parameters<KeelClient["declare"]>[0]["footprint"]>;
const touches = (op: Footprint[number]["op"], ...paths: string[]): Footprint =>
  paths.map((path) => ({ path, op }));

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

/** The time from one event to another, by the clock that wrote them. */
const ms = (from: EventRecord, to: EventRecord) => Date.parse(to.at) - Date.parse(from.at);

type Payload = EventRecord["payload"];
/** The events of one tag, each payload read as that tag's. */
const ofTag = <T extends Payload["_tag"]>(events: readonly EventRecord[], tag: T) =>
  events.filter(
    (e): e is EventRecord & { readonly payload: Extract<Payload, { readonly _tag: T }> } =>
      e.payload._tag === tag,
  );

/**
 * The run's agent by that name: enrolled once, and found again by the key on
 * every later run. The key's last part is its generation: an enrolment is
 * replayed only while Keel reads the request as it first did, so a deploy
 * that changes what an enrolment holds needs the next one.
 */
async function enrolled(operator: KeelClient, name: string, projectId: string) {
  const agent = await operator.enrolAgent(
    { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId },
    { idempotencyKey: key(`agent:${name}:1`) },
  );
  return new KeelClient({
    baseUrl: keelUrl,
    clientId: agent.clientId,
    clientSecret: agent.clientSecret,
  });
}

/** A declared change of the run, its workspace cloned on trunk's head. */
interface Taken {
  readonly what: string;
  readonly client: KeelClient;
  readonly declared: Declared;
  readonly dir: string;
  readonly token: string;
}

const dirs: string[] = [];
/** The run's changes still declared, each withdrawn when the run ends however it ends. */
const withdrawals = new Map<string, () => Promise<unknown>>();

/**
 * Declares a change and clones its workspace. A slot forked before trunk last
 * moved is rebased onto trunk's head, as c14 does, so the change is made on
 * the base the case means.
 */
async function take(
  client: KeelClient,
  projectId: string,
  what: string,
  footprint: Footprint,
): Promise<Taken> {
  const declared = await declareWhenPooled(
    client,
    { goal: `C1.F ${run}: ${what}`, footprint },
    key(`${run}:${what}`),
  );
  const token = declared.workspace.token;
  if (token === undefined) throw new Error("declare answered no workspace token");
  const dir = cloneWorkspace(declared.workspace.remote, token);
  dirs.push(dir);
  const head = (await client.commits(projectId, { limit: 1 })).items[0]?.sha ?? "";
  if (git(dir, ["rev-parse", "HEAD"]) !== head) {
    const { result: moved } = await client.rebase(declared.change.id, {
      lease: declared.lease.id,
      idempotencyKey: key(`${run}:${what}:rebase`),
    });
    git(dir, ["fetch", "-q", "origin", "keel/trunk"], token);
    git(dir, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    console.log(`     ${what}'s slot was behind trunk: rebased onto ${moved.base.slice(0, 12)}`);
  }
  console.log(
    `     ${what}: ${declared.change.id} on ${git(dir, ["rev-parse", "HEAD"]).slice(0, 12)}`,
  );
  return { what, client, declared, dir, token };
}

/** Commits the clone's edits as `author` and pushes them. */
const push = (t: Taken, author: string) =>
  commitAndPush(t.dir, t.token, author, `C1.F ${run}: ${t.what}`);

/** Submits a pushed change and reads the project's events from `cursor` until it lands or bounces. */
async function settle(
  reader: KeelClient,
  projectId: string,
  cursor: string,
  t: Taken,
  sha: string,
): Promise<EventRecord[]> {
  const id = t.declared.change.id;
  await t.client.submit(
    { changeId: id, commitSha: sha },
    { lease: t.declared.lease.id, idempotencyKey: key(`${run}:${t.what}:submit`) },
  );
  console.log(`     ${t.what} submitted at ${sha.slice(0, 12)}`);
  const events = await projectEvents(
    reader,
    cursor,
    projectId,
    // The Lane's own events reach the feed on a delivery of their own: wait for the one each end names too.
    (seen) =>
      ofTag(seen, "ChangeLanded").some(
        (landed) =>
          landed.payload.changeId === id &&
          ofTag(seen, "CandidateAssembled").some(
            (e) => e.payload.candidateId === landed.payload.candidateId,
          ),
      ) ||
      ofTag(seen, "ChangeBounced").some(
        (bounced) =>
          bounced.payload.changeId === id &&
          ofTag(seen, "VerdictIssued").some(
            (e) => e.payload.verdictId === bounced.payload.verdictId,
          ),
      ),
  );
  const bounced = ofTag(events, "ChangeBounced").find((e) => e.payload.changeId === id);
  if (bounced !== undefined)
    console.log(`     ${t.what} bounced: ${JSON.stringify(bounced.payload.reasons)}`);
  return events;
}

const landing = (events: readonly EventRecord[], t: Taken) =>
  ofTag(events, "ChangeLanded").find((e) => e.payload.changeId === t.declared.change.id)?.payload;

/** (d) the candidate a change landed from, as the events API reads it. */
function boxComposed(
  events: readonly EventRecord[],
  landed: ReturnType<typeof landing>,
  refusal: string,
  what: string,
): void {
  const assembled = ofTag(events, "CandidateAssembled").find(
    (e) => e.payload.candidateId === landed?.candidateId,
  )?.payload;
  console.log(
    `     ${what}'s candidate: ${assembled?.composer ?? "none"} at tier ${String(assembled?.tier)}, "${assembled?.tierReason ?? ""}", check ${JSON.stringify(assembled?.boxCheck)}`,
  );
  check(
    assembled?.composer === "mergebox" && assembled.tier === 2,
    `(d) ${what}: CandidateAssembled names composer mergebox at tier 2`,
  );
  check(
    assembled?.tierReason.startsWith("MergeBox: ") === true &&
      assembled.tierReason.endsWith(`where GitCore refused (${refusal})`),
    `(d) ${what}: its tierReason names GitCore's refusal, ${refusal}`,
  );
  check(
    isDeepStrictEqual(assembled?.boxCheck, { canary: "found", tokens: "none" }),
    `(d) ${what}: its boxCheck is {canary: "found", tokens: "none"}`,
  );
}

/**
 * (f) what a change's compose cost by Keel's own clock: from its submit, and
 * from the BatchFormed of the batch composed, to its CandidateAssembled, or
 * to the verdict that refused the composition.
 */
function cost(events: readonly EventRecord[], t: Taken): string {
  const id = t.declared.change.id;
  const submitted = ofTag(events, "ChangeSubmitted").find((e) => e.payload.changeId === id);
  const landed = landing(events, t);
  const bounce = ofTag(events, "ChangeBounced").find((e) => e.payload.changeId === id)?.payload;
  const assembled = ofTag(events, "CandidateAssembled").find(
    (e) => e.payload.candidateId === landed?.candidateId,
  );
  const refused = ofTag(events, "VerdictIssued").find(
    (e) => e.payload.verdictId === bounce?.verdictId,
  );
  const end = assembled ?? refused;
  const batch = assembled?.payload.batchId ?? refused?.payload.subject;
  const formed = ofTag(events, "BatchFormed").find((e) => e.payload.batchId === batch);
  if (submitted === undefined || formed === undefined || end === undefined)
    return `${t.what}: no compose read`;
  const how =
    assembled === undefined ? "composition refused" : `${assembled.payload.composer} composed`;
  return `${t.what}: ${how} ${ms(submitted, end)} ms after its submit, ${ms(formed, end)} ms after its BatchFormed`;
}

interface Case {
  readonly name: "a" | "b" | "c";
  /** The file the first change edits. */
  readonly file: string;
  /** The second change's footprint. */
  readonly footprint: Footprint;
  readonly first: (dir: string) => void;
  readonly second: (dir: string) => void;
}

try {
  const operator = new KeelClient({ baseUrl: keelUrl, session });
  // c14's project, found by its name: the namespace is at its project quota, so c1f makes none.
  const project = await operator.project(ORG, PROJECT).catch((error: unknown) => {
    if (error instanceof KeelProblem && error.status === 404)
      throw new Error(`${ORG}/${PROJECT} is not there: c14 makes it, and c1f runs in it`);
    throw error;
  });
  console.log(`     project ${ORG}/${PROJECT}: ${project.id}`);
  const first = await enrolled(operator, "c1f-first", project.id);
  const second = await enrolled(operator, "c1f-second", project.id);
  // The snapshot's cursor is the head of the log: an agent's page of events is one window of
  // the whole log filtered to its project, so an empty page is not the end of it.
  const { cursor } = await first.snapshot({ project: project.id });
  console.log(`     feed cursor ${cursor}`);

  // The run's three files, landed first: every case edits what this lands.
  const seed = await take(first, project.id, "seed", touches("create", TOOL, NOTES, RACE));
  mkdirSync(join(seed.dir, DIR), { recursive: true });
  writeFileSync(join(seed.dir, TOOL), tool("as seeded"));
  chmodSync(join(seed.dir, TOOL), 0o644);
  writeFileSync(join(seed.dir, NOTES), notes());
  writeFileSync(join(seed.dir, RACE), race("nobody yet"));
  const seeded = landing(
    await settle(first, project.id, cursor, seed, push(seed, "c1f-first")),
    seed,
  );
  check(seeded !== undefined, `the seed lands ${DIR}'s three files`);
  if (seeded === undefined) throw new Error("no case can run without the seed's files");

  /**
   * One case: its two changes declared together, so both are made on trunk's
   * head as it stands, and both pushed; the first is submitted and lands, then
   * the second, made on the base the first moved, is submitted and read until
   * it lands or bounces.
   */
  const round = async (c: Case) => {
    const one = await take(first, project.id, `${c.name}-first`, touches("edit", c.file));
    const two = await take(second, project.id, `${c.name}-second`, c.footprint);
    check(
      git(one.dir, ["rev-parse", "HEAD"]) === git(two.dir, ["rev-parse", "HEAD"]),
      `(${c.name}) both changes are made on one base`,
    );
    c.first(one.dir);
    c.second(two.dir);
    const shaOne = push(one, "c1f-first");
    const shaTwo = push(two, "c1f-second");
    const before = await settle(first, project.id, cursor, one, shaOne);
    check(landing(before, one) !== undefined, `(${c.name}) the first change lands`);
    const events = await settle(first, project.id, cursor, two, shaTwo);
    return { one, two, events };
  };

  // (a) a mode change: GitCore refuses `mode-change` (merge.ts, guardChanges).
  const a = await round({
    name: "a",
    file: TOOL,
    footprint: touches("edit", TOOL),
    first: (dir) => writeFileSync(join(dir, TOOL), tool("as the first left it")),
    // Executable on disk and in the index, so `git add -A` keeps it whatever core.fileMode says.
    second: (dir) => {
      chmodSync(join(dir, TOOL), 0o755);
      git(dir, ["update-index", "--chmod=+x", TOOL]);
    },
  });
  const toolOid = git(a.two.dir, ["rev-parse", `HEAD:${TOOL}`]);
  check(
    git(a.two.dir, ["diff", "--raw", "--no-abbrev", "HEAD~1", "HEAD"]) ===
      `:100644 100755 ${toolOid} ${toolOid} M\t${TOOL}`,
    "(a) the second's commit only makes tool.sh executable",
  );
  const landedA = landing(a.events, a.two);
  check(landedA !== undefined, "(a) the second change lands");
  boxComposed(a.events, landedA, `mode-change ${TOOL}`, "the mode change");
  const toolOnTrunk = await first.blob(project.id, TOOL);
  console.log(`     trunk's tool.sh: ${toolOnTrunk.mode}`);
  check(toolOnTrunk.mode === "100755", "(a) trunk's tool.sh is 100755");
  check(
    toolOnTrunk.content === tool("as the first left it"),
    "(a) trunk's tool.sh is the first's text",
  );

  // (b) a similar rename with an edit: GitCore refuses `modify-delete` (merge.ts, mergeTree).
  const b = await round({
    name: "b",
    file: NOTES,
    footprint: [...touches("delete", NOTES), ...touches("create", MOVED)],
    first: (dir) => writeFileSync(join(dir, NOTES), notes(STOOD)),
    second: (dir) => {
      git(dir, ["mv", NOTES, MOVED]);
      writeFileSync(join(dir, MOVED), notes(MOVING));
    },
  });
  const renamed = git(b.two.dir, ["diff", "-M", "--name-status", "HEAD~1", "HEAD"]);
  console.log(`     the second's commit: ${renamed.replaceAll("\t", " ")}`);
  check(
    /^R0\d\d\t/.test(renamed) && renamed === `${renamed.slice(0, 4)}\t${NOTES}\t${MOVED}`,
    "(b) git reads the second's commit as a similar (not exact) rename of notes.txt to moved.txt",
  );
  const landedB = landing(b.events, b.two);
  check(landedB !== undefined, "(b) the second change lands");
  boxComposed(b.events, landedB, `modify-delete ${NOTES}`, "the rename");
  const listed = (await first.tree(project.id, { path: DIR })).entries.map((e) => e.name);
  console.log(`     trunk's ${DIR}: ${listed.join(" ")}`);
  check(
    listed.includes("moved.txt") && !listed.includes("notes.txt"),
    "(b) trunk has moved.txt and no notes.txt",
  );
  check(
    (await first.blob(project.id, MOVED)).content === notes(STOOD, MOVING),
    "(b) trunk's moved.txt holds both edits",
  );

  // (c) a true conflict: GitCore refuses `overlap` (merge.ts, mergeFile); git conflicts too.
  const c = await round({
    name: "c",
    file: RACE,
    footprint: touches("edit", RACE),
    first: (dir) => writeFileSync(join(dir, RACE), race("the first")),
    second: (dir) => writeFileSync(join(dir, RACE), race("the second")),
  });
  const idC = c.two.declared.change.id;
  withdrawals.set("c-second", () =>
    second.abandon(
      idC,
      {},
      { lease: c.two.declared.lease.id, idempotencyKey: key(`${run}:c-second:abandon`) },
    ),
  );
  const bounce = ofTag(c.events, "ChangeBounced").find((e) => e.payload.changeId === idC);
  check(
    bounce !== undefined && landing(c.events, c.two) === undefined,
    "(c) the second change bounces and does not land",
  );
  const verdict = ofTag(c.events, "VerdictIssued").find(
    (e) => e.payload.verdictId === bounce?.payload.verdictId,
  )?.payload;
  console.log(
    `     its verdict: ${verdict?.outcome ?? "none"} ${JSON.stringify(verdict?.evidence)}`,
  );
  check(
    isDeepStrictEqual(verdict?.evidence, [`composition-refused: conflict ${RACE}`]),
    `(c) its VerdictIssued's evidence is the box's, composition-refused: conflict ${RACE}`,
  );
  const batchesC = new Set(
    ofTag(c.events, "BatchFormed")
      .filter((e) => e.payload.members.includes(idC))
      .map((e) => e.payload.batchId),
  );
  check(
    batchesC.size > 0 &&
      !ofTag(c.events, "CandidateAssembled").some((e) => batchesC.has(e.payload.batchId)),
    "(c) it was batched, and no candidate was assembled for it, by MergeBox or GitCore",
  );
  check(
    (await first.blob(project.id, RACE)).content === race("the first"),
    "(c) trunk's race.txt holds the first's line",
  );
  // Bounced, it is the run's to withdraw: nothing else builds on it.
  if (bounce !== undefined) await withdrawals.get("c-second")?.();
  withdrawals.delete("c-second");

  // (e) Keel signs what MergeBox composed. The reader is taken once the last case is read,
  // on trunk's head, so its plain clone holds both landings. It is abandoned once read.
  const reader = await take(first, project.id, "reader", touches("edit", TOOL));
  withdrawals.set("reader", () =>
    first.abandon(
      reader.declared.change.id,
      {},
      { lease: reader.declared.lease.id, idempotencyKey: key(`${run}:reader:abandon`) },
    ),
  );
  const boxed = [landedA, landedB].flatMap((l) =>
    l === undefined ? [] : [{ sha: l.commitSha, changeId: l.changeId }],
  );
  const held = boxed.filter(({ sha }) => holdsCommit(reader.dir, sha));
  const { principal, published, stranger, verifies, show } = await keelSigners(
    reader.dir,
    first,
    keelUrl,
  );
  const log = (sha: string, format: string) =>
    git(reader.dir, ["log", "-1", `--format=${format}`, sha]);
  const trailer = (sha: string, name: string) =>
    log(sha, `%(trailers:key=${name},valueonly)`).trim();
  for (const { sha } of held) {
    console.log(`     ${show(sha, "%h %G? signed by %GS, committed by %cn <%ce> %cI")}`);
    console.log(`     ${log(sha, "%h author %an <%ae>")}; Change-Id ${trailer(sha, "Change-Id")}`);
  }
  /** Whether every MergeBox landing is held, and `ok` holds of each. */
  const each = (ok: (sha: string, changeId: string) => boolean) =>
    held.length === 2 && held.every(({ sha, changeId }) => ok(sha, changeId));
  check(
    held.length === 2,
    `(e) the reader's workspace holds ${held.length} of the 2 MergeBox landings`,
  );
  check(
    each((sha) => verifies(published, sha)),
    "(e) git verifies each against Keel's published signers file",
  );
  check(
    each((sha) => !verifies(stranger, sha)),
    "(e) against a signers file that names another key, git verifies neither",
  );
  check(
    each((sha) => log(sha, "%cn <%ce>") === `Keel <${principal}>`),
    `(e) each names Keel <${principal}> as its committer`,
  );
  // Who landed it: the change's agent, as Keel authenticated it, never what its commit says.
  const secondId = (await second.whoami()).result.agent.id;
  const agentsHost = `agents.${new URL(keelUrl).host}`;
  check(
    each(
      (sha, changeId) =>
        trailer(sha, "Change-Id") === changeId &&
        trailer(sha, "Keel-Agent") === secondId &&
        log(sha, "%ae") === `${secondId}@${agentsHost}`,
    ),
    `(e) each is authored by the second agent at ${agentsHost}, named with its change in its trailers`,
  );
  await withdrawals.get("reader")?.();
  withdrawals.delete("reader");

  // (f) the cost, informational: every compose of the run's cases, GitCore's beside MergeBox's.
  console.log("\n     composes:");
  for (const t of [a.one, a.two, b.one, b.two, c.one, c.two])
    console.log(`     ${cost(c.events, t)}`);
  console.log("\n     chain:");
  for (const e of c.events) console.log(`     ${line(e)}`);
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
  for (const [what, abandon] of withdrawals)
    // oxlint-disable-next-line no-await-in-loop -- one withdrawal after another, at most two
    await abandon().catch((error: unknown) => {
      console.log(`     could not withdraw ${what}: ${error instanceof Error ? error.name : "?"}`);
    });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall C1.F checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
