// An agent's invitation into an org on a deployed Keel, through the routes
// anyone uses: what the invited agent can do, and what the agent beside it
// cannot.
//   KEEL_URL=<keel> node e2e/src/invited.ts <run>
//
// It takes no credential. A person, `inv-<run>-p`, signs up by passkey, makes
// an org, `inv-<run>-o`, and a private project in it. Two agents that hold
// nothing but a key sign themselves up: the guest, which the person invites,
// and the other, which nobody does.
//   (1) before any invitation neither agent reads the org's project;
//   (2) invited, the guest still reads nothing, is told where it was asked,
//       and only the org's members see the invitation;
//   (3) once it accepts, the token it asks for that project reads it, anyone
//       sees it among the org's agents, and only members see who invited it;
//   (4) taken out by the person, it is a stranger again.
// Every "can" of the guest has the other agent's "cannot" beside it, read the
// same way.
//
// Each run needs a run of its own, since a handle is taken for good. It
// leaves behind the person's account, their org with one project, and the two
// agents, whose keys are gone with the run. No session, passkey or key is
// printed.
import { generateAgentKey, KeelClient, KeelProblem, signUp as signUpByKey } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import { FIXTURE } from "./lib/s1.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: invited.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");
const PERSON = `inv-${run}-p`;
const ORG = `inv-${run}-o`;
const PROJECT = "invited";
const key = (what: string) => `invited:${run}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

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
      run: "invited",
      ...(project === undefined ? {} : { project }),
    });
  return { ...account, own: client(), in: client };
}

const visitor = new KeelClient({ baseUrl: keelUrl });

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const { userId } = account.session;
  console.log(`     ${PERSON} signed up by passkey: ${userId}`);
  const person = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  const made = await fetch(`${keelUrl}/v1/auth/organization/create`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.session.token}`,
      "content-type": "application/json",
      origin: new URL(keelUrl).origin,
    },
    body: JSON.stringify({ name: ORG, slug: ORG }),
  });
  await made.body?.cancel();
  check(made.status === 200, `the person makes an org, ${ORG}: ${made.status}`);
  const project = await person.createProject(
    { namespace: ORG, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  console.log(`     project ${ORG}/${PROJECT}: ${project.id}`);
  check(
    project.namespace.kind === "org" && project.visibility === "private",
    "the project they create is in the org, and private",
  );

  const guest = await keyAgent(`inv-${run}-guest`);
  const other = await keyAgent(`inv-${run}-other`);
  /** What an agent's token for the org's project reads of it: its commits and its changes. */
  const reads = async (agent: typeof guest) => {
    const there = agent.in(project.id);
    return [
      await statusOf(there.commits(project.id, { limit: 1 })),
      await statusOf(there.changes({ project: project.id, limit: 1 })),
    ].join(" ");
  };
  /** How `reader` sees the guest among the org's agents: its state and who invited it, or nothing. */
  const listed = async (reader: KeelClient) => {
    const row = (await reader.namespaceAgents(ORG)).items.find((item) => item.id === guest.agentId);
    return row === undefined ? "absent" : `${row.state} by ${row.invitedBy ?? "nobody named"}`;
  };
  const asked = async () =>
    (await guest.own.invitations()).items
      .filter((item) => item.namespace.handle === ORG)
      .map((item) => item.state)
      .join(" ");

  check(
    (await reads(guest)) === "404 404" && (await reads(other)) === "404 404",
    "(1) before any invitation neither agent reads the org's project",
  );

  const invited = await person.inviteAgent(ORG, guest.handle, { idempotencyKey: key("invite") });
  check(
    invited.state === "invited" && invited.invitedBy === userId,
    `(2) the person invites the guest by its handle: ${invited.state}`,
  );
  check(
    (await reads(guest)) === "404 404",
    "(2) invited and not yet joined, the guest reads nothing",
  );
  check((await asked()) === "invited", "(2) the guest's own list names the org as asking");
  check(
    (await listed(person)) === `invited by ${userId}` && (await listed(visitor)) === "absent",
    "(2) the org's members see the invitation and who made it, and a visitor sees none",
  );

  const joined = await guest.own.acceptInvitation(ORG, { idempotencyKey: key("accept") });
  check(joined.state === "joined", `(3) the guest accepts: ${joined.state}`);
  check(
    (await reads(guest)) === "200 200" && (await reads(other)) === "404 404",
    "(3) the guest's token for the org's project reads it, and the other agent's does not",
  );
  check(
    (await listed(visitor)) === "joined by nobody named" &&
      (await listed(person)) === `joined by ${userId}`,
    "(3) anyone sees the guest among the org's agents, and only a member sees who invited it",
  );
  // The card's orgs came after the invitation: a Keel deployed before them answers none, so this is said, not checked.
  const card = await visitor.agent(guest.agentId);
  console.log(`     the guest's card names its orgs: ${JSON.stringify(card.orgs ?? "no field")}`);
  check(!JSON.stringify(card).includes(userId), "(3) the guest's card names nobody who invited it");

  const removed = await person.removeAgent(ORG, guest.agentId, { idempotencyKey: key("remove") });
  check(removed.state === "ended", `(4) the person takes the guest out: ${removed.state}`);
  check((await reads(guest)) === "404 404", "(4) taken out, the guest reads nothing again");
  check(
    (await asked()) === "" &&
      (await listed(person)) === "absent" &&
      (await listed(visitor)) === "absent",
    "(4) no list names it: not its own, not the members', not a visitor's",
  );
}

try {
  await walk();
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`FAIL stopped: ${error.status} ${error.code}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else if (error instanceof AccountRefused) console.log(`FAIL stopped: ${error.message}`);
  else console.log(`FAIL stopped: ${error instanceof Error ? error.name : "an error"}`);
  failures += 1;
}
console.log(failures === 0 ? "\nevery check holds" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
