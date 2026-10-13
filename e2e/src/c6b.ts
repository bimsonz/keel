// Step 6b's live proof against a deployed Keel: where a project starts.
//   KEEL_URL=<keel> KEEL_SESSION=<token> KEEL_NAMESPACE=<handle> node e2e/src/c6b.ts <run> [<name> <url>]
//
// KEEL_SESSION is a user's bearer session, read and never printed. That user
// creates two projects in KEEL_NAMESPACE and sponsors an agent in each. Both
// projects are made once and found again by their keys on every later run.
//   (a) an import: `c6b-import` starts from Keel's own public repository (or
//       `<name>` from `<url>`, any public Git repository). Its TrunkInitialized
//       records the origin: the URL, the upstream branch that came by its full
//       ref name, and trunk's first head, which stock git finds on that branch
//       of the upstream with the same history behind it;
//   (b) a change lands on the imported history: an agent's workspace holds the
//       origin's commit, its new file lands as one commit above trunk's head,
//       and stock git verifies that commit against the signers file Keel
//       publishes and refuses it against a file that names another key. The
//       imported commits are as the upstream wrote them: Keel signs only what
//       it composes;
//   (c) an empty project: `c6b-empty` starts with one commit of Keel's own, a
//       README that names the project, with no parent, written and committed
//       by Keel at this host, which stock git verifies against the published
//       file and refuses against the other.
// KEEL_VERIFICATION=off lands (b) unverified, for a repository the verifier
// has no flow for. No remote URL or credential is printed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import {
  declareWhenPooled,
  holdsCommit,
  keelSigners,
  line,
  projectEvents,
  tagged,
} from "./lib/live.ts";

const [run, named, url] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9-]+$/.test(run) || (named === undefined) !== (url === undefined))
  throw new Error(
    "usage: c6b.ts <run> [<name> <url>], the run a lower-case slug, the name and URL of another import together",
  );
const needed = (name: string): string => {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(
      `${name} is not set: c6b needs KEEL_URL, KEEL_SESSION (a user's session) and KEEL_NAMESPACE (the projects' namespace, by handle)`,
    );
  return value;
};
const keelUrl = needed("KEEL_URL");
const session = needed("KEEL_SESSION");
const NAMESPACE = needed("KEEL_NAMESPACE");
const IMPORTED = named ?? "c6b-import";
const UPSTREAM = url ?? "https://github.com/bimsonz/keel";
const EMPTY = "c6b-empty";
const VERIFICATION = process.env.KEEL_VERIFICATION === "off" ? "off" : "required";
const key = (what: string) => `c6b:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

/** Whether `ancestor` is `sha` or behind it, in the clone at `dir`. */
function reaches(dir: string, ancestor: string, sha: string): boolean {
  try {
    git(dir, ["merge-base", "--is-ancestor", ancestor, sha]);
    return true;
  } catch {
    return false;
  }
}

/** The project's agent: enrolled once, and found again by the key on every later run. */
async function enrolled(operator: KeelClient, project: string, projectId: string) {
  const agent = await operator.enrolAgent(
    { name: "c6b-agent", kind: "interactive", scopes: ["agent:read", "agent:work"], projectId },
    { idempotencyKey: key(`agent:${project}`) },
  );
  return new KeelClient({
    baseUrl: keelUrl,
    clientId: agent.clientId,
    clientSecret: agent.clientSecret,
  });
}

/** The project's TrunkInitialized, read from the start of its events. */
async function initialized(reader: KeelClient, projectId: string) {
  const events = await projectEvents(
    reader,
    undefined,
    projectId,
    (seen) => tagged(seen, "TrunkInitialized").length > 0,
  );
  return events.flatMap((e) => (e.payload._tag === "TrunkInitialized" ? [e.payload] : []))[0];
}

const dirs: string[] = [];
try {
  const operator = new KeelClient({ baseUrl: keelUrl, session });

  // (a) the import, and its origin on record.
  const upstream = mkdtempSync(join(tmpdir(), "keel-c6b-"));
  dirs.push(upstream);
  git(upstream, ["init", "-q"]);
  const upstreamRef = /^ref: (\S+)\tHEAD$/m.exec(
    git(upstream, ["ls-remote", "--symref", UPSTREAM, "HEAD"]),
  )?.[1];
  const asked = Date.now();
  const imported = await operator.createProject(
    { namespace: NAMESPACE, name: IMPORTED, source: { kind: "import", url: UPSTREAM } },
    { idempotencyKey: key(`project:${IMPORTED}`) },
  );
  console.log(
    `     project ${NAMESPACE}/${IMPORTED}: ${imported.id}, answered in ${Date.now() - asked} ms`,
  );
  await operator.putSettings(imported.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: VERIFICATION,
  });
  const start = await initialized(operator, imported.id);
  const origin = start?.origin;
  console.log(`     TrunkInitialized head ${start?.head.slice(0, 12)}`);
  console.log(`     origin ${JSON.stringify(origin)}`);
  check(
    origin?.kind === "imported" && origin.url === UPSTREAM,
    "(a) the trunk's origin is an import of the URL the project was created from",
  );
  if (start === undefined || origin?.kind !== "imported")
    throw new Error("the import's TrunkInitialized holds no imported origin");
  check(
    origin.ref === upstreamRef,
    `(a) it names the branch that came, the upstream's own ${upstreamRef}`,
  );
  check(origin.commit === start.head, "(a) its commit is trunk's first head");
  git(upstream, ["fetch", "-q", UPSTREAM, origin.ref]);
  const ahead = reaches(upstream, origin.commit, "FETCH_HEAD")
    ? Number(git(upstream, ["rev-list", "--count", `${origin.commit}..FETCH_HEAD`]))
    : undefined;
  check(
    ahead !== undefined,
    `(a) stock git finds that commit on the upstream's branch${ahead === undefined ? "" : `, ${ahead === 0 ? "at its head" : `${ahead} commit(s) behind its head now`}`}`,
  );

  // (b) a change lands on the imported history.
  const agent = await enrolled(operator, IMPORTED, imported.id);
  const { cursor } = await agent.snapshot({ project: imported.id });
  const file = `c6b-${run}.md`;
  const text = `Landed on imported history in 6b run ${run}.\n`;
  const declared = await declareWhenPooled(
    agent,
    { goal: `6b ${run}: a file on imported history`, footprint: [{ path: file, op: "create" }] },
    key(`${run}:${IMPORTED}:land`),
  );
  if (declared.workspace.token === undefined)
    throw new Error("declare answered no workspace token");
  const token = declared.workspace.token;
  const dir = cloneWorkspace(declared.workspace.remote, token);
  dirs.push(dir);
  console.log(
    `     ${declared.change.id}: its clone checks out ${git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])}`,
  );
  check(
    git(dir, ["rev-parse", "HEAD"]) === git(dir, ["rev-parse", "origin/main"]),
    "(b) a clone of the agent's workspace checks out main's head",
  );
  git(dir, ["checkout", "-q", "-B", "main", "origin/main"]);
  const history = (clone: string) => Number(git(clone, ["rev-list", "--count", origin.commit]));
  check(
    holdsCommit(dir, origin.commit) && history(dir) === history(upstream),
    `(b) the workspace holds the origin's commit with the upstream's history behind it: ${holdsCommit(dir, origin.commit) ? history(dir) : 0} of ${history(upstream)} commits`,
  );
  const trunkAtStart = (await agent.commits(imported.id, { limit: 1 })).items[0]?.sha ?? "";
  if (git(dir, ["rev-parse", "HEAD"]) !== trunkAtStart) {
    const { result: moved } = await agent.rebase(declared.change.id, {
      lease: declared.lease.id,
      idempotencyKey: key(`${run}:${IMPORTED}:rebase`),
    });
    git(dir, ["fetch", "-q", "origin", "keel/trunk"], token);
    git(dir, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
    console.log(`     the slot was behind trunk: rebased onto ${moved.base.slice(0, 12)}`);
  }
  writeFileSync(join(dir, file), text);
  const pushed = commitAndPush(dir, token, "c6b-agent", `6b ${run}: a file on imported history`);
  await agent.submit(
    { changeId: declared.change.id, commitSha: pushed },
    { lease: declared.lease.id, idempotencyKey: key(`${run}:${IMPORTED}:submit`) },
  );
  console.log(`     submitted at ${pushed.slice(0, 12)}, verification ${VERIFICATION}`);
  const events = await projectEvents(
    agent,
    cursor,
    imported.id,
    (seen) =>
      tagged(seen, "ChangeLanded", declared.change.id).length > 0 ||
      tagged(seen, "ChangeBounced", declared.change.id).length > 0,
  );
  const bounce = tagged(events, "ChangeBounced", declared.change.id)[0]?.payload;
  if (bounce !== undefined)
    console.log(`     bounced: ${JSON.stringify(Reflect.get(bounce, "reasons"))}`);
  check(
    tagged(events, "ChangeLanded", declared.change.id).length === 1,
    "(b) the change lands on the imported trunk",
  );
  const [landed = "", below = ""] = (await agent.commits(imported.id, { limit: 2 })).items.map(
    (c) => c.sha,
  );
  check(
    landed !== trunkAtStart && below === trunkAtStart,
    "(b) trunk's head is one new commit above the head the change started from",
  );
  // A workspace granted now is forked from trunk, so its clone holds what landed; it is abandoned once read.
  const reader = await declareWhenPooled(
    agent,
    { goal: `6b ${run}: read trunk`, footprint: [{ path: file, op: "edit" }] },
    key(`${run}:${IMPORTED}:reader`),
  );
  if (reader.workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dirR = cloneWorkspace(reader.workspace.remote, reader.workspace.token);
  dirs.push(dirR);
  const signers = await keelSigners(dirR, agent, keelUrl);
  check(
    holdsCommit(dirR, landed) && reaches(dirR, origin.commit, landed),
    "(b) a workspace forked after it holds the landed commit, with the origin's commit behind it",
  );
  if (holdsCommit(dirR, landed)) {
    console.log(`     ${signers.show(landed, "%h %G? signed by %GS, committed by %cn <%ce> %cI")}`);
    check(
      git(dirR, ["show", `${landed}:${file}`]) === text.trim(),
      "(b) the landed commit holds the agent's file",
    );
  }
  check(
    signers.verifies(signers.published, landed),
    "(b) git verifies the landed commit against Keel's published signers file",
  );
  check(
    !signers.verifies(signers.stranger, landed),
    "(b) against a signers file that names another key, git refuses it",
  );
  check(
    !signers.verifies(signers.published, origin.commit),
    "(b) the imported head is not Keel's: git does not verify it against Keel's file",
  );
  await agent.abandon(
    reader.change.id,
    {},
    { lease: reader.lease.id, idempotencyKey: key(`${run}:${IMPORTED}:reader:abandon`) },
  );

  // (c) an empty project starts with Keel's own signed commit.
  const empty = await operator.createProject(
    { namespace: NAMESPACE, name: EMPTY, source: { kind: "empty" } },
    { idempotencyKey: key(`project:${EMPTY}`) },
  );
  console.log(`     project ${NAMESPACE}/${EMPTY}: ${empty.id}`);
  const seeded = await initialized(operator, empty.id);
  console.log(`     TrunkInitialized head ${seeded?.head.slice(0, 12)}`);
  console.log(`     origin ${JSON.stringify(seeded?.origin)}`);
  check(seeded?.origin?.kind === "empty", "(c) the trunk's origin says the project started empty");
  if (seeded === undefined) throw new Error("the empty project's trunk was never initialized");
  const first = seeded.head;
  const emptyAgent = await enrolled(operator, EMPTY, empty.id);
  const look = await declareWhenPooled(
    emptyAgent,
    { goal: `6b ${run}: read the first commit`, footprint: [{ path: "README.md", op: "edit" }] },
    key(`${run}:${EMPTY}:reader`),
  );
  if (look.workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dirE = cloneWorkspace(look.workspace.remote, look.workspace.token);
  dirs.push(dirE);
  const keel = await keelSigners(dirE, emptyAgent, keelUrl);
  check(holdsCommit(dirE, first), "(c) a workspace of the project holds trunk's first head");
  if (holdsCommit(dirE, first)) {
    console.log(`     ${keel.show(first, "%h %G? signed by %GS, committed by %cn <%ce> %cI")}`);
    check(
      git(dirE, ["rev-list", "--parents", "-n", "1", first]) === first,
      "(c) it is a commit with no parent",
    );
    check(
      git(dirE, ["ls-tree", "-r", "--name-only", first]) === "README.md" &&
        git(dirE, ["show", `${first}:README.md`]) === `# ${EMPTY}`,
      "(c) it holds one file, a README that names the project",
    );
    check(
      git(dirE, ["log", "-1", "--format=%s", first]) === `Start ${EMPTY}`,
      `(c) its message is "Start ${EMPTY}"`,
    );
    check(
      git(dirE, ["log", "-1", "--format=%an <%ae> / %cn <%ce>", first]) ===
        `Keel <${keel.principal}> / Keel <${keel.principal}>`,
      `(c) it is written and committed by Keel <${keel.principal}>`,
    );
  }
  check(
    keel.verifies(keel.published, first),
    "(c) git verifies it against Keel's published signers file",
  );
  check(
    !keel.verifies(keel.stranger, first),
    "(c) against a signers file that names another key, git refuses it",
  );
  await emptyAgent.abandon(
    look.change.id,
    {},
    { lease: look.lease.id, idempotencyKey: key(`${run}:${EMPTY}:reader:abandon`) },
  );

  console.log("\n     chain of the import's change:");
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
console.log(failures === 0 ? "\nall 6b checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
