import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type AgentId, type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import type { SocketFrame } from "../../src/adapters/driving/notices.ts";
import { AgentSessionCodecs, decodeExit, EventCodecs } from "../../src/rpc/index.ts";
import { BASE, drainAfter, seedAgent, seedUser, tokenFor } from "./helpers.ts";

const WAIT = { timeout: 5_000, interval: 20 };

const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

/** A platform-caused event about some change, encoded as the fan-out delivers it. */
const platformEvent = () => {
  const entity: EntityRef = { kind: "change", id: makeId("chg", ulid()) };
  return Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "ChangeBounced",
      entity,
      seq: 1,
      at: Date.now(),
      dedupeKey: `change:${entity.id}/cause-1/ChangeBounced#1`,
      affected: [],
      notified: [],
      payload: { _tag: "ChangeBounced" },
    }),
  );
};

/** Delivers `count` events to the agent, one delivery each; answers their ids in order. */
async function deliver(agentId: AgentId, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const event = platformEvent();
    await agentStub(agentId).receive([event]);
    ids.push(event.eventId);
  }
  return ids;
}

/** The cursor of each notice in the agent's inbox, in order. */
async function cursorsOf(agentId: AgentId): Promise<string[]> {
  const page = decodeExit(AgentSessionCodecs.inbox, await agentStub(agentId).inbox({ waitMs: 0 }));
  if (!Exit.isSuccess(page)) throw new Error("the inbox read failed");
  return page.value.notices.map((notice) => notice.cursor ?? "");
}

async function enrolled() {
  const seeded = await seedAgent();
  return { agentId: seeded.agent.id, token: await tokenFor(seeded) };
}

/** Reads SSE events off a stream, skipping comments; each `next()` answers the next notice event. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<{ id: string; data: { id: string; cursor?: string } }> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const lines = block.split("\n");
          if (!lines.includes("event: notice")) continue;
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";
          return { id: field("id"), data: JSON.parse(field("data")) };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the stream ended");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** Opens the agent's inbox socket through the real fetch handler and collects its frames. */
async function connect(token: string, cursor?: string) {
  const response = await exports.default.fetch(
    `${BASE}/v1/inbox/socket${cursor === undefined ? "" : `?cursor=${cursor}`}`,
    { headers: { authorization: `Bearer ${token}`, upgrade: "websocket" } },
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null)
    throw new Error(`the upgrade answered ${response.status}: ${await response.text()}`);
  const frames: SocketFrame[] = [];
  socket.addEventListener("message", (message) => {
    const frame: SocketFrame = JSON.parse(String(message.data));
    frames.push(frame);
  });
  socket.accept();
  return { socket, frames };
}

describe("the agent's SSE stream", () => {
  it("[b12.sse] streams each notice as an event with its cursor, resuming after Last-Event-ID", async () => {
    const { agentId, token } = await enrolled();
    const delivered = await deliver(agentId, 2);
    const [first, second] = await cursorsOf(agentId);

    const response = await exports.default.fetch(`${BASE}/v1/inbox/stream`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": first ?? "" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    if (response.body === null) throw new Error("no stream");
    const events = sseReader(response.body);

    const resumed = await events.next();
    const [later] = await deliver(agentId, 1);
    const live = await events.next();
    await events.cancel();

    expect(resumed).toMatchObject({ id: second, data: { id: delivered[1], cursor: second } });
    expect(live.data.id).toBe(later);
  });

  it("refuses a cursor Keel never gave out", async () => {
    const { token } = await enrolled();
    const response = await exports.default.fetch(`${BASE}/v1/inbox/stream`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": "not-a-cursor" },
    });
    expect(response.status).toBe(400);
  });
});

describe("the agent's WebSocket", () => {
  it("[b12.ws-snapshot] sends the snapshot after the cursor as it accepts, then each new notice", async () => {
    const { agentId, token } = await enrolled();
    const delivered = await deliver(agentId, 3);
    const [first] = await cursorsOf(agentId);

    const { socket, frames } = await connect(token, first);
    await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 2_000, interval: 20 });
    const [later] = await deliver(agentId, 1);
    await vi.waitFor(() => expect(frames).toHaveLength(2), WAIT);
    socket.close();

    expect(frames[0]?.type).toBe("snapshot");
    expect(frames[0]?.notices.map((notice) => notice.id)).toEqual(delivered.slice(1));
    expect(frames[1]).toMatchObject({ type: "notices", notices: [{ id: later }] });
  });

  it("[b12.ws-post-commit] sends nothing for a delivery whose transaction rolled back", async () => {
    const { agentId, token } = await enrolled();
    const { socket, frames } = await connect(token);
    await vi.waitFor(() => expect(frames).toHaveLength(1), WAIT);

    const crashed = await runInDurableObject(
      agentStub(agentId),
      async (instance: AgentSessionDO) => {
        const react = instance["react"].bind(instance);
        instance["react"] = (event: EventEnvelope, tx: Transaction) => {
          react(event, tx);
          throw new Error("crashed after recording the delivery");
        };
        try {
          return decodeExit(EventCodecs.receive, await instance.receive([platformEvent()]));
        } finally {
          instance["react"] = react;
        }
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterCrash = frames.length;
    const [delivered] = await deliver(agentId, 1);
    await vi.waitFor(() => expect(frames).toHaveLength(2), WAIT);
    socket.close();

    expect(Exit.isFailure(crashed)).toBe(true);
    expect(afterCrash).toBe(1);
    expect(frames[1]?.notices.map((notice) => notice.id)).toEqual([delivered]);
  });

  it("[b12.ws-scope] refuses the socket and the stream to anyone but an agent: a user is pointed to its own record, a caller without a token is asked to sign in", async () => {
    const { token } = await seedUser("inbox-user");
    const socket = await exports.default.fetch(`${BASE}/v1/inbox/socket`, {
      headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
    });
    const stream = await exports.default.fetch(`${BASE}/v1/inbox/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const anonymous = await exports.default.fetch(`${BASE}/v1/inbox/socket`, {
      headers: { upgrade: "websocket" },
    });

    for (const refused of [socket, stream])
      expect([refused.status, await refused.json()]).toEqual([
        403,
        expect.objectContaining({
          code: "auth.forbidden",
          detail: expect.stringMatching(/^Refused: agents-only\./),
          nextActions: [expect.objectContaining({ operationId: "Users_me" })],
        }),
      ]);
    expect([anonymous.status, (await anonymous.json<{ code: string }>()).code]).toEqual([
      401,
      "auth.required",
    ]);
  });
});
