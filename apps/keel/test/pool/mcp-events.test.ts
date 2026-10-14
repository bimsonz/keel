// MCP events through the deployed fetch handler: an agent that signed itself
// up with a key watches its inbox and its project's feed over one
// `subscriptions/listen`, reads both as resources, and holds the inbox tool.
// Every read goes token, gate, door, port, object.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { IntentDeclared } from "@keeltown/core/domain/coordination";
import { agentIdOf, runIdOf } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  agentActor,
  type ChangeId,
  EventEnvelope,
  makeId,
  type ProjectId,
  RunLabel,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";

const MCP = `${BASE}/mcp`;
const REGISTER = `${BASE}/v1/oauth/register`;
const VERSION = "2026-07-28";
const INBOX = "keel://inbox";
const feedOf = (projectId: string) => `keel://projects/${projectId}/events`;

const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

/**
 * An agent that signed up with a key, in a project of its own, with a plain
 * bearer for the MCP door for each of two runs: the client that cannot sign
 * a proof each request presents one.
 */
async function mcpAgent() {
  const account = await newKey();
  const registered = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      dpop: await proofBy(account, "POST", REGISTER),
    },
    body: JSON.stringify({
      jwks: { keys: [account.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    }),
  });
  if (registered.status !== 201)
    throw new Error(`the sign-up answered ${registered.status}: ${await registered.text()}`);
  const agentId = agentIdOf(account.key.jkt);
  agentStub(agentId);
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, agentId);
  await establishProject(projectId);
  const mcpToken = async (run: string) =>
    (
      await granted(
        await requestToken(agentId, account, { project: projectId, run, resource: MCP }),
      )
    ).access_token;
  return { agentId, projectId, a: await mcpToken("run-a"), b: await mcpToken("run-b") };
}

/** One JSON-RPC request to the door, with `_meta` beside the envelope's own keys (a progress token rides it). */
function send(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { readonly name?: string; readonly meta?: object; readonly signal?: AbortSignal } = {},
): Promise<Response> {
  return worker(MCP, {
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: {
      host: "keel.localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": VERSION,
      "mcp-method": method,
      ...(options.name === undefined ? {} : { "mcp-name": options.name }),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "keel-pool-test", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...options.meta,
        },
      },
    }),
  });
}

const Message = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
type Message = typeof Message.Type;
const messageOf = (json: string): Message => Schema.decodeUnknownSync(Message)(JSON.parse(json));

/** What rode a tool's answer: the notices its run had not yet been shown. */
const Riding = Schema.Struct({
  notices: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

/**
 * An answer's stream read a message at a time: `next` answers the next one,
 * "quiet" when none comes within `ms`, "ended" when the stream closes.
 * Keep-alive comments are skipped.
 */
function messages(response: Response) {
  const body = response.body;
  if (body === null) throw new Error("the answer has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const next = async (ms: number): Promise<Message | "quiet" | "ended"> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const frame = /\r?\n\r?\n/.exec(buffered);
      if (frame !== null) {
        const raw = buffered.slice(0, frame.index);
        buffered = buffered.slice(frame.index + frame[0].length);
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data !== "") return messageOf(data);
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) return "quiet";
      pending ??= reader.read();
      const chunk = await Promise.race([
        pending,
        new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), left)),
      ]);
      if (chunk === "quiet") return "quiet";
      pending = undefined;
      if (chunk.done) return "ended";
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  /** Every message until one `match`es, or "quiet" when none does within `ms`. */
  const until = async (ms: number, match: (message: Message) => boolean) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const message = await next(Math.max(0, deadline - Date.now()));
      if (message === "quiet" || message === "ended") return message;
      if (match(message)) return message;
    }
  };
  return { next, until };
}

/** A listen for `uris`, held open until `signal` aborts. */
async function listen(token: string, uris: readonly string[], signal: AbortSignal) {
  const response = await send(
    token,
    "subscriptions/listen",
    { notifications: { resourceSubscriptions: uris } },
    { signal },
  );
  return { status: response.status, ...messages(response) };
}

const acknowledged = (message: Message | "quiet" | "ended") =>
  typeof message === "object" && message.method === "notifications/subscriptions/acknowledged"
    ? message.params?.["notifications"]
    : message;

const updated = (uri: string) => (message: Message) =>
  message.method === "notifications/resources/updated" && message.params?.["uri"] === uri;

/** An event as the fan-out delivers it to the agent's own object. */
const delivered = (fields: Record<string, unknown>) =>
  Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      at: Date.now(),
      affected: [],
      notified: [],
      ...fields,
    }),
  );

/** A change the agent holds under `run`, then its bounce: a notice for that run alone. Answers the notice's id. */
async function noticeFor(agentId: AgentId, run: string): Promise<string> {
  const label = Schema.decodeUnknownSync(RunLabel)(run);
  const named = { run: { id: runIdOf(agentId, { label }), label } };
  const changeId: ChangeId = makeId("chg", ulid());
  await agentStub(agentId).receive([
    delivered({
      type: "IntentDeclared",
      entity: { kind: "change", id: changeId },
      seq: 1,
      dedupeKey: `change:${changeId}/declare-1/IntentDeclared#1`,
      actor: agentActor(agentId),
      ...named,
      payload: Schema.encodeSync(IntentDeclared)(
        IntentDeclared.make({
          changeId,
          agentId,
          ...named,
          origin: "agent",
          revision: 1,
          goal: "Cache permission lookups per request",
          footprint: [],
          premises: [],
          leaseId: makeId("lse", ulid()),
        }),
      ),
    }),
  ]);
  return bounce(agentId, changeId);
}

/** A bounce of `changeId`: a notice for the run that holds it, or for every run when nobody does (a change of its own when none is given). */
async function bounce(
  agentId: AgentId,
  changeId: ChangeId = makeId("chg", ulid()),
  seq = 2,
): Promise<string> {
  const event = delivered({
    type: "ChangeBounced",
    entity: { kind: "change", id: changeId },
    seq,
    dedupeKey: `change:${changeId}/cause-${seq}/ChangeBounced#1`,
    payload: { _tag: "ChangeBounced" },
  });
  await agentStub(agentId).receive([event]);
  return event.eventId;
}

/** A change starting in `project`, delivered to the Projector as the Change DO's outbox would. */
async function arrive(project: ProjectId) {
  const changeId = makeId("chg", ulid());
  const event = Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: "ChangeStarted",
    entity: { kind: "change", id: changeId },
    seq: 1,
    at: Date.now(),
    dedupeKey: `change:${changeId}/mcp-events/ChangeStarted#1`,
    project,
    affected: [],
    notified: [],
    payload: { _tag: "ChangeStarted", changeId, workspaceId: makeId("wsp", ulid()) },
  });
  await projector().receive([Schema.encodeSync(EventEnvelope)(event)]);
  return event.eventId;
}

/** A tool's answer: a whole JSON body, or the result frame at the end of a stream. */
async function toolResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const json = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .find((line) => line.includes('"result"')) ?? "{}");
  const message = messageOf(json);
  if (message.result === undefined) throw new Error(`MCP error: ${json}`);
  return message.result;
}

/** The notices that rode a `whoami` answer through the door: what the run has not yet been shown. */
async function riding(token: string): Promise<string[]> {
  const result = await toolResult(
    await send(token, "tools/call", { name: "whoami", arguments: {} }, { name: "whoami" }),
  );
  const content = Schema.decodeUnknownSync(Riding)(result["structuredContent"]);
  return (content.notices ?? []).map((notice) => notice.id);
}

/** A resource read through the door: its JSON, or the error it was refused with. */
async function read(token: string, uri: string) {
  const response = await send(token, "resources/read", { uri }, { name: uri });
  const message = await response.json<{
    readonly result?: { readonly contents: readonly { uri: string; text: string }[] };
    readonly error?: { readonly code: number; readonly message: string };
  }>();
  if (message.error !== undefined) return { error: message.error };
  const [first] = message.result?.contents ?? [];
  const body: unknown = JSON.parse(first?.text ?? "null");
  return { uri: first?.uri, body };
}

/** How many reads wait on the agent's own object now. */
const waiting = (agentId: AgentId) =>
  runInDurableObject(
    env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)),
    (instance: object) => {
      const waiters: unknown = Reflect.get(instance, "waiters");
      const pending: unknown =
        typeof waiters === "object" && waiters !== null ? Reflect.get(waiters, "pending") : null;
      if (!(pending instanceof Set)) throw new Error("the object keeps no waiters");
      return pending.size;
    },
  );

describe("MCP events", () => {
  it("[mcp.discover] the server says to the current revision that a resource may be watched", async () => {
    const agent = await mcpAgent();
    const discovered = await toolResult(await send(agent.a, "server/discover"));
    expect(discovered["capabilities"]).toMatchObject({ resources: { subscribe: true } });
  });

  it("[mcp.listen-ack] a listen is acknowledged only for the agent's own inbox and its token's project's feed; an enrolled agent's token and a person's for none", async () => {
    const agent = await mcpAgent();
    const elsewhere = await mcpAgent();
    const stop = new AbortController();
    try {
      const own = await listen(
        agent.a,
        [INBOX, feedOf(agent.projectId), feedOf(elsewhere.projectId), "keel://other"],
        stop.signal,
      );
      expect(own.status).toBe(200);
      expect(acknowledged(await own.next(5_000))).toEqual({
        resourceSubscriptions: [INBOX, feedOf(agent.projectId)],
      });
      const enrolled = await tokenFor(await seedAgent());
      const person = (await seedUser(uniqueHandle("listener"))).token;
      for (const token of [enrolled, person]) {
        const theirs = await listen(token, [INBOX, feedOf(agent.projectId)], stop.signal);
        expect(acknowledged(await theirs.next(5_000))).toEqual({});
      }
    } finally {
      stop.abort();
    }
  });

  it("[mcp.listen-notice] a notice for the listening run is told as an update of the inbox within seconds, one for another run is not, and the listen counts nothing as read", async () => {
    const agent = await mcpAgent();
    const stop = new AbortController();
    try {
      const stream = await listen(agent.a, [INBOX], stop.signal);
      await stream.next(5_000);
      await noticeFor(agent.agentId, "run-b");
      expect(await stream.until(2_000, updated(INBOX))).toBe("quiet");
      const started = Date.now();
      const notice = await noticeFor(agent.agentId, "run-a");
      const told = await stream.until(10_000, updated(INBOX));
      expect(told).toMatchObject({
        method: "notifications/resources/updated",
        params: { uri: INBOX, _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      // Told, not shown: the notice still rides the run's next tool result.
      expect(await riding(agent.a)).toContain(notice);
    } finally {
      stop.abort();
    }
  });

  it("[mcp.listen-feed] an event of the token's project is told as an update of its feed", async () => {
    const agent = await mcpAgent();
    const stop = new AbortController();
    try {
      const stream = await listen(agent.a, [feedOf(agent.projectId)], stop.signal);
      await stream.next(5_000);
      await arrive(agent.projectId);
      expect(await stream.until(10_000, updated(feedOf(agent.projectId)))).toMatchObject({
        params: { uri: feedOf(agent.projectId) },
      });
    } finally {
      stop.abort();
    }
  });

  it("[mcp.resources] the inbox reads as its last page and counts it read; a feed reads as its head, after what is on it; another project's feed is refused", async () => {
    const agent = await mcpAgent();
    const elsewhere = await mcpAgent();
    for (let n = 0; n < 50; n += 1) await bounce(agent.agentId);
    const newest = await bounce(agent.agentId);

    const inbox = await read(agent.a, INBOX);
    expect(inbox.uri).toBe(INBOX);
    expect(inbox.body).toMatchObject({ result: { notices: [{ id: newest }] } });
    expect(await riding(agent.a)).toEqual([]);

    // An event already on the feed: the resource answers the head, after it, not the feed from its start.
    await arrive(agent.projectId);
    const feed = await read(agent.a, feedOf(agent.projectId));
    expect(feed.body).toMatchObject({ items: [], nextCursor: expect.stringMatching(/^\d{12}$/) });
    expect(await read(agent.a, feedOf(elsewhere.projectId))).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("[mcp.wait] the inbox tool given a progress token tells the client at once and answers when a notice lands", async () => {
    const agent = await mcpAgent();
    const started = Date.now();
    const response = await send(
      agent.a,
      "tools/call",
      { name: "inbox", arguments: { cursor: "end", wait: 120 } },
      { name: "inbox", meta: { progressToken: "held" } },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = messages(response);
    expect(await stream.next(5_000)).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "held" },
    });
    const notice = await bounce(agent.agentId);
    const answer = await stream.until(10_000, (message) => message.result !== undefined);
    expect(answer).toMatchObject({
      result: { structuredContent: { result: { notices: [{ id: notice }] } } },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("[mcp.listen-ends] when the client goes, the held reads stop: what lands next answers the last one, and none waits after it", async () => {
    const agent = await mcpAgent();
    const stop = new AbortController();
    const stream = await listen(agent.a, [INBOX], stop.signal);
    await stream.next(5_000);
    await expect.poll(() => waiting(agent.agentId), { timeout: 5_000 }).toBe(1);
    stop.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await bounce(agent.agentId);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await waiting(agent.agentId)).toBe(0);
  });

  it("[mcp.listen-standing] a paused agent's listen ends within one deadline, with the stream's last result", async () => {
    const agent = await mcpAgent();
    const stop = new AbortController();
    try {
      const stream = await listen(agent.a, [INBOX], stop.signal);
      await stream.next(5_000);
      await env.DB.prepare("UPDATE agents SET state = 'suspended' WHERE id = ?")
        .bind(agent.agentId)
        .run();
      const last = await stream.until(40_000, (message) => message.result !== undefined);
      expect(last).toMatchObject({ result: { resultType: "complete" } });
      expect(await stream.next(5_000)).toBe("ended");
    } finally {
      stop.abort();
    }
  }, 60_000);
});
