import { parseArgs } from "node:util";
import {
  createKeelClient,
  generateAgentKey,
  type KeelClient,
  type KeelClientOptions,
  KeelProblem,
  KeelTokenError,
  signUp,
  thumbprint,
} from "@keeltown/sdk";
import { encodeEntry, entryName, type Held, heldKey, KeyError } from "./agent-key.ts";
import { gitCredential, setupGit } from "./git-credential.ts";
import type { Exec, KeyStore } from "./key-store.ts";
import { heldSignIn, LoginFailed, loginCommand, logoutCommand } from "./login.ts";
import { chainText } from "./why.ts";

/** Where the CLI writes, and how it reaches Keel; tests pass their own. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch?: KeelClientOptions["fetch"];
  /** This machine's key store, where an agent's key is kept; undefined when it has none. */
  readonly keyStore?: KeyStore | undefined;
  /** The same store as it keeps a person's sign-in, under a service of its own. */
  readonly signIns?: KeyStore | undefined;
  /** Everything on stdin: git writes its helper the address it wants a credential for. */
  readonly stdin?: () => Promise<string>;
  /** Runs a program on this machine: git, for `auth setup-git`. */
  readonly exec?: Exec;
  /** The command that runs this CLI again, as git's config is given it. */
  readonly self?: readonly string[];
  /** Waiting and the time, for `login`'s polling; tests pass their own. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** 0: done. 1: Keel refused (the next actions are printed). 2: the command line or credentials are wrong. */
export type ExitCode = 0 | 1 | 2;

const USAGE = `keeltown <command> [options]

  login [--profile <name>] [--print-token]
  logout [--profile <name>]
  auth setup-git [--profile <name>]
  agent signup [--name <label>] [--profile <name>] [--print-key]
  agent show [--profile <name>]
  agent sponsor-request [--person <handle>] [--profile <name>]
  agent join <namespace> [--profile <name>] [--key <idempotency-key>]
  agent use <prj_…> [--run <label>] [--profile <name>]
  token [--project <prj_…>] [--run <label>] [--mcp] [--header] [--profile <name>]
  whoami
  session open [--harness <name>] [--model <id>] [--key <idempotency-key>]
  declare --goal <text> [--footprint <path[:edit|create|delete]>]... [--key <idempotency-key>]
  revise <chg_…> --lease <lse_…> --if-match <revision> [--goal <text>] [--footprint <path[:op]>]... [--add-premise <json>]... [--retract-premise <json>]... [--key <idempotency-key>]
  rely <chg_…> --lease <lse_…> --premise <json> [--key <idempotency-key>]
  nearby <chg_…>
  submit --change <chg_…> --commit <sha> --lease <lse_…> [--key <idempotency-key>]
  status <chg_…> [--wait <0-900>]
  rebase <chg_…> --lease <lse_…> [--key <idempotency-key>]
  adopt <chg_…> [--key <idempotency-key>]
  abandon <chg_…> [--reason <text>] [--lease <lse_…>] [--key <idempotency-key>]
  inbox [--cursor <cursor>] [--wait <0-900>]
  events [--cursor <cursor>] [--wait <0-900>] [--limit <1-500>]
  project create --namespace <handle> --name <name> (--empty | --import <https-url> [--ref <branch>] | --fork <prj_…> | --template <name>) [--key <idempotency-key>]
  project invite --project <prj_…> --agent <handle> [--scope agent:read|agent:work]... [--key <idempotency-key>]
  agent enrol --project <prj_…> --name <name> --scope <scope>... [--kind interactive|hosted|human|synthetic] [--key <idempotency-key>]
  why (--path <path> [--line <n>] | --subject <subject>)

A premise is a proposition as JSON: {"subject", "predicate", "relation", "value", …}.
An agent is a key: \`agent signup\` makes one, keeps it in this machine's key store and signs up with it.
Its commands then run as that agent, each token for one project (--project or KEEL_PROJECT, or else
the project the run chose with \`agent use\`) and one run (--run or KEEL_RUN). \`token\` prints a five-minute token for a tool that takes only a bearer;
--mcp asks for one Keel's MCP endpoint takes (the API refuses it, as /mcp refuses the API's), and
--header prints it as the header an MCP client's helper wants. Where there is no key store, the key
comes from KEEL_AGENT_KEY with KEEL_AGENT_ID (\`agent signup --print-key\` prints one, once).
\`agent sponsor-request\` prints the page where a signed-in person approves sponsoring the agent, or
with --person puts the request on that person's own list, and \`agent join\` accepts an org's invitation by the org's handle.
\`agent use\` has the run work in a project: from then on a token the run asks for without --project is
for it, so a tool whose token helper names no project works there too.
Other credentials: KEEL_URL always; an agent's KEEL_CLIENT_ID and KEEL_CLIENT_SECRET, or a user's
KEEL_SESSION, which win over a key when set. Projects and agents are governed by a user.
A person signs in with \`login\`: Keel names a page to open, the sign-in is approved there, and it
is kept in this machine's key store, never in a file (--print-token prints its token once where
there is no store, for KEEL_SESSION). \`auth setup-git\` has git ask keeltown for it, so a private
project clones with nothing pasted, and \`logout\` ends it at Keel and here. With no agent's
credential on the machine, a command runs as the person signed in, and \`whoami\` says who that is.
\`project invite\` runs only as the person (or KEEL_SESSION), never as an agent, and Keel wants a
\`login\` approved with a passkey in the last ten minutes for it.
Every command prints Keel's answer; --json prints it as JSON.`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  goal: { type: "string" },
  person: { type: "string" },
  footprint: { type: "string", multiple: true },
  key: { type: "string" },
  change: { type: "string" },
  commit: { type: "string" },
  lease: { type: "string" },
  reason: { type: "string" },
  wait: { type: "string" },
  cursor: { type: "string" },
  limit: { type: "string" },
  name: { type: "string" },
  namespace: { type: "string" },
  empty: { type: "boolean" },
  import: { type: "string" },
  ref: { type: "string" },
  fork: { type: "string" },
  template: { type: "string" },
  scope: { type: "string", multiple: true },
  kind: { type: "string" },
  project: { type: "string" },
  agent: { type: "string" },
  run: { type: "string" },
  profile: { type: "string" },
  header: { type: "boolean" },
  mcp: { type: "boolean" },
  "print-key": { type: "boolean" },
  "print-token": { type: "boolean" },
  harness: { type: "string" },
  model: { type: "string" },
  "if-match": { type: "string" },
  premise: { type: "string" },
  "add-premise": { type: "string", multiple: true },
  "retract-premise": { type: "string", multiple: true },
  path: { type: "string" },
  line: { type: "string" },
  subject: { type: "string" },
} as const;

class UsageError extends Error {}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`missing --${flag}`);
  return value;
}

/** Where a new project starts: exactly one of --empty, --import, --fork and --template. */
function sourceOf(values: {
  readonly empty?: boolean | undefined;
  readonly import?: string | undefined;
  readonly ref?: string | undefined;
  readonly fork?: string | undefined;
  readonly template?: string | undefined;
}): Parameters<KeelClient["createProject"]>[0]["source"] {
  const given = [
    values.empty === true,
    values.import !== undefined,
    values.fork !== undefined,
    values.template !== undefined,
  ].filter(Boolean).length;
  if (given !== 1)
    throw new UsageError("give exactly one of --empty, --import, --fork and --template");
  if (values.ref !== undefined && values.import === undefined)
    throw new UsageError("--ref names a branch of the repository --import takes");
  if (values.import !== undefined)
    return {
      kind: "import",
      url: required(values.import, "import"),
      ...(values.ref === undefined ? {} : { ref: required(values.ref, "ref") }),
    };
  if (values.fork !== undefined) return { kind: "fork", project: required(values.fork, "fork") };
  if (values.template !== undefined)
    return { kind: "template", name: required(values.template, "template") };
  return { kind: "empty" };
}

function count(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${flag} takes a whole number`);
  return n;
}

const FOOTPRINT_OPS = ["edit", "create", "delete"] as const;

function footprintOf(entry: string) {
  const at = entry.lastIndexOf(":");
  const op = at === -1 ? "edit" : entry.slice(at + 1);
  const path = at === -1 ? entry : entry.slice(0, at);
  const known = FOOTPRINT_OPS.find((o) => o === op);
  if (known === undefined)
    throw new UsageError(`footprint op must be edit, create or delete: ${entry}`);
  return { path, op: known };
}

/** A proposition, as the SDK takes it (the CLI depends on the SDK alone). */
type Proposition = Parameters<KeelClient["rely"]>[1]["premise"];

/**
 * A premise from the command line: a JSON object with a proposition's required
 * fields. Keel checks the rest (the predicate's and relation's values among them).
 */
function propositionOf(text: string): Proposition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`a premise must be JSON: ${text}`);
  }
  if (!isProposition(parsed))
    throw new UsageError(`a premise needs subject, predicate, relation and value: ${text}`);
  return parsed;
}

/** A value of any JSON type: MFP 0.2 types it by the predicate (an authority's writers are a list, a shape is a type), and Keel checks it. */
function isProposition(value: unknown): value is Proposition {
  const field = (name: string) => Reflect.get(Object(value), name);
  return (
    typeof value === "object" &&
    value !== null &&
    typeof field("subject") === "string" &&
    typeof field("predicate") === "string" &&
    typeof field("relation") === "string" &&
    field("value") !== undefined
  );
}

const KINDS = ["interactive", "hosted", "human", "synthetic"] as const;
const SCOPES = ["agent:work", "agent:read"] as const;

/** The scopes --scope names, each one Keel knows. */
function scopesOf(given: readonly string[] | undefined) {
  return (given ?? []).map((scope) => {
    const known = SCOPES.find((s) => s === scope);
    if (known === undefined) throw new UsageError(`unknown scope ${scope}`);
    return known;
  });
}

/** One command against Keel, as the SDK answers it. */
async function dispatch(
  client: KeelClient,
  command: readonly string[],
  values: ReturnType<typeof parse>["values"],
): Promise<unknown> {
  const idempotent = values.key === undefined ? {} : { idempotencyKey: values.key };
  const wait = count(values.wait, "wait");
  const waiting = wait === undefined ? {} : { wait };
  const cursor = values.cursor === undefined ? {} : { cursor: values.cursor };
  switch (command.join(" ")) {
    case "whoami":
      return client.whoami();
    case "agent sponsor-request":
      return client.askSponsor(values.person === undefined ? {} : { person: values.person });
    case "session open":
      return client.openSession(
        {
          ...(values.harness === undefined ? {} : { harness: values.harness }),
          ...(values.model === undefined ? {} : { model: values.model }),
        },
        idempotent,
      );
    case "declare":
      return client.declare(
        {
          goal: required(values.goal, "goal"),
          footprint: (values.footprint ?? []).map(footprintOf),
          premises: [],
        },
        idempotent,
      );
    case "submit":
      return client.submit(
        {
          changeId: required(values.change, "change"),
          commitSha: required(values.commit, "commit"),
        },
        { lease: required(values.lease, "lease"), ...idempotent },
      );
    case "inbox":
      return client.inbox({ ...cursor, ...waiting });
    case "events": {
      const limit = count(values.limit, "limit");
      return client.events({ ...cursor, ...waiting, ...(limit === undefined ? {} : { limit }) });
    }
    case "project create":
      return client.createProject(
        {
          namespace: required(values.namespace, "namespace"),
          name: required(values.name, "name"),
          source: sourceOf(values),
        },
        idempotent,
      );
    // With no --scope, Keel lets the agent read and work.
    case "project invite": {
      const scopes = scopesOf(values.scope);
      return client.inviteToProject(
        required(values.project, "project"),
        required(values.agent, "agent"),
        { ...(scopes.length === 0 ? {} : { scopes }), ...idempotent },
      );
    }
    case "agent enrol": {
      const kind = KINDS.find((k) => k === (values.kind ?? "interactive"));
      if (kind === undefined) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
      const scopes = scopesOf(values.scope);
      if (scopes.length === 0) throw new UsageError("missing --scope");
      return client.enrolAgent(
        {
          name: required(values.name, "name"),
          kind,
          scopes,
          projectId: required(values.project, "project"),
        },
        idempotent,
      );
    }
    default:
      if (command[0] === "status" && command.length === 2)
        return client.status(required(command[1], "change"), waiting);
      if (command[0] === "revise" && command.length === 2) {
        const revision = count(required(values["if-match"], "if-match"), "if-match") ?? 0;
        return client.revise(
          required(command[1], "change"),
          {
            ...(values.goal === undefined ? {} : { goal: values.goal }),
            ...(values.footprint === undefined
              ? {}
              : { footprint: values.footprint.map(footprintOf) }),
            premisesAdded: (values["add-premise"] ?? []).map(propositionOf),
            premisesRetracted: (values["retract-premise"] ?? []).map(propositionOf),
          },
          { lease: required(values.lease, "lease"), ifMatch: revision, ...idempotent },
        );
      }
      if (command[0] === "rely" && command.length === 2)
        return client.rely(
          required(command[1], "change"),
          { premise: propositionOf(required(values.premise, "premise")) },
          { lease: required(values.lease, "lease"), ...idempotent },
        );
      if (command[0] === "agent" && command[1] === "join" && command.length === 3)
        return client.acceptInvitation(required(command[2], "namespace"), idempotent);
      if (command[0] === "agent" && command[1] === "use" && command.length === 3)
        return client.useProject(required(command[2], "project"));
      if (command[0] === "nearby" && command.length === 2)
        return client.nearby(required(command[1], "change"));
      if (command[0] === "rebase" && command.length === 2)
        return client.rebase(required(command[1], "change"), {
          lease: required(values.lease, "lease"),
          ...idempotent,
        });
      if (command[0] === "adopt" && command.length === 2)
        return client.adopt(required(command[1], "change"), idempotent);
      // No --lease is an operator's withdrawal; Keel refuses it to anyone else.
      if (command[0] === "abandon" && command.length === 2)
        return client.abandon(
          required(command[1], "change"),
          values.reason === undefined ? {} : { reason: values.reason },
          { ...(values.lease === undefined ? {} : { lease: values.lease }), ...idempotent },
        );
      throw new UsageError(`unknown command: ${command.join(" ") || "(none)"}`);
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

/** `why`: the chain Keel answers for a path or a subject, each decision with its records. */
async function whyCommand(
  io: Io,
  client: KeelClient,
  values: ReturnType<typeof parse>["values"],
): Promise<ExitCode> {
  const line = count(values.line, "line");
  const answer = await client.why({
    ...(values.path === undefined ? {} : { path: values.path }),
    ...(line === undefined ? {} : { line }),
    ...(values.subject === undefined ? {} : { subject: values.subject }),
  });
  io.stdout(values.json === true ? JSON.stringify(answer, null, 2) : chainText(answer));
  return 0;
}

/** A human line for an answer: the agent envelope's summary when it has one. */
function summaryOf(answer: unknown): string {
  const summary = Reflect.get(Object(answer), "summary");
  return typeof summary === "string" ? summary : JSON.stringify(answer, null, 2);
}

const NO_KEY =
  "This machine holds no agent key for this Keel. Run `keeltown agent signup` to make one and sign up with it.";

/** The project and the run a key's tokens are for: the command line's, else the environment's. */
function target(values: ReturnType<typeof parse>["values"], env: Io["env"]) {
  const project = values.project ?? env["KEEL_PROJECT"];
  const label = values.run ?? env["KEEL_RUN"];
  return {
    ...(project === undefined || project === "" ? {} : { project }),
    ...(label === undefined || label === "" ? {} : { run: label }),
  };
}

/** An agent's key, once it has signed up: what a token is asked with. */
type SignedUpKey = Held & { readonly agentId: string };

async function signedUpKey(io: Io, entry: string): Promise<SignedUpKey | undefined> {
  const held = await heldKey(io.env, io.keyStore, entry);
  if (held === undefined) return undefined;
  if (held.agentId === undefined)
    throw new KeyError(
      held.stored === undefined
        ? "KEEL_AGENT_KEY is set without KEEL_AGENT_ID: `keeltown agent signup` prints the agent's id"
        : "this machine's key has not signed up yet: run `keeltown agent signup`",
    );
  return { ...held, agentId: held.agentId };
}

/**
 * `agent signup`: the key is made and put in the key store before Keel is
 * asked, so a crash after sign-up never loses it. The same key signs up as the
 * same agent, so running it again is safe.
 */
async function signUpCommand(
  io: Io,
  values: ReturnType<typeof parse>["values"],
  baseUrl: string,
  entry: string,
): Promise<ExitCode> {
  const asked = {
    baseUrl,
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  };
  if (values["print-key"] === true) {
    // A key for somewhere else to keep: printed once, before Keel is asked, and written nowhere.
    const { signer, privateJwk } = await generateAgentKey();
    io.stdout(JSON.stringify(privateJwk));
    const made = await signUp({ ...asked, signer });
    io.stderr(
      `Signed up agent ${made.handle}. The line above is the only copy of its private key: keep it in a CI secret or a secret manager as KEEL_AGENT_KEY, with KEEL_AGENT_ID=${made.agentId}. Keel cannot give it back.`,
    );
    return 0;
  }
  let held = await heldKey(io.env, io.keyStore, entry);
  if (held === undefined) {
    if (io.keyStore === undefined) {
      io.stderr(
        "This machine has no key store the CLI can use, and a key is never written to a file. Set KEEL_AGENT_KEY to the agent's private key, or run `keeltown agent signup --print-key` to make one and print it once for a secret manager.",
      );
      return 2;
    }
    const { signer, privateJwk } = await generateAgentKey();
    await io.keyStore.write(entry, encodeEntry({ jwk: privateJwk }));
    held = { signer, where: io.keyStore.kind, stored: privateJwk };
  }
  const made = await signUp({ ...asked, signer: held.signer });
  if (held.stored !== undefined && io.keyStore !== undefined)
    await io.keyStore.write(
      entry,
      encodeEntry({ jwk: held.stored, agentId: made.agentId, handle: made.handle }),
    );
  io.stdout(
    values.json === true
      ? JSON.stringify({ ...made, key: held.where }, null, 2)
      : `${made.created ? "Signed up" : "Already signed up:"} agent ${made.handle} (${made.agentId}). Its key is held in ${held.where}.`,
  );
  return 0;
}

/** The commands about the key itself. Undefined for every other command. */
async function keyCommand(
  io: Io,
  command: string,
  values: ReturnType<typeof parse>["values"],
  baseUrl: string,
  entry: string,
): Promise<ExitCode | undefined> {
  if (command === "agent signup") return signUpCommand(io, values, baseUrl, entry);
  if (command !== "agent show" && command !== "token") return undefined;
  const held = await signedUpKey(io, entry);
  if (held === undefined) {
    io.stderr(NO_KEY);
    return 2;
  }
  if (command === "agent show") {
    const shown = {
      agentId: held.agentId,
      ...(held.handle === undefined ? {} : { handle: held.handle }),
      thumbprint: await thumbprint(held.signer.publicJwk),
      key: held.where,
    };
    io.stdout(
      values.json === true
        ? JSON.stringify(shown, null, 2)
        : `Agent ${shown.handle ?? shown.agentId} (${shown.agentId}). Its key ${shown.thumbprint} is held in ${shown.key}.`,
    );
    return 0;
  }
  // A plain bearer, for a tool that cannot sign: good for five minutes, one project and one run.
  const token = await createKeelClient({
    baseUrl,
    agentId: held.agentId,
    key: held.signer,
    bound: false,
    ...target(values, io.env),
    // Each of Keel's doors takes only a token asked for by its own name.
    ...(values.mcp === true ? { resource: `${baseUrl.replace(/\/+$/, "")}/mcp` } : {}),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  }).token();
  io.stdout(values.header === true ? JSON.stringify({ Authorization: `Bearer ${token}` }) : token);
  return 0;
}

/**
 * The commands about a person's sign-in on this machine. Undefined for every
 * other command.
 */
async function personCommand(
  io: Io,
  command: string,
  values: ReturnType<typeof parse>["values"],
  baseUrl: string,
  entry: string,
): Promise<ExitCode | undefined> {
  if (command === "login")
    return loginCommand(io, {
      baseUrl,
      entry,
      printToken: values["print-token"] === true,
      json: values.json === true,
    });
  if (command === "logout") return logoutCommand(io, { baseUrl, entry });
  if (command === "auth setup-git")
    return setupGit(io, baseUrl, values.profile ?? io.env["KEEL_PROFILE"]);
  return undefined;
}

/** A client, and whether it acts as an agent or as a person. */
interface Acting {
  readonly client: KeelClient;
  readonly as: "agent" | "person";
}

const asAgent = (client: KeelClient): Acting => ({ client, as: "agent" });
const asPerson = (client: KeelClient | undefined): Acting | undefined =>
  client === undefined ? undefined : { client, as: "person" };

/**
 * The client a work command runs as: an agent's secret or a user's session
 * when set, else the agent this machine holds a key for, else the person
 * signed in on it.
 */
async function clientFor(
  io: Io,
  values: ReturnType<typeof parse>["values"],
  baseUrl: string,
  entry: string,
): Promise<Acting | undefined> {
  const clientId = io.env["KEEL_CLIENT_ID"];
  const clientSecret = io.env["KEEL_CLIENT_SECRET"];
  const session = io.env["KEEL_SESSION"];
  const fetch = io.fetch === undefined ? {} : { fetch: io.fetch };
  // An agent's credentials win when both are set: work is an agent's.
  if (clientId !== undefined && clientSecret !== undefined)
    return asAgent(createKeelClient({ baseUrl, clientId, clientSecret, ...fetch }));
  if (session !== undefined) return asPerson(createKeelClient({ baseUrl, session, ...fetch }));
  const held = await signedUpKey(io, entry);
  if (held !== undefined)
    return asAgent(
      createKeelClient({
        baseUrl,
        agentId: held.agentId,
        key: held.signer,
        ...target(values, io.env),
        ...fetch,
      }),
    );
  // No agent's credential at all: the person signed in on this machine.
  return asPerson(await personFor(io, baseUrl, entry));
}

const PERSON_ONLY =
  "Inviting an agent is a person's move, never an agent's. Run `keeltown login` and approve it with a passkey first: Keel wants one from the last ten minutes.";

/**
 * The client of the person signed in on this machine, or KEEL_SESSION's, and
 * of nobody else: no agent's credential stands in for one. Undefined when no
 * person is signed in.
 */
async function personFor(io: Io, baseUrl: string, entry: string): Promise<KeelClient | undefined> {
  const signIn = await heldSignIn(io.env, io.signIns, entry);
  return signIn === undefined
    ? undefined
    : createKeelClient({
        baseUrl,
        session: signIn.token,
        ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      });
}

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) {
    io.stdout(USAGE);
    return positionals.length === 0 && values.help !== true ? 2 : 0;
  }
  // git names the host it wants a credential for, so its helper runs with no KEEL_URL.
  if (positionals[0] === "auth" && positionals[1] === "git-credential" && positionals.length <= 3)
    return gitCredential(io, positionals[2], values.profile ?? io.env["KEEL_PROFILE"]);
  const baseUrl = io.env["KEEL_URL"];
  if (baseUrl === undefined) {
    io.stderr("Set KEEL_URL to Keel's address, such as https://keel.town.");
    return 2;
  }
  try {
    const entry = entryName(baseUrl, values.profile ?? io.env["KEEL_PROFILE"]);
    const person = await personCommand(io, positionals.join(" "), values, baseUrl, entry);
    if (person !== undefined) return person;
    const about = await keyCommand(io, positionals.join(" "), values, baseUrl, entry);
    if (about !== undefined) return about;
    // An invitation is the person's to make, on a fresh sign-in, whatever agent this machine holds.
    const personOnly = positionals.join(" ") === "project invite";
    const acting = personOnly
      ? asPerson(await personFor(io, baseUrl, entry))
      : await clientFor(io, values, baseUrl, entry);
    if (acting === undefined) {
      io.stderr(
        personOnly
          ? PERSON_ONLY
          : `${NO_KEY} Or run \`keeltown login\` to sign in as yourself, or set KEEL_CLIENT_ID with KEEL_CLIENT_SECRET (an agent's secret) or KEEL_SESSION (a user).`,
      );
      return 2;
    }
    const { client } = acting;
    if (positionals.join(" ") === "why") return await whyCommand(io, client, values);
    // `whoami` answers for whoever the command runs as: an agent's own record, or the person's.
    const answer =
      positionals.join(" ") === "whoami" && acting.as === "person"
        ? await client.me()
        : await dispatch(client, positionals, values);
    io.stdout(values.json === true ? JSON.stringify(answer, null, 2) : summaryOf(answer));
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof KeyError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof KeelProblem) {
      if (values.json === true) io.stdout(JSON.stringify(error.body, null, 2));
      io.stderr(
        `${error.code}: ${error.body.detail ?? error.body.title} (request ${error.requestId})`,
      );
      for (const next of error.nextActions)
        io.stderr(
          `  next: ${next.title}${next.operationId === undefined ? "" : ` [${next.operationId}]`}`,
        );
      return 1;
    }
    if (error instanceof KeelTokenError) {
      io.stderr(error.message);
      return 2;
    }
    if (error instanceof LoginFailed) {
      io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}
