// The live work-loop smoke: one agent declares, pushes and submits against a
// deployed Keel, and asks each of declare, submit, status and inbox over REST
// and again as an MCP tool. One handler object serves both doorways, so the
// answers must agree: a declare or submit retried over MCP under the same
// Idempotency-Key replays the REST answer, and status and inbox read the same
// state. The REST calls go through the SDK; MCP is spoken with plain fetch, as
// an outside agent would.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeelClient } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush } from "../lib/git.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";

export interface Check {
  readonly ok: boolean;
  readonly what: string;
  readonly detail?: unknown;
}

/** One MCP tool call; answers its structuredContent. */
async function tool(
  keelUrl: string,
  token: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetch(`${keelUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "keel-smoke", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`MCP ${name} answered ${response.status}: ${text.slice(0, 400)}`);
  const json: unknown = JSON.parse(
    text.startsWith("{")
      ? text
      : (text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? "null"),
  );
  const result: unknown = Reflect.get(Object(json), "result");
  return Reflect.get(Object(result), "structuredContent");
}

/** Equal as JSON, keys in any order. */
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, sorted(v)]),
  );
}

/** A retried grant mints a fresh workspace token with its own expiry; nothing else may differ. */
function withoutGrantToken(answer: unknown): unknown {
  const result: unknown = Reflect.get(Object(answer), "result");
  const workspace: unknown = Reflect.get(Object(result), "workspace");
  return {
    ...Object(answer),
    result: { ...Object(result), workspace: { ...Object(workspace), token: "", expiresAt: "" } },
  };
}

/** Each piggybacked notice rides one answer only, so two reads compare without them. */
const withoutNotices = (answer: unknown): unknown => ({ ...Object(answer), notices: [] });

/** A field of an answer's `result`, read loosely: the smoke compares bodies, not types. */
const resultField = (answer: unknown, name: string): unknown =>
  Reflect.get(Object(Reflect.get(Object(answer), "result")), name);

const submissionOf = (answer: unknown): unknown[] =>
  ["changeId", "revision", "commitSha"].map((name) => resultField(answer, name));

/**
 * Whether two answers are of one submission. A replay under the same key answers the
 * submission as it is now, and the Precheck may start between the first answer and the
 * replay: the state moves, and the summary, next actions and notices with it. Which
 * change, which revision and which commit do not.
 */
export function sameSubmission(a: unknown, b: unknown): boolean {
  return (
    submissionOf(a).every((part) => part !== undefined) && same(submissionOf(a), submissionOf(b))
  );
}

/**
 * Whether two reads of an inbox from one cursor, a moment apart, are of one page. A notice
 * may land between them, so one page may hold the other and more: they agree as far as
 * the shorter goes, and two of one length end at one cursor.
 */
export function samePageSoFar(a: unknown, b: unknown): boolean {
  const [one, other] = [resultField(a, "notices"), resultField(b, "notices")];
  if (!Array.isArray(one) || !Array.isArray(other)) return false;
  const shared = Math.min(one.length, other.length);
  if (!same(one.slice(0, shared), other.slice(0, shared))) return false;
  return one.length !== other.length || same(resultField(a, "cursor"), resultField(b, "cursor"));
}

export async function workLoopSmoke(
  keelUrl: string,
  agent: KeelClient,
  run: string,
): Promise<readonly Check[]> {
  const checks: Check[] = [];
  const check = (ok: boolean, what: string, detail?: unknown) =>
    checks.push({ ok, what, ...(ok ? {} : { detail }) });
  const token = await agent.token();
  const intent = {
    goal: `Add the smoke note for run ${run}`,
    footprint: [{ path: `smoke/${run}.md`, op: "create" as const }],
    premises: [],
  };

  const declareKey = `smoke:${run}:declare`;
  const declared = await agent.declare(intent, { idempotencyKey: declareKey });
  const declaredOverMcp = await tool(keelUrl, token, "declare", {
    "idempotency-key": declareKey,
    ...intent,
  });
  check(
    same(
      withoutNotices(withoutGrantToken(declaredOverMcp)),
      withoutNotices(withoutGrantToken(declared)),
    ),
    "declare: the MCP tool replays the REST declare under the same key",
    { rest: declared, mcp: declaredOverMcp },
  );

  const { change, workspace, lease } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const dir = cloneWorkspace(workspace.remote, workspace.token);
  let commitSha: string;
  try {
    mkdirSync(join(dir, "smoke"), { recursive: true });
    writeFileSync(join(dir, "smoke", `${run}.md`), `The smoke for run ${run}.\n`);
    commitSha = commitAndPush(dir, workspace.token, "smoke", intent.goal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const submitKey = `smoke:${run}:submit`;
  const submitted = await agent.submit(
    { changeId: change.id, commitSha },
    { lease: lease.id, idempotencyKey: submitKey },
  );
  const submittedOverMcp = await tool(keelUrl, token, "submit", {
    "idempotency-key": submitKey,
    "keel-lease": lease.id,
    changeId: change.id,
    commitSha,
  });
  check(
    sameSubmission(submittedOverMcp, submitted),
    "submit: the MCP tool replays the REST submit under the same key",
    { rest: submitted, mcp: submittedOverMcp },
  );

  // Precheck may move the change between two reads; read both again until they agree on one state.
  let status: { rest: unknown; mcp: unknown } = { rest: undefined, mcp: undefined };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    status = {
      rest: await agent.status(change.id),
      mcp: await tool(keelUrl, token, "status", { changeId: change.id }),
    };
    if (same(withoutNotices(status.rest), withoutNotices(status.mcp))) break;
  }
  check(
    same(withoutNotices(status.rest), withoutNotices(status.mcp)),
    "status: REST and MCP read the same submission",
    status,
  );

  const first = await agent.inbox();
  const cursor = first.result.cursor;
  const inbox = {
    rest: await agent.inbox({ cursor }),
    mcp: await tool(keelUrl, token, "inbox", { cursor }),
  };
  check(
    samePageSoFar(inbox.rest, inbox.mcp),
    "inbox: REST and MCP read the same page from the same cursor",
    inbox,
  );
  check(
    !same(withoutNotices(withoutGrantToken(declared)), withoutNotices(submitted)),
    "two different operations' answers differ (the comparison can fail)",
  );
  return checks;
}
