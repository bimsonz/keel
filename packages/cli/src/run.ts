import { parseArgs } from "node:util";
import {
  createKeelClient,
  type KeelClient,
  type KeelClientOptions,
  KeelProblem,
  KeelTokenError,
} from "@keeltown/sdk";

/** Where the CLI writes, and how it reaches Keel; tests pass their own. */
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch?: KeelClientOptions["fetch"];
}

/** 0: done. 1: Keel refused (the next actions are printed). 2: the command line or credentials are wrong. */
export type ExitCode = 0 | 1 | 2;

const USAGE = `keeltown <command> [options]

  whoami
  session open [--harness <name>] [--model <id>] [--key <idempotency-key>]
  declare --goal <text> [--footprint <path[:edit|create|delete]>]... [--key <idempotency-key>]
  revise <chg_…> --lease <lse_…> --if-match <revision> [--goal <text>] [--footprint <path[:op]>]... [--add-premise <json>]... [--retract-premise <json>]... [--key <idempotency-key>]
  rely <chg_…> --lease <lse_…> --premise <json> [--key <idempotency-key>]
  nearby <chg_…>
  submit --change <chg_…> --commit <sha> --lease <lse_…> [--key <idempotency-key>]
  status <chg_…> [--wait <0-30>]
  rebase <chg_…> --lease <lse_…> [--key <idempotency-key>]
  adopt <chg_…> [--key <idempotency-key>]
  abandon <chg_…> [--reason <text>] [--lease <lse_…>] [--key <idempotency-key>]
  inbox [--cursor <cursor>] [--wait <0-30>]
  events [--cursor <cursor>] [--wait <0-30>] [--limit <1-500>]
  project create --namespace <handle> --name <name> --source <repo> [--key <idempotency-key>]
  agent enrol --project <prj_…> --name <name> --scope <scope>... [--kind interactive|hosted|human|synthetic] [--key <idempotency-key>]

A premise is a proposition as JSON: {"subject", "predicate", "relation", "value", …}.
Credentials: KEEL_URL, and an agent's KEEL_CLIENT_ID and KEEL_CLIENT_SECRET, or a user's KEEL_SESSION.
Projects and agents are governed by a user (KEEL_SESSION); work is done by an agent.
Every command prints Keel's answer; --json prints it as JSON.`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  goal: { type: "string" },
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
  source: { type: "string" },
  scope: { type: "string", multiple: true },
  kind: { type: "string" },
  project: { type: "string" },
  harness: { type: "string" },
  model: { type: "string" },
  "if-match": { type: "string" },
  premise: { type: "string" },
  "add-premise": { type: "string", multiple: true },
  "retract-premise": { type: "string", multiple: true },
} as const;

class UsageError extends Error {}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`missing --${flag}`);
  return value;
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

function isProposition(value: unknown): value is Proposition {
  const field = (name: string) => Reflect.get(Object(value), name);
  const scalar = field("value");
  return (
    typeof value === "object" &&
    value !== null &&
    typeof field("subject") === "string" &&
    typeof field("predicate") === "string" &&
    typeof field("relation") === "string" &&
    (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean")
  );
}

const KINDS = ["interactive", "hosted", "human", "synthetic"] as const;
const SCOPES = ["agent:work", "agent:read"] as const;

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
          source: required(values.source, "source"),
        },
        idempotent,
      );
    case "agent enrol": {
      const kind = KINDS.find((k) => k === (values.kind ?? "interactive"));
      if (kind === undefined) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
      const scopes = (values.scope ?? []).map((scope) => {
        const known = SCOPES.find((s) => s === scope);
        if (known === undefined) throw new UsageError(`unknown scope ${scope}`);
        return known;
      });
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

/** A human line for an answer: the agent envelope's summary when it has one. */
function summaryOf(answer: unknown): string {
  const summary = Reflect.get(Object(answer), "summary");
  return typeof summary === "string" ? summary : JSON.stringify(answer, null, 2);
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
  const baseUrl = io.env["KEEL_URL"];
  const clientId = io.env["KEEL_CLIENT_ID"];
  const clientSecret = io.env["KEEL_CLIENT_SECRET"];
  const session = io.env["KEEL_SESSION"];
  const agent = clientId !== undefined && clientSecret !== undefined;
  if (baseUrl === undefined || (!agent && session === undefined)) {
    io.stderr(
      "Set KEEL_URL, and KEEL_CLIENT_ID with KEEL_CLIENT_SECRET (an agent) or KEEL_SESSION (a user).",
    );
    return 2;
  }
  const fetch = io.fetch === undefined ? {} : { fetch: io.fetch };
  // An agent's credentials win when both are set: work is an agent's.
  const client = createKeelClient(
    agent
      ? { baseUrl, clientId, clientSecret, ...fetch }
      : { baseUrl, session: session ?? "", ...fetch },
  );
  try {
    const answer = await dispatch(client, positionals, values);
    io.stdout(values.json === true ? JSON.stringify(answer, null, 2) : summaryOf(answer));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
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
    throw error;
  }
}
