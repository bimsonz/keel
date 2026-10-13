// A stranger's walk on a deployed Keel: what a person who has never been here
// can do, and what the person beside them cannot.
//   KEEL_URL=<keel> node e2e/src/stranger.ts <run>
//
// It takes no credential: no session, no seeded account, no operator's tool.
// It signs two people up by passkey, as any visitor may, and does everything
// else with what those sign-ups hand back.
//   (1) the stranger, `walk-<run>-s`, signs up, has a namespace of their own
//       and creates a private project in it; the neighbour, `walk-<run>-n`,
//       signs up beside them;
//   (2) an agent that holds nothing but a key signs itself up and asks for a
//       sponsor, and the stranger stands behind it. That names them as its
//       sponsor and gives it no way into their project;
//   (3) the neighbour and a visitor with no account cannot list, find or
//       read that project, nor can git clone it; once the stranger makes it
//       public they can, and once it is private again they cannot;
//   (end) the stranger's account owns a project, so it is not deleted; the
//       neighbour's owns nothing, so it is, and its handle is never given out
//       again.
// Every "can" has its "cannot" beside it, read the same way: a check that
// passes for the stranger fails for the neighbour.
//
// Each run needs a run of its own, since a handle is taken for good. It
// leaves behind the stranger's account with its one private project, the
// agent, whose key is gone with the run, and the neighbour's handle. No
// session, passkey, code, secret or key is printed.
import { tmpdir } from "node:os";
import { generateAgentKey, KeelClient, KeelProblem, signUp as signUpByKey } from "@keeltown/sdk";
import { type Account, AccountRefused, signIn, signUp } from "../../scripts/lib/account.ts";
import { git } from "./lib/git.ts";
import { FIXTURE } from "./lib/s1.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: stranger.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to walk");
const STRANGER = `walk-${run}-s`;
const NEIGHBOUR = `walk-${run}-n`;
const PROJECT = "walk";
const key = (what: string) => `stranger:${run}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

/** A person the walk signed up: the account with its passkey, and a client that acts as them. */
interface Person {
  readonly account: Account;
  readonly client: KeelClient;
}

async function signedUp(handle: string): Promise<Person> {
  const account = await signUp(keelUrl, handle);
  return {
    account,
    client: new KeelClient({ baseUrl: keelUrl, session: account.session.token }),
  };
}

/** What a read answers: 200, or the status Keel refused it with, at the API or where a token is asked for. */
async function statusOf(read: Promise<unknown>): Promise<number> {
  try {
    await read;
    return 200;
  } catch (error) {
    const status: unknown = error instanceof Error ? Reflect.get(error, "status") : undefined;
    if (typeof status === "number") return status;
    throw error;
  }
}

/** Whether `reader`'s list of projects names `projectId`, read to its last page. */
async function lists(reader: KeelClient, projectId: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await reader.projects({ ...(cursor === undefined ? {} : { cursor }), limit: 100 });
    if (page.items.some((project) => project.id === projectId)) return true;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return false;
}

/**
 * `lists`, asked again for up to five seconds until it answers `wanted`: the
 * list is read from a row written just after the project's own commit.
 */
async function listsWithin(reader: KeelClient, projectId: string, wanted: boolean) {
  const asked = Date.now();
  for (;;) {
    const listed = await lists(reader, projectId);
    if (listed === wanted || Date.now() - asked > 5_000) return { listed, ms: Date.now() - asked };
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * What the clone URL answers git with no credential: `refs` when it advertises
 * the repository and stock git lists them, `refused` when it answers 401 or
 * 404, and otherwise its status and type, which is no answer to git at all.
 */
async function cloneUrlAnswers(remote: string): Promise<string> {
  const response = await fetch(`${remote}/info/refs?service=git-upload-pack`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0] ?? "";
  await response.body?.cancel();
  if (response.status === 401 || response.status === 404) return "refused";
  if (response.status !== 200 || type !== "application/x-git-upload-pack-advertisement")
    return `${response.status} ${type}`;
  try {
    return git(tmpdir(), ["ls-remote", remote]).includes("refs/heads/") ? "refs" : "no branch";
  } catch {
    return "an advertisement git cannot read";
  }
}

/** A Better Auth route asked with a person's session: its status and code, never its body. */
async function asks(path: string, session: string, body: unknown) {
  const response = await fetch(`${keelUrl}/v1/auth${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
      origin: new URL(keelUrl).origin,
    },
    body: JSON.stringify(body),
  });
  const answer: unknown = await response.json().catch(() => undefined);
  const code: unknown =
    typeof answer === "object" && answer !== null ? Reflect.get(answer, "code") : undefined;
  return { status: response.status, code: typeof code === "string" ? code : undefined };
}

const visitor = new KeelClient({ baseUrl: keelUrl });
let stranger: Person | undefined;
let neighbour: Person | undefined;
let projectId: string | undefined;

/** (1) a person signs up, has a namespace of their own and creates a project in it. */
async function arrives(): Promise<void> {
  stranger = await signedUp(STRANGER);
  const { userId } = stranger.account.session;
  console.log(`     ${STRANGER} signed up by passkey: ${userId}`);
  const me = await stranger.client.me();
  check(
    me.userId === userId && me.handle === STRANGER && me.orgs.length === 0,
    "(1) the stranger's session reads as them, a member of no org",
  );
  const place = await visitor.namespace(STRANGER);
  check(
    me.namespace?.handle === STRANGER &&
      place.handle === STRANGER &&
      place.kind === "user" &&
      place.id === userId,
    "(1) their handle is a namespace of kind user, their account's own, and anyone finds it",
  );
  const asked = Date.now();
  const project = await stranger.client.createProject(
    { namespace: STRANGER, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  projectId = project.id;
  console.log(`     project ${STRANGER}/${PROJECT}: ${project.id}, in ${Date.now() - asked} ms`);
  check(
    project.namespace.handle === STRANGER && project.visibility === "private",
    "(1) the project they create is in their namespace, and private",
  );
  const own = await stranger.client.project(STRANGER, PROJECT);
  check(
    own.id === project.id && own.viewer?.role === "owner",
    "(1) they read it at its address as its namespace's owner",
  );
  check(
    (await listsWithin(stranger.client, project.id, true)).listed,
    "(1) their list of projects names it",
  );
  neighbour = await signedUp(NEIGHBOUR);
  console.log(`     ${NEIGHBOUR} signed up by passkey: ${neighbour.account.session.userId}`);
}

/** (2) a key-only agent is sponsored by the stranger, which names them and opens nothing. */
async function standsBehind(): Promise<void> {
  if (stranger === undefined || neighbour === undefined || projectId === undefined)
    throw new Error("(2) needs both people and the stranger's project");
  const { userId } = stranger.account.session;
  const { signer } = await generateAgentKey();
  const account = await signUpByKey({ baseUrl: keelUrl, signer, name: `walk-${run}` });
  console.log(`     agent ${account.handle} signed up by key: ${account.agentId}`);
  const agent = new KeelClient({
    baseUrl: keelUrl,
    agentId: account.agentId,
    key: signer,
    run: "walk",
  });
  const sponsored = async (person: Person) =>
    (await person.client.sponsoredAgents()).items.some((item) => item.id === account.agentId);
  check(
    (await agent.whoami()).result.agent.sponsor === undefined && !(await sponsored(stranger)),
    "(2) the agent signed itself up with no sponsor, and the stranger's agents do not hold it",
  );
  const asked = await agent.askSponsor();
  await stranger.client.approveSponsor(account.agentId, asked.result.code, {
    idempotencyKey: key("sponsor"),
  });
  check(
    (await agent.whoami()).result.agent.sponsor === userId,
    "(2) once the stranger approves its code, the agent reads them as its sponsor",
  );
  check(
    (await sponsored(stranger)) && !(await sponsored(neighbour)),
    "(2) the stranger's agents hold it, and the neighbour's do not",
  );
  const card = await visitor.agent(account.agentId);
  check(
    card.id === account.agentId && !JSON.stringify(card).includes(userId),
    "(2) what anyone reads of the agent does not name its sponsor",
  );
  const forProject = new KeelClient({
    baseUrl: keelUrl,
    agentId: account.agentId,
    key: signer,
    project: projectId,
    run: "walk",
  });
  const read = {
    address: await statusOf(agent.project(STRANGER, PROJECT)),
    commits: await statusOf(agent.commits(projectId, { limit: 1 })),
    withAProjectToken: await statusOf(forProject.commits(projectId, { limit: 1 })),
  };
  check(
    read.address === 404 && read.commits === 404 && read.withAProjectToken !== 200,
    `(2) sponsoring gives it no way into the stranger's private project: ${JSON.stringify(read)}`,
  );
}

/** (3) the project is the stranger's alone until they make it public, and again after. */
async function keepsAndShows(): Promise<void> {
  if (stranger === undefined || neighbour === undefined || projectId === undefined)
    throw new Error("(3) needs both people and the stranger's project");
  const id = projectId;
  const owner = stranger.client;
  const beside = neighbour.client;
  const others = [
    ["the neighbour", beside],
    ["a visitor", visitor],
  ] as const;
  const remote = `${keelUrl}/${STRANGER}/${PROJECT}.git`;

  /** The four reads of the project and its listing, each of which must answer as `shown` says. */
  const seenAs = async (when: string, shown: boolean) => {
    const status = shown ? 200 : 404;
    for (const [who, reader] of others) {
      const { listed, ms } = await listsWithin(reader, id, shown);
      check(
        listed === shown,
        `(3) ${when}: ${who}'s list ${shown ? "names" : "does not name"} it (${ms} ms)`,
      );
      const read = {
        address: await statusOf(reader.project(STRANGER, PROJECT)),
        events: await statusOf(reader.events({ project: id, limit: 1 })),
        commits: await statusOf(reader.commits(id, { limit: 1 })),
      };
      check(
        read.address === status && read.events === status && read.commits === status,
        `(3) ${when}: ${who} reads its address, its events and its commits as ${status}: ${JSON.stringify(read)}`,
      );
    }
    const cloned = await cloneUrlAnswers(remote);
    check(
      cloned === (shown ? "refs" : "refused"),
      `(3) ${when}: git with no credential ${shown ? "is shown its refs" : "is refused"} at its clone URL: ${cloned}`,
    );
    check(
      (await lists(owner, id)) && (await statusOf(owner.project(STRANGER, PROJECT))) === 200,
      `(3) ${when}: its owner lists and reads it`,
    );
  };

  await seenAs("private", false);
  const before = await owner.settings(id);
  const as = (visibility: "private" | "public") => ({
    ...before,
    protectedPaths: [...before.protectedPaths],
    visibility,
  });
  await owner.putSettings(id, as("public"));
  const shown = await beside.project(STRANGER, PROJECT);
  check(
    shown.visibility === "public" && shown.viewer === undefined,
    "(3) public: the neighbour reads it as public, with no role there",
  );
  check(
    (await statusOf(beside.putSettings(id, as("private")))) !== 200,
    "(3) public: the neighbour cannot change its settings",
  );
  await seenAs("public", true);
  await owner.putSettings(id, as("private"));
  check(
    JSON.stringify(await owner.settings(id)) === JSON.stringify(before),
    "(3) private again: its settings read exactly as they did",
  );
  await seenAs("private again", false);
}

/** (end) an account that owns a project stays; one that owns nothing is deleted, and its handle with it. */
async function leaves(): Promise<void> {
  if (stranger !== undefined && projectId !== undefined) {
    const again = await signIn(keelUrl, STRANGER, stranger.account.passkey);
    const kept = await asks("/delete-user", again.session.token, {});
    check(
      kept.status === 400 && kept.code === "OWNS_PROJECTS",
      `(end) the stranger, signed in afresh, is refused their account's deletion while it owns a project: ${kept.status} ${kept.code}`,
    );
    check(
      (await statusOf(stranger.client.me())) === 200 &&
        (await statusOf(visitor.namespace(STRANGER))) === 200,
      "(end) and the account and its namespace are still there",
    );
  }
  if (neighbour !== undefined) {
    const again = await signIn(keelUrl, NEIGHBOUR, neighbour.account.passkey);
    const gone = await asks("/delete-user", again.session.token, {});
    check(
      gone.status === 200,
      `(end) the neighbour, who owns nothing, deletes theirs: ${gone.status}`,
    );
    check(
      (await statusOf(neighbour.client.me())) === 401 &&
        (await statusOf(visitor.namespace(NEIGHBOUR))) === 404,
      "(end) their session reads as nobody's and their namespace is gone",
    );
    const taken = await signUp(keelUrl, NEIGHBOUR).then(
      () => undefined,
      (error: unknown) => (error instanceof AccountRefused ? error : undefined),
    );
    check(
      taken?.status === 400 && taken.code === "NAME_TAKEN",
      `(end) a sign-up with their handle is refused: ${taken?.status} ${taken?.code}`,
    );
  }
}

// Each part by itself, and the leaving always: a part that stops must not leave the neighbour behind.
for (const part of [arrives, standsBehind, keepsAndShows, leaves]) {
  try {
    await part();
  } catch (error) {
    if (error instanceof KeelProblem) {
      console.log(`FAIL ${part.name}: ${error.status} ${error.code}`);
      for (const next of error.nextActions) console.log(`       next: ${next.title}`);
    } else if (error instanceof AccountRefused) console.log(`FAIL ${part.name}: ${error.message}`);
    else console.log(`FAIL ${part.name}: ${error instanceof Error ? error.name : "an error"}`);
    failures += 1;
  }
}
console.log(failures === 0 ? "\nevery check of the walk holds" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
