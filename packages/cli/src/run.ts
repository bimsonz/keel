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
  declare --goal <text> [--footprint <path[:edit|create|delete]>]... [--key <idempotency-key>]
  submit --change <chg_…> --commit <sha> --lease <lse_…> [--key <idempotency-key>]
  status <chg_…> [--wait <0-30>]
  abandon <chg_…> [--reason <text>] [--lease <lse_…>] [--key <idempotency-key>]
  inbox [--cursor <cursor>] [--wait <0-30>]
  events [--cursor <cursor>] [--wait <0-30>] [--limit <1-500>]
  project create --name <name> --source <repo> [--key <idempotency-key>]
  agent enrol --name <name> --scope <scope>... [--kind interactive|hosted|human|synthetic] [--project <prj_…>] [--on-behalf-of <scheme:value>] [--key <idempotency-key>]

Credentials: KEEL_URL, KEEL_CLIENT_ID and KEEL_CLIENT_SECRET.
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
  source: { type: "string" },
  scope: { type: "string", multiple: true },
  kind: { type: "string" },
  project: { type: "string" },
  "on-behalf-of": { type: "string" },
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

const KINDS = ["interactive", "hosted", "human", "synthetic"] as const;
const SCOPES = ["agent:work", "agent:read", "operator", "observer"] as const;

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
        { name: required(values.name, "name"), source: required(values.source, "source") },
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
          ...(values.project === undefined ? {} : { projectId: values.project }),
          ...(values["on-behalf-of"] === undefined ? {} : { onBehalfOf: values["on-behalf-of"] }),
        },
        idempotent,
      );
    }
    default:
      if (command[0] === "status" && command.length === 2)
        return client.status(required(command[1], "change"), waiting);
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
  if (baseUrl === undefined || clientId === undefined || clientSecret === undefined) {
    io.stderr("Set KEEL_URL, KEEL_CLIENT_ID and KEEL_CLIENT_SECRET.");
    return 2;
  }
  const client = createKeelClient({
    baseUrl,
    clientId,
    clientSecret,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
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
