// An agent's runs through the deployed fetch handler: one agent that signed
// itself up with a key holds a token for each of two runs at once, and each
// read (the inbox, a tool result's notices, whoami's session, the stream and
// the socket) is that run's. Every read goes token, gate, handler, port,
// object; the run is only ever the one the token names.
import { runInDurableObject } from "cloudflare:test";
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
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import type { SocketFrame } from "../../src/adapters/driving/notices.ts";
import { ChangeCodecs, decodeExit, RUN_HEADER } from "../../src/rpc/index.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  seedUser,
  uniqueHandle,
  worker,
} from "./helpers.ts";

/** How long a test waits for something the objects do by themselves (a flush, a delivery). */
const WAIT = { timeout: 15_000, interval: 25 };

const REGISTER = `${BASE}/v1/oauth/register`;

const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

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
    account,
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
    summary: string;
    result: { session: { id: string } | null; run?: RunRef };
    notices?: WireNotice[];
  }>();
  return {
    status: response.status,
    summary: body.summary,
    run: body.result.run,
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
async function adopt(token: string, c: ChangeUnderTest, key: string) {
  const response = await asAgent(token, `/v1/changes/${c.changeId}/adopt`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
  if (response.status !== 200)
    throw new Error(`the adoption answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ result: { change: { id: string; run?: RunRef } } }>()).result
    .change;
}

/** The change as its holder reads it back. */
async function changeOf(token: string, c: ChangeUnderTest) {
  const response = await asAgent(token, `/v1/changes/${c.changeId}`);
  if (response.status !== 200)
    throw new Error(`the change answered ${response.status}: ${await response.text()}`);
  return response.json<{ id: string; run?: RunRef }>();
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
  return (await openedSession(token, key)).id;
}

/** Opening a session, whatever it answers. */
const opening = (token: string) =>
  asAgent(token, "/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `opening-${ulid()}` },
    body: "{}",
  });

/** The session as opening it answers. */
async function openedSession(token: string, key: string) {
  const response = await asAgent(token, "/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: "{}",
  });
  if (response.status !== 201)
    throw new Error(`the session answered ${response.status}: ${await response.text()}`);
  return response.json<{ id: string; run?: RunRef }>();
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

/** The token's run relies on a premise under the lease it holds, through the Worker. */
async function rely(token: string, c: ChangeUnderTest, key: string): Promise<void> {
  const response = await asAgent(token, `/v1/changes/${c.changeId}/premises`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "keel-lease": (await c.current()).lease.id,
      "idempotency-key": key,
    },
    body: JSON.stringify({
      premise: { subject: "migrate", predicate: "ordering", relation: "before", value: "deploy" },
    }),
  });
  if (response.status !== 200)
    throw new Error(`the rely answered ${response.status}: ${await response.text()}`);
}

/** What the agent's own commands committed on the change: each event's type and the run it names. */
const committedBy = async (agentId: AgentId, c: ChangeUnderTest) =>
  (await c.log())
    .filter((event) => event.actor === agentActor(agentId))
    .map((event) => [event.type, event.run]);

/** Somebody just signed in becomes the agent's sponsor: the agent asks with `token`, and that person approves with the code. */
async function sponsored(agentId: AgentId, token: string): Promise<{ readonly token: string }> {
  const asked = await asAgent(token, "/v1/agents/me/sponsor-request", {
    method: "POST",
    headers: { "idempotency-key": `ask-${ulid()}` },
  });
  if (asked.status !== 201)
    throw new Error(`the ask answered ${asked.status}: ${await asked.text()}`);
  const { code } = (await asked.json<{ result: { code: string } }>()).result;
  const person = await seedUser(uniqueHandle("sponsor"), { role: null, signedInBy: "passkey" });
  const approved = await worker(`${BASE}/v1/agents/${agentId}/sponsor`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${person.token}`,
      "content-type": "application/json",
      "idempotency-key": `approve-${ulid()}`,
    },
    body: JSON.stringify({ code }),
  });
  if (approved.status !== 200)
    throw new Error(`the approval answered ${approved.status}: ${await approved.text()}`);
  return person;
}

/** The agent ends its own sponsor link with `token`. */
const leave = async (agentId: AgentId, token: string) =>
  (
    await asAgent(token, `/v1/agents/${agentId}/sponsor`, {
      method: "DELETE",
      headers: { "idempotency-key": `leave-${ulid()}` },
    })
  ).status;

/** Each end of the agent's sponsor link as its own object committed it: who ended it, and under which run. */
const linkEnds = (agentId: AgentId) =>
  runInDurableObject(agentStub(agentId), (_instance: AgentSessionDO, state) =>
    state.storage.sql
      .exec<{ envelope: string }>(
        "SELECT envelope FROM keel_events WHERE entity_kind = 'agent' ORDER BY seq",
      )
      .toArray()
      .map((row) => Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(row.envelope)))
      .filter((event) => event.type === "AgentUnsponsored")
      .map((event) => ({ actor: event.actor, run: event.run })),
  );

/** The agent replaces a project's settings with `token`. */
const putSettings = (token: string, projectId: ProjectId, settings: object) =>
  asAgent(token, `/v1/projects/${projectId}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });

const SettingsBy = Schema.Struct({ by: Schema.String });

/** Each change of the project's settings as its own object committed it: who changed them, and under which run. */
const settingsChanges = (projectId: ProjectId) =>
  runInDurableObject(projectStub(projectId), (_instance: ProjectDO, state) =>
    state.storage.sql
      .exec<{ envelope: string }>(
        "SELECT envelope FROM keel_events WHERE entity_kind = 'project' ORDER BY seq",
      )
      .toArray()
      .map((row) => Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(row.envelope)))
      .filter((event) => event.type === "ProjectSettingsChanged")
      .map((event) => ({
        actor: event.actor,
        by: Schema.decodeUnknownSync(SettingsBy)(event.payload).by,
        run: event.run,
      })),
  );

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

  it("[run.pool-views] whoami, a session and a change each name the run: the asking token's, the one that opened it, the one that holds it; a token that names no run reads none", async () => {
    const agent = await keyAgent();
    const [asA, asB, asNone] = [
      await whoami(agent.a.token),
      await whoami(agent.b.token),
      await whoami(agent.plain),
    ];
    expect([asA.run, asB.run]).toEqual([agent.a.run, agent.b.run]);
    expect(asNone).not.toHaveProperty("run", expect.anything());
    expect([asA.summary, asNone.summary].map((line) => line.includes("in run run-a"))).toEqual([
      true,
      false,
    ]);

    const opened = [
      await openedSession(agent.a.token, "views-key-0000a"),
      await openedSession(agent.plain, "views-key-0000n"),
    ];
    expect(opened[0]?.run).toEqual(agent.a.run);
    expect(opened[1]).not.toHaveProperty("run");

    const [held, loose] = [await lapsed(agent.projectId), await lapsed(agent.projectId)];
    expect((await adopt(agent.b.token, held, "views-adopt-000b")).run).toEqual(agent.b.run);
    expect((await changeOf(agent.b.token, held)).run).toEqual(agent.b.run);
    expect(await adopt(agent.plain, loose, "views-adopt-000n")).not.toHaveProperty("run");
    expect(await changeOf(agent.plain, loose)).not.toHaveProperty("run");
  });

  it("[run.pool-commands] a work command through the Worker is committed in its token's run: an adoption and a rely under the lease it took, and under none with a token that names none", async () => {
    const agent = await keyAgent();
    const [held, loose] = [await lapsed(agent.projectId), await lapsed(agent.projectId)];
    await adopt(agent.b.token, held, "cmds-adopt-0000b");
    await rely(agent.b.token, held, "cmds-rely-00000b");
    await adopt(agent.plain, loose, "cmds-adopt-0000n");
    await rely(agent.plain, loose, "cmds-rely-00000n");
    expect(await committedBy(agent.agentId, held)).toStrictEqual([
      ["ChangeAdopted", agent.b.run],
      ["IntentRevised", agent.b.run],
      ["PreflightIssued", agent.b.run],
    ]);
    expect(await committedBy(agent.agentId, loose)).toStrictEqual([
      ["ChangeAdopted", undefined],
      ["IntentRevised", undefined],
      ["PreflightIssued", undefined],
    ]);
  });

  it("[run.pool-link-end] an agent that leaves its sponsor is committed in its token's run, and under none with a token that names none", async () => {
    const agent = await keyAgent();
    await sponsored(agent.agentId, agent.a.token);
    expect(await leave(agent.agentId, agent.a.token)).toBe(200);
    await sponsored(agent.agentId, agent.plain);
    expect(await leave(agent.agentId, agent.plain)).toBe(200);
    expect(await linkEnds(agent.agentId)).toStrictEqual([
      { actor: agentActor(agent.agentId), run: agent.a.run },
      { actor: agentActor(agent.agentId), run: undefined },
    ]);
  });

  it("[run.pool-session-hidden] a session opened with a token that names another agent's private project answers 404, as the spec declares for it: the project is not there for this agent", async () => {
    const [agent, other] = [await keyAgent(), await keyAgent()];
    // A token request never says whether a project exists: the token is granted, and the gate decides on each request.
    const strangers = (
      await granted(
        await requestToken(agent.agentId, agent.account, {
          project: other.projectId,
          run: "run-a",
        }),
      )
    ).access_token;
    const hidden = await opening(strangers);
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("content-type")).toBe("application/problem+json");
    expect(await hidden.json()).toMatchObject({ status: 404, code: "resource.not_found" });
    // The same request with a token for its own project opens one.
    expect((await opening(agent.a.token)).status).toBe(201);
  });

  it("[run.pool-settings] an agent replaces the settings of a project in its own namespace as itself, in its token's run and under none with a token that names none; its other project and another agent's refuse it", async () => {
    const [agent, other] = [await keyAgent(), await keyAgent()];
    const sibling: ProjectId = makeId("prj", ulid());
    await placeProject(sibling, agent.agentId);
    await establishProject(sibling);
    const off = { protectedPaths: ["infra/**"], maxBatchSize: 1, verification: "off" };
    const open = { protectedPaths: [], maxBatchSize: 1, visibility: "public" };

    const inRun = await putSettings(agent.a.token, agent.projectId, off);
    expect(inRun.status).toBe(200);
    expect(await inRun.json()).toStrictEqual({ ...off, visibility: "private" });
    expect((await putSettings(agent.plain, agent.projectId, open)).status).toBe(200);

    // Its token names one project: another of its own answers that, and a private project of another agent is not there for it.
    const foreign = await putSettings(agent.a.token, sibling, off);
    const unseen = await putSettings(agent.a.token, other.projectId, off);
    expect([foreign.status, unseen.status]).toStrictEqual([403, 404]);
    expect((await foreign.json<{ detail: string }>()).detail).toBe("Refused: foreign-project.");
    // Once its own agent makes that project public, the stranger sees it and still governs nothing there.
    expect((await putSettings(other.b.token, other.projectId, open)).status).toBe(200);
    const refused = await putSettings(agent.a.token, other.projectId, off);
    expect(refused.status).toBe(403);
    expect((await refused.json<{ detail: string }>()).detail).toBe("Refused: users-only.");

    const own = { actor: agentActor(agent.agentId), by: agent.agentId };
    expect(await settingsChanges(agent.projectId)).toStrictEqual([
      { ...own, run: agent.a.run },
      { ...own, run: undefined },
    ]);
    expect(await settingsChanges(sibling)).toStrictEqual([]);
    expect(await settingsChanges(other.projectId)).toStrictEqual([
      { actor: agentActor(other.agentId), by: other.agentId, run: other.b.run },
    ]);
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

/** What a run's inbox says after `cursor`: each notice's kind, its detail and the operations its next actions name, and the cursor to read on from. */
async function toldAfter(token: string, cursor: string, wait = 0) {
  const response = await asAgent(token, `/v1/inbox?cursor=${cursor}&wait=${wait}`);
  if (response.status !== 200)
    throw new Error(`the inbox answered ${response.status}: ${await response.text()}`);
  const { result } = await response.json<{
    result: {
      cursor: string;
      notices: { kind: string; detail?: string; nextActions?: { operationId?: string }[] }[];
    };
  }>();
  return {
    cursor: result.cursor,
    notices: result.notices.map((n) => [
      n.kind,
      n.detail,
      n.nextActions?.map((a) => a.operationId),
    ]),
  };
}

describe("[run.paused-told] a pause and an unpause reach every run", () => {
  it("[run.paused-told] the sponsor's pause and unpause are told in every run's inbox, waking a read held there, and a paused agent is given a token that reads who it is and its inbox and nothing else", async () => {
    const agent = await keyAgent();
    const sponsor = await sponsored(agent.agentId, agent.a.token);
    const move = (to: "suspend" | "reinstate") =>
      worker(`${BASE}/v1/agents/${agent.agentId}/${to}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sponsor.token}`,
          "content-type": "application/json",
          "idempotency-key": `${to}-${ulid()}`,
        },
        ...(to === "suspend" ? { body: JSON.stringify({ reason: "runaway retries" }) } : {}),
      });
    const before = {
      a: (await toldAfter(agent.a.token, "end")).cursor,
      b: (await toldAfter(agent.b.token, "end")).cursor,
    };

    // Run b holds its inbox; the pause wakes it.
    const held = toldAfter(agent.b.token, before.b, 20);
    expect((await move("suspend")).status).toBe(200);
    const paused = [
      "AgentSuspended",
      "your sponsor paused you: until they unpause you, Keel answers only whoami and your inbox",
      ["inbox"],
    ];
    expect((await held).notices).toEqual([paused]);
    const afterPause = await toldAfter(agent.a.token, before.a);
    expect(afterPause.notices).toEqual([paused]);

    // Paused, it is given a token: it reads who it is and its inbox, and the policy answers the rest.
    const fresh = (
      await granted(
        await requestToken(agent.agentId, agent.account, {
          project: agent.projectId,
          run: "run-a",
        }),
      )
    ).access_token;
    expect((await asAgent(fresh, "/v1/agents/me")).status).toBe(200);
    expect((await asAgent(fresh, `/v1/inbox?cursor=${afterPause.cursor}`)).status).toBe(200);
    const refused = await asAgent(fresh, "/v1/agents/me/reachable-projects");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ detail: "Refused: agent-paused." });

    expect((await move("reinstate")).status).toBe(200);
    const unpaused = [
      "AgentReinstated",
      "your sponsor unpaused you: your calls are taken again",
      ["whoami"],
    ];
    expect((await toldAfter(agent.a.token, afterPause.cursor)).notices).toEqual([unpaused]);
    expect((await toldAfter(agent.b.token, before.b)).notices).toEqual([paused, unpaused]);
    expect((await asAgent(fresh, "/v1/agents/me/reachable-projects")).status).toBe(200);
  });
});
