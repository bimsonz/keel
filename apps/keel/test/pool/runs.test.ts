// An agent's runs through the deployed fetch handler: one agent that signed
// itself up with a key holds a token for each of two runs at once, and each
// read (the inbox, a tool result's notices, whoami's session, the stream and
// the socket) is that run's. Every read goes token, gate, handler, port,
// object; the run is only ever the one the token names.
import { env } from "cloudflare:workers";
import { IntentDeclared, LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { agentIdOf, runIdOf } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  agentActor,
  type ChangeId,
  EventEnvelope,
  makeId,
  type ProjectId,
  RunLabel,
  type RunRef,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { SocketFrame } from "../../src/adapters/driving/notices.ts";
import { ChangeCodecs, decodeExit, RUN_HEADER } from "../../src/rpc/index.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { BASE, drainAfter, establishProject, placeProject, worker } from "./helpers.ts";

/** How long a test waits for something the objects do by themselves (a flush, a delivery). */
const WAIT = { timeout: 15_000, interval: 25 };

const REGISTER = `${BASE}/v1/oauth/register`;

const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

/** One run of the agent: what its token names, and a plain bearer for it. */
interface Run {
  readonly run: RunRef;
  readonly token: string;
}

/**
 * An agent that signed itself up through the Worker with a key and nothing
 * else, a project placed in its own namespace (so its token for that project
 * works there), and three tokens the token endpoint granted it for that
 * project: one for run `run-a`, one for run `run-b`, and one that names no run.
 */
async function keyAgent() {
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
  // What the agent's own object commits (its sign-up, a session) is flushed before the case ends.
  agentStub(agentId);
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, agentId);
  await establishProject(projectId);
  const tokenFor = async (run?: string) =>
    (
      await granted(
        await requestToken(agentId, account, {
          project: projectId,
          ...(run === undefined ? {} : { run }),
        }),
      )
    ).access_token;
  const lane = async (name: string): Promise<Run> => {
    const label = Schema.decodeUnknownSync(RunLabel)(name);
    return { run: { id: runIdOf(agentId, { label }), label }, token: await tokenFor(name) };
  };
  return {
    agentId,
    projectId,
    a: await lane("run-a"),
    b: await lane("run-b"),
    /** A token of the same agent that names no run. */
    plain: await tokenFor(),
  };
}

interface WireNotice {
  readonly id: string;
  readonly kind: string;
  readonly ref?: string;
  readonly cursor?: string;
}

/** A request as the agent makes it with a plain bearer, from an address of its own. */
const asAgent = (token: string, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("cf-connecting-ip", freshAddress());
  return worker(`${BASE}${path}`, { ...init, headers });
};

/** The whole inbox as the token's run reads it by REST, from the start. */
async function inboxOf(token: string): Promise<readonly WireNotice[]> {
  const response = await asAgent(token, "/v1/inbox");
  if (response.status !== 200)
    throw new Error(`the inbox answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ result: { notices: WireNotice[] } }>()).result.notices;
}

/** `whoami` with the token: the session it names, and the notices that rode the answer. */
async function whoami(token: string) {
  const response = await asAgent(token, "/v1/agents/me");
  const body = await response.json<{
    result: { session: { id: string } | null };
    notices?: WireNotice[];
  }>();
  return {
    status: response.status,
    session: body.result.session,
    notices: (body.notices ?? []).map((notice) => notice.id),
  };
}

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

/**
 * Seeds a change `run` of the agent holds: its own `IntentDeclared`, delivered
 * to the agent's object as the change's fan-out would. With no run, the agent
 * holds it under none. Answers the change.
 */
async function holds(agentId: AgentId, run?: RunRef): Promise<ChangeId> {
  const changeId: ChangeId = makeId("chg", ulid());
  const named = run === undefined ? {} : { run };
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
  return changeId;
}

/**
 * Seeds a platform-caused event about a change (one nobody holds when none is
 * given), delivered to the agent's object as the fan-out would. Answers its id,
 * which is its notice's.
 */
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

/**
 * The agent with a change each of its two runs holds, a notice for each run,
 * and one for every run, delivered in that order.
 */
async function withNotices() {
  const agent = await keyAgent();
  const heldByA = await holds(agent.agentId, agent.a.run);
  const heldByB = await holds(agent.agentId, agent.b.run);
  const forA = await bounce(agent.agentId, heldByA);
  const forB = await bounce(agent.agentId, heldByB);
  const forAll = await bounce(agent.agentId);
  return { ...agent, heldByA, heldByB, forA, forB, forAll };
}

/** A change of `projectId` another agent declared and let lapse: anyone of the project may adopt it. */
async function lapsed(projectId: ProjectId): Promise<ChangeUnderTest> {
  const c = await changeUnderTest(projectId);
  ok(await c.declare());
  c.clock.advance(LEASE_TTL_MS);
  return c;
}

/** The token's run adopts the change through the Worker, as the agent's own command. */
async function adopt(token: string, c: ChangeUnderTest, key: string): Promise<void> {
  const response = await asAgent(token, `/v1/changes/${c.changeId}/adopt`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
  if (response.status !== 200)
    throw new Error(`the adoption answered ${response.status}: ${await response.text()}`);
}

/** Another agent adopts the change once its lease has lapsed again, over the change's own RPC. */
async function adoptedAway(c: ChangeUnderTest): Promise<void> {
  c.clock.advance(LEASE_TTL_MS);
  ok(
    decodeExit(
      ChangeCodecs.adopt,
      await c.stub.adopt({
        agentId: makeId("agt", ulid()),
        projectId: c.projectId,
        idempotencyKey: `adopted-away-${c.changeId}`,
      }),
    ),
  );
}

/** The changes the token's run is told were adopted: its inbox's `ChangeAdopted` notices, by what each is about. */
const adoptions = async (token: string) =>
  new Set(
    (await inboxOf(token))
      .filter((notice) => notice.kind === "ChangeAdopted")
      .map((notice) => notice.ref),
  );

/** What a run told of exactly these changes' adoptions reads. */
const told = (...changes: ChangeUnderTest[]) => new Set(changes.map((c) => `change:${c.changeId}`));

/** Opens a session as the token's run, through the Worker; answers its id. */
async function openSession(token: string, key: string): Promise<string> {
  const response = await asAgent(token, "/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: "{}",
  });
  if (response.status !== 201)
    throw new Error(`the session answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ id: string }>()).id;
}

/** Reads SSE events off a stream, skipping comments; each `next()` answers the next notice's id. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<string> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const lines = buffered.slice(0, end).split("\n");
          buffered = buffered.slice(end + 2);
          if (!lines.includes("event: notice")) continue;
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
          return JSON.parse(data).id;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the stream ended");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** Opens the inbox stream as the token's run. */
async function stream(token: string) {
  const response = await asAgent(token, "/v1/inbox/stream");
  if (response.status !== 200 || response.body === null)
    throw new Error(`the stream answered ${response.status}`);
  return sseReader(response.body);
}

/** Opens the inbox socket as the token's run, sending `headers` too, and collects each frame's notice ids. */
async function connect(token: string, headers: Record<string, string> = {}) {
  const response = await asAgent(token, "/v1/inbox/socket", {
    headers: { ...headers, upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null)
    throw new Error(`the upgrade answered ${response.status}: ${await response.text()}`);
  const frames: string[][] = [];
  socket.addEventListener("message", (message) => {
    const frame: SocketFrame = JSON.parse(String(message.data));
    frames.push(frame.notices.map((notice) => notice.id));
  });
  socket.accept();
  return { socket, frames };
}

describe("an agent's two runs, each with its own token", () => {
  it("[run.pool-inbox] the inbox by REST is the reading run's: what another does to a change it holds, never what it did itself, and what is for every run", async () => {
    const agent = await keyAgent();
    const [x, y, z] = [
      await lapsed(agent.projectId),
      await lapsed(agent.projectId),
      await lapsed(agent.projectId),
    ];
    // Run A takes X, run B takes Y, and the agent takes Z under no run: each through the Worker, with its own token.
    await adopt(agent.a.token, x, "adopt-key-000x");
    await adopt(agent.b.token, y, "adopt-key-000y");
    await adopt(agent.plain, z, "adopt-key-000z");
    // Another agent takes X from run A; run A takes Y from run B; another agent takes Z.
    await adoptedAway(x);
    y.clock.advance(LEASE_TTL_MS);
    await adopt(agent.a.token, y, "adopt-key-00ay");
    await adoptedAway(z);

    // The changes' events reach the agent once each Change DO's outbox has flushed.
    await vi.waitFor(async () => expect(await adoptions(agent.a.token)).toEqual(told(x, z)), WAIT);
    await vi.waitFor(async () => expect(await adoptions(agent.b.token)).toEqual(told(y, z)), WAIT);
    // Run A is told of X (taken from it) and never of Y (its own act); run B of Y (taken from it by run A), never of X.
    expect(await adoptions(agent.a.token)).toEqual(told(x, z));
    expect(await adoptions(agent.b.token)).toEqual(told(y, z));
    // A token that names no run reads only what is for every run.
    expect(await adoptions(agent.plain)).toEqual(told(z));
  });

  it("[run.pool-piggyback] a notice rides the next tool result of the run it is for, and one run's taking leaves the other's where they were", async () => {
    const agent = await withNotices();

    const firstB = await whoami(agent.b.token);
    const firstA = await whoami(agent.a.token);
    const none = await whoami(agent.plain);
    const [againA, againB] = [await whoami(agent.a.token), await whoami(agent.b.token)];

    expect(firstB.status).toBe(200);
    // Run B's result takes its own notice and the one for every run, and leaves run A's.
    expect(firstB.notices).toEqual([agent.forB, agent.forAll]);
    expect(firstA.notices).toEqual([agent.forA, agent.forAll]);
    expect(none.notices).toEqual([agent.forAll]);
    expect([againA.notices, againB.notices]).toEqual([[], []]);
  });

  it("[run.pool-whoami] a session is its run's: whoami names the session the asking run opened, and neither run's replaces the other's", async () => {
    const agent = await keyAgent();
    const sessions = async () => [
      (await whoami(agent.a.token)).session,
      (await whoami(agent.b.token)).session,
      (await whoami(agent.plain)).session,
    ];

    expect(await sessions()).toEqual([null, null, null]);
    const ofA = await openSession(agent.a.token, "session-key-000a");
    expect(await sessions()).toEqual([{ id: ofA }, null, null]);
    const ofB = await openSession(agent.b.token, "session-key-000b");
    expect(ofB).not.toBe(ofA);
    expect(await sessions()).toEqual([{ id: ofA }, { id: ofB }, null]);
    const ofNone = await openSession(agent.plain, "session-key-000n");
    expect(await sessions()).toEqual([{ id: ofA }, { id: ofB }, { id: ofNone }]);
  });

  it("[run.pool-stream] the SSE stream carries the reading run's notices only, those waiting and those that arrive", async () => {
    const agent = await withNotices();
    const [ofA, ofB] = [await stream(agent.a.token), await stream(agent.b.token)];

    const waitingA = [await ofA.next(), await ofA.next()];
    const waitingB = [await ofB.next(), await ofB.next()];
    // A later notice for each run, run B's first: run A's stream passes it by.
    const laterB = await bounce(agent.agentId, agent.heldByB, 3);
    const laterA = await bounce(agent.agentId, agent.heldByA, 3);
    const [liveA, liveB] = [await ofA.next(), await ofB.next()];
    await ofA.cancel();
    await ofB.cancel();

    expect([...waitingA, liveA]).toEqual([agent.forA, agent.forAll, laterA]);
    expect([...waitingB, liveB]).toEqual([agent.forB, agent.forAll, laterB]);
  });

  it("[run.pool-socket] the socket's snapshot and each later frame are the reading run's only", async () => {
    const agent = await withNotices();
    const [ofA, ofB] = [await connect(agent.a.token), await connect(agent.b.token)];
    await vi.waitFor(
      () => expect([ofA.frames, ofB.frames]).toEqual([[expect.any(Array)], [expect.any(Array)]]),
      WAIT,
    );

    // A later notice for run B sends run A's socket nothing; one for run A then sends run B's nothing.
    const laterB = await bounce(agent.agentId, agent.heldByB, 3);
    await vi.waitFor(() => expect(ofB.frames).toHaveLength(2), WAIT);
    const laterA = await bounce(agent.agentId, agent.heldByA, 3);
    await vi.waitFor(() => expect(ofA.frames).toHaveLength(2), WAIT);
    ofA.socket.close();
    ofB.socket.close();

    expect(ofA.frames).toEqual([[agent.forA, agent.forAll], [laterA]]);
    expect(ofB.frames).toEqual([[agent.forB, agent.forAll], [laterB]]);
  });

  it("[run.pool-header] a socket reads as its token's run whatever run the client names in a header of its own", async () => {
    const agent = await withNotices();
    // Run A's token naming run B, and a token with no run naming run A.
    const asA = await connect(agent.a.token, { [RUN_HEADER]: agent.b.run.id });
    const asNone = await connect(agent.plain, { [RUN_HEADER]: agent.a.run.id });
    await vi.waitFor(
      () => expect([asA.frames, asNone.frames]).toEqual([[expect.any(Array)], [expect.any(Array)]]),
      WAIT,
    );
    asA.socket.close();
    asNone.socket.close();

    expect(asA.frames).toEqual([[agent.forA, agent.forAll]]);
    expect(asNone.frames).toEqual([[agent.forAll]]);
  });
});

describe("an agent asks for a project in its own namespace", () => {
  it("[run.own-project-held] until an agent can make a project, asking for one in its own namespace answers a problem that says so, never a defect", async () => {
    const agent = await keyAgent();
    const me = await asAgent(agent.a.token, "/v1/agents/me");
    const { handle } = (await me.json<{ result: { agent: { handle: string } } }>()).result.agent;
    const response = await asAgent(agent.a.token, "/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `create-${ulid()}` },
      body: JSON.stringify({
        namespace: handle,
        name: `own-${ulid().toLowerCase()}`,
        source: { kind: "empty" },
      }),
    });
    expect([response.status, (await response.json<{ code: string }>()).code]).toEqual([
      503,
      "service.not_implemented",
    ]);
  });
});
