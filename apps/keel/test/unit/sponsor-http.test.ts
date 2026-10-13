import { type SignedIn, signUpAgent } from "@keeltown/core/application/identity";
import {
  type Agent,
  AgentStateRefused,
  givenHandle,
  type Principal,
  type Role,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant, makeId, type OrgId, type UserId } from "@keeltown/core/kernel";
import { Sponsorships } from "@keeltown/core/ports";
import {
  freshAgentKey,
  makeAgentDirectoryMemory,
  makeAgentSignUpsMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeCodeHostMemory,
  makeEnrolmentsMemory,
  makeEscalationsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeManualClock,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeProjectViewsMemory,
  makeSessionsMemory,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
} from "@keeltown/testing";
import { Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";
import { approveError, endError } from "../../src/adapters/driving/http/sponsorship.ts";
import { doorwayOf } from "../../src/composition/doorway.ts";

/**
 * The link between a person and an agent, through the handlers the routes and
 * the MCP tools dispatch into, behind the one policy and the doorway's rule
 * for a fresh sign-in.
 */

const ACME = makeId("org", ulid());
const LEDGER = makeId("prj", ulid());
const ANN = makeId("usr", ulid());
const BOB = makeId("usr", ulid());
const MAY = makeId("usr", ulid());
const NOW = Date.parse("2026-10-13T09:00:00Z");
const MINUTE = 60_000;

const signedIn = (by: string | null, minutesAgo: number): SignedIn => ({
  by,
  at: NOW - minutesAgo * MINUTE,
});
const FRESH = signedIn("passkey", 1);
/** Sessions the doorway does not take for a fresh sign-in, each by what is wrong with it. */
const STALE: readonly (readonly [string, SignedIn | null])[] = [
  ["an email code", signedIn("email-otp", 1)],
  ["the device grant", signedIn("device", 1)],
  ["GitHub", signedIn("github", 1)],
  ["no recorded method", signedIn(null, 1)],
  ["a passkey eleven minutes ago", signedIn("passkey", 11)],
  ["no session's record at all", null],
];

const agentRecord = (id: AgentId, name: string, over: Partial<Agent> = {}): Agent => ({
  id,
  projectId: LEDGER,
  name,
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  org: ACME,
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(NOW - 60 * MINUTE),
  ...over,
});

/** A project of acme, and the stores the handlers run over. `enrolled` puts an agent in the directory. */
function world() {
  const clock = makeManualClock();
  const directory = makeAgentDirectoryMemory();
  const sponsorships = makeSponsorshipsMemory();
  const inbox = makeInboxMemory();
  const projects = makeProjectsMemory();
  const places = makeProjectNamespacesMemory();
  projects.setSettings(LEDGER, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "private",
  });
  places.places.set(LEDGER, { projectId: LEDGER, namespace: ACME, name: "ledger" });
  const rows = makeBetterAuthMemory({ orgs: [{ id: ACME, slug: "acme" }] });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      directory.layer,
      projects.layer,
      makeEnrolmentsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeAgentSignUpsMemory(rows).layer.pipe(Layer.provide(directory.layer)),
      makeSessionsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeStandingsMemory().layer.pipe(Layer.provide(directory.layer)),
      sponsorships.layer.pipe(Layer.provide(directory.layer)),
      makeTokenIssuerMemory().layer.pipe(Layer.provide(clock.layer)),
      clock.layer,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().layer,
      makeEscalationsMemory(clock).layer,
      makeCodeHostMemory().layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeNamespacesMemory(rows).layer,
      places.layer,
    ),
  );
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    doorwayOf("keel.test", () => new Date(NOW)),
  );
  let enrolments = 0;
  /** Each a millisecond after the last, so "oldest first" is the order they were enrolled in. */
  const enrolled = (name: string, over: Partial<Agent> = {}): AgentId => {
    const id = makeId("agt", ulid());
    enrolments += 1;
    const createdAt = Instant(NOW - 60 * MINUTE + enrolments);
    directory.agents.set(id, agentRecord(id, name, { createdAt, ...over }));
    return id;
  };
  const rowOf = (id: AgentId) => {
    const agent = directory.agents.get(id);
    return agent === undefined ? undefined : [agent.sponsor ?? null, agent.state];
  };
  return { runtime, handlers, directory, sponsorships, enrolled, rowOf };
}

const callerAs = (principal: Principal, session: SignedIn | null = null): Caller => ({
  requestId: "req-1",
  principal,
  ...(session === null ? {} : { signedIn: session }),
  signal: new AbortController().signal,
});
/** A person on a session signed in as `session` says: a fresh passkey sign-in unless told otherwise, none for null. */
const person = (
  userId: UserId,
  session: SignedIn | null = FRESH,
  memberships: readonly (readonly [OrgId, Role])[] = [],
): Caller =>
  callerAs(
    {
      _tag: "User",
      userId,
      handle: `user-${userId.slice(-4).toLowerCase()}`,
      suspended: false,
      memberships: memberships.map(([org, role]) => ({ org, role })),
    },
    session,
  );
const agent = (agentId: AgentId, over: { readonly paused?: boolean } = {}): Caller =>
  callerAs({
    _tag: "Agent",
    agentId,
    org: ACME,
    projectId: LEDGER,
    scopes: ["agent:read", "agent:work"],
    paused: over.paused ?? false,
    standing: { _tag: "Invited", by: { userId: MAY, role: "maintainer", suspended: false } },
  });
const VISITOR = callerAs({ _tag: "Anonymous" });
/** May maintains acme, where the agents work, and stands behind none of them. */
const may = (session: SignedIn | null = FRESH) => person(MAY, session, [[ACME, "maintainer"]]);

type Answer = { readonly status: number; readonly body: Record<string, unknown> };
const answer = (result: unknown): Answer => ({
  status: Number(Reflect.get(Object(result), "status")),
  body: Object(Reflect.get(Object(result), "body")),
});
const refusal = (a: Answer) => [a.status, a.body["code"], a.body["detail"]];
const resultOf = (a: Answer): Record<string, unknown> => Object(a.body["result"]);

type World = ReturnType<typeof world>;
const key = () => `key-${ulid()}`;

/** The agent asks and the code it was given. */
async function asked(w: World, agentId: AgentId): Promise<string> {
  const given = answer(await w.handlers.askSponsor(agent(agentId)));
  expect(given.status).toBe(201);
  return String(resultOf(given)["code"]);
}

/** An agent `sponsor` stands behind, through the ask and the approval. */
async function sponsored(w: World, sponsor: UserId, name = "held"): Promise<AgentId> {
  const agentId = w.enrolled(name);
  const code = await asked(w, agentId);
  const approved = answer(
    await w.handlers.Agents_approveSponsor(person(sponsor), {
      agentId,
      code,
      "idempotency-key": key(),
    }),
  );
  expect(approved.status).toBe(200);
  return agentId;
}

const approve = async (w: World, caller: Caller, agentId: string, code: string, k = key()) =>
  answer(await w.handlers.Agents_approveSponsor(caller, { agentId, code, "idempotency-key": k }));
const end = async (w: World, caller: Caller, agentId: string) =>
  answer(await w.handlers.Agents_endSponsorship(caller, { agentId, "idempotency-key": key() }));
const pause = async (w: World, caller: Caller, agentId: string) =>
  answer(
    await w.handlers.Operator_suspendAgent(caller, {
      agentId,
      reason: "runaway",
      "idempotency-key": key(),
    }),
  );
const unpause = async (w: World, caller: Caller, agentId: string) =>
  answer(await w.handlers.Operator_reinstateAgent(caller, { agentId, "idempotency-key": key() }));

const NOT_THERE = [404, "resource.not_found", undefined];
const TOUCH = [403, "auth.fresh_sign_in_required"];

describe("the sponsor link at the doorway", () => {
  it("[link.sponsor-http] an agent asks, and is answered a code and the page where a person approves it, with the code in the fragment", async () => {
    const w = world();
    const bot = w.enrolled("bot");
    const given = answer(await w.handlers.askSponsor(agent(bot)));
    expect(given.status).toBe(201);
    const { code, url, expiresAt } = resultOf(given);
    expect(String(code).length).toBeGreaterThan(20);
    expect(url).toBe(`https://keel.test/sponsor#agent=${bot}&code=${String(code)}`);
    expect(new URL(String(url)).search).toBe("");
    expect(Date.parse(String(expiresAt))).toBeGreaterThan(Date.now());
    expect(given.body["next"]).toMatchObject([{ kind: "escalate" }, { operationId: "whoami" }]);
    // A person has no account of an agent's to ask for, and an agent approves nothing.
    expect(refusal(answer(await w.handlers.askSponsor(person(ANN))))).toEqual([
      403,
      "auth.forbidden",
      "Refused: agents-only. This reads an agent's own record.",
    ]);
    expect(refusal(await approve(w, agent(bot), bot, String(code)))).toEqual([
      403,
      "auth.forbidden",
      "Refused: users-only.",
    ]);
    expect(w.rowOf(bot)).toEqual([null, "active"]);
    await w.runtime.dispose();
  });

  it("[link.sponsor-http] a person approves with the code and stands behind the agent; a wrong, used or run-out code and an agent that does not exist are one answer", async () => {
    const w = world();
    const bot = w.enrolled("bot");
    const other = w.enrolled("other");
    const code = await asked(w, bot);
    const miss = await approve(w, person(ANN), bot, "not-the-code");
    expect(refusal(miss)).toEqual([
      404,
      "resource.not_found",
      "No agent is asking for a sponsor with that code.",
    ]);
    // Each miss reads exactly as the first: nothing says which it was.
    expect(await approve(w, person(ANN), makeId("agt", ulid()), code)).toEqual(miss);
    expect(await approve(w, person(ANN), "agt_not-an-id", code)).toEqual(miss);
    expect(await approve(w, person(ANN), other, code)).toEqual(miss);
    expect(w.rowOf(bot)).toEqual([null, "active"]);

    const k = key();
    const approved = await approve(w, person(ANN), bot, code, k);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: bot, sponsor: ANN, state: "active" });
    expect(w.rowOf(bot)).toEqual([ANN, "active"]);
    // The same key and body again answers the agent as it stands; the same key with another code is refused.
    expect((await approve(w, person(ANN), bot, code, k)).body).toMatchObject({ sponsor: ANN });
    expect(refusal(await approve(w, person(ANN), bot, "another", k)).slice(0, 2)).toEqual([
      409,
      "request.idempotency_conflict",
    ]);
    // The code is spent: a second person holding it reads the same as any miss.
    expect(await approve(w, person(BOB), bot, code)).toEqual(miss);
    expect(w.rowOf(bot)).toEqual([ANN, "active"]);
    // An agent somebody stands behind is given no new code.
    const again = answer(await w.handlers.askSponsor(agent(bot)));
    expect(refusal(again).slice(0, 2)).toEqual([409, "agent.state_refused"]);
    expect(again.body["nextActions"]).toMatchObject([{ operationId: "Agents_endSponsorship" }]);

    // A code that ran out is a miss too.
    const late = w.enrolled("late");
    const stale = await asked(w, late);
    await w.runtime.runPromise(w.sponsorships.expire(late));
    expect(await approve(w, person(ANN), late, stale)).toEqual(miss);
    await w.runtime.dispose();
  });

  it("[link.sponsor-http] whoever comes to stand behind an agent spends its ask, and an approval the agent's standing refuses is a 409 only once the code is right", async () => {
    const w = world();
    const bot = w.enrolled("bot");
    const code = await asked(w, bot);
    // Somebody came to stand behind it another way, between its ask and this approval.
    await w.runtime.runPromise(
      Sponsorships.use((links) =>
        links.approve({
          agentId: bot,
          by: BOB,
          asked: { _tag: "Consent" },
          idempotencyKey: key(),
        }),
      ),
    );
    // That approval spent the ask, so the code is a miss like any other.
    expect(refusal(await approve(w, person(ANN), bot, code))).toEqual([
      404,
      "resource.not_found",
      "No agent is asking for a sponsor with that code.",
    ]);
    expect(w.rowOf(bot)).toEqual([BOB, "active"]);

    const gone = w.enrolled("gone");
    const held = await asked(w, gone);
    w.directory.agents.set(gone, agentRecord(gone, "gone", { state: "revoked" }));
    expect(refusal(await approve(w, person(ANN), gone, held)).slice(0, 2)).toEqual([
      409,
      "agent.state_refused",
    ]);
    await w.runtime.dispose();
  });

  it("[link.sponsor-http] the sponsor or the agent itself ends the link, and to anyone else it is not there", async () => {
    const w = world();
    const held = await sponsored(w, ANN);
    // A stranger, a maintainer of the org the agent works in, another agent and nobody.
    expect(refusal(await end(w, person(BOB), held))).toEqual(NOT_THERE);
    expect(refusal(await end(w, may(), held))).toEqual(NOT_THERE);
    expect(refusal(await end(w, agent(w.enrolled("another")), held))).toEqual(NOT_THERE);
    expect(refusal(await end(w, VISITOR, held)).slice(0, 2)).toEqual([401, "auth.required"]);
    // An agent that does not exist reads exactly as one the caller does not stand behind.
    expect(await end(w, person(BOB), makeId("agt", ulid()))).toEqual(
      await end(w, person(BOB), held),
    );
    expect(await end(w, person(BOB), "agt_not-an-id")).toEqual(await end(w, person(BOB), held));
    expect(w.rowOf(held)).toEqual([ANN, "active"]);

    const ended = await end(w, person(ANN), held);
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ id: held, state: "active" });
    expect(ended.body).not.toHaveProperty("sponsor");
    expect(w.rowOf(held)).toEqual([null, "active"]);
    // Once ended, the person who stood behind it is nobody to it.
    expect(refusal(await end(w, person(ANN), held))).toEqual(NOT_THERE);

    const leaving = await sponsored(w, ANN, "leaving");
    const left = await end(w, agent(leaving), leaving);
    expect(left.status).toBe(200);
    expect(w.rowOf(leaving)).toEqual([null, "active"]);
    // With nobody behind it there is no link to end.
    expect(refusal(await end(w, agent(leaving), leaving)).slice(0, 2)).toEqual([
      409,
      "agent.state_refused",
    ]);
    // Paused, it is refused before anything else: it cannot leave the sponsor who paused it.
    const paused = await sponsored(w, ANN, "paused");
    expect(refusal(await end(w, agent(paused, { paused: true }), paused))).toEqual([
      403,
      "auth.forbidden",
      "Refused: agent-paused.",
    ]);
    expect(w.rowOf(paused)).toEqual([ANN, "active"]);
    await w.runtime.dispose();
  });

  it("[link.sponsor-http] what the agent's own record refuses after the policy granted: a caller no longer a party reads no such agent, and a paused agent is told to be reinstated first", () => {
    const bot = makeId("agt", ulid());
    const caller = person(ANN);
    const refused = (reason: "not-a-party" | "paused" | "not-sponsored") =>
      new AgentStateRefused({ agentId: bot, state: "active", command: "EndSponsorship", reason });
    expect(refusal(answer(endError(caller, refused("not-a-party"))))).toEqual(NOT_THERE);
    const paused = answer(endError(caller, refused("paused")));
    expect(refusal(paused).slice(0, 2)).toEqual([409, "agent.state_refused"]);
    expect(paused.body["nextActions"]).toMatchObject([
      { operationId: "Operator_reinstateAgent", args: { agentId: bot } },
    ]);
    expect(refusal(answer(approveError(caller, refused("paused")))).slice(0, 2)).toEqual([
      409,
      "agent.state_refused",
    ]);
    expect(answer(endError(caller, refused("not-sponsored"))).body["nextActions"]).toMatchObject([
      { operationId: "askSponsor" },
    ]);
  });

  it("[link.pause] only the sponsor pauses and reinstates; a maintainer of the agent's org, a stranger and the agent itself do not, and ending the link while paused reinstates", async () => {
    const w = world();
    const held = await sponsored(w, ANN);
    for (const move of [pause, unpause]) {
      expect(refusal(await move(w, may(), held))).toEqual(NOT_THERE);
      expect(refusal(await move(w, person(BOB), held))).toEqual(NOT_THERE);
      expect(refusal(await move(w, agent(held), held))).toEqual([
        403,
        "auth.forbidden",
        "Refused: users-only.",
      ]);
      expect(refusal(await move(w, VISITOR, held)).slice(0, 2)).toEqual([401, "auth.required"]);
    }
    expect(w.rowOf(held)).toEqual([ANN, "active"]);
    // Nobody pauses an agent nobody stands behind.
    const alone = w.enrolled("alone");
    expect(refusal(await pause(w, person(ANN), alone))).toEqual(NOT_THERE);
    expect(refusal(await pause(w, may(), alone))).toEqual(NOT_THERE);

    const paused = await pause(w, person(ANN), held);
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ id: held, state: "suspended", sponsor: ANN });
    expect(w.rowOf(held)).toEqual([ANN, "suspended"]);
    expect((await unpause(w, person(ANN), held)).body).toMatchObject({ state: "active" });
    expect(w.rowOf(held)).toEqual([ANN, "active"]);

    await pause(w, person(ANN), held);
    const ended = await end(w, person(ANN), held);
    expect(ended.body).toMatchObject({ id: held, state: "active" });
    expect(w.rowOf(held)).toEqual([null, "active"]);
    // Revoking is not the sponsor's alone: a maintainer of the agent's org still may.
    const revoked = answer(
      await w.handlers.Operator_revokeAgent(may(), { agentId: held, "idempotency-key": key() }),
    );
    expect(revoked.body).toMatchObject({ id: held, state: "revoked" });
    await w.runtime.dispose();
  });

  it("[link.pause] a person lists the agents they stand behind, and only those", async () => {
    const w = world();
    const first = await sponsored(w, ANN, "first");
    const second = await sponsored(w, ANN, "second");
    const bobs = await sponsored(w, BOB, "bobs");
    w.enrolled("alone");
    const ids = async (caller: Caller) => {
      const listed = answer(await w.handlers.Agents_listSponsored(caller));
      const items: unknown = listed.body["items"];
      return Array.isArray(items) ? items.map((item: unknown) => Object(item).id) : listed.status;
    };
    expect(await ids(person(ANN))).toEqual([first, second]);
    expect(await ids(person(BOB))).toEqual([bobs]);
    expect(await ids(may())).toEqual([]);
    // It needs no fresh sign-in, and it is a person's list.
    expect(await ids(person(BOB, signedIn("device", 600)))).toEqual([bobs]);
    expect(await ids(agent(first))).toBe(403);
    expect(await ids(VISITOR)).toBe(401);
    await w.runtime.dispose();
  });

  it.each(STALE)(
    "[link.touch] a session signed in by %s is refused the approval, the link's end, the pause and its end, and nothing moves",
    async (_what, session) => {
      const w = world();
      const bot = w.enrolled("bot");
      const code = await asked(w, bot);
      expect(refusal(await approve(w, person(ANN, session), bot, code)).slice(0, 2)).toEqual(TOUCH);
      expect(w.rowOf(bot)).toEqual([null, "active"]);
      // The code is still good: the refusal spent nothing.
      expect((await approve(w, person(ANN), bot, code)).status).toBe(200);

      expect(refusal(await pause(w, person(ANN, session), bot)).slice(0, 2)).toEqual(TOUCH);
      expect(w.rowOf(bot)).toEqual([ANN, "active"]);
      await pause(w, person(ANN), bot);
      expect(refusal(await unpause(w, person(ANN, session), bot)).slice(0, 2)).toEqual(TOUCH);
      expect(refusal(await end(w, person(ANN, session), bot)).slice(0, 2)).toEqual(TOUCH);
      expect(w.rowOf(bot)).toEqual([ANN, "suspended"]);
      // Whoever does not stand behind the agent learns nothing from the touch: it is not there.
      expect(refusal(await pause(w, person(BOB, session), bot))).toEqual(NOT_THERE);
      expect(refusal(await end(w, person(BOB, session), bot))).toEqual(NOT_THERE);
      await w.runtime.dispose();
    },
  );

  it("[link.touch] a passkey sign-in inside ten minutes passes each of them, and the agent's own end of the link needs no session", async () => {
    const w = world();
    const bot = w.enrolled("bot");
    const inside = signedIn("passkey", 9);
    expect((await approve(w, person(ANN, inside), bot, await asked(w, bot))).status).toBe(200);
    expect((await pause(w, person(ANN, inside), bot)).status).toBe(200);
    expect((await unpause(w, person(ANN, inside), bot)).status).toBe(200);
    expect((await end(w, person(ANN, inside), bot)).status).toBe(200);
    expect(w.rowOf(bot)).toEqual([null, "active"]);

    const leaving = await sponsored(w, ANN, "leaving");
    expect((await end(w, agent(leaving), leaving)).status).toBe(200);
    await w.runtime.dispose();
  });

  it("[link.card-public] anyone reads who an agent is, and the same card: its name, its kind and the org it works in, its handle when it signed itself up, never who stands behind it", async () => {
    const w = world();
    const held = await sponsored(w, ANN, "carded");
    const card = async (caller: Caller, agentId: string) =>
      answer(await w.handlers.Agents_getAgent(caller, { agentId }));
    const visitor = await card(VISITOR, held);
    expect(visitor).toEqual({
      status: 200,
      body: { id: held, name: "carded", kind: "interactive", org: "acme" },
    });
    for (const reader of [person(BOB), may(), person(ANN), agent(held), agent(w.enrolled("x"))])
      expect(await card(reader, held)).toEqual(visitor);
    expect(JSON.stringify(visitor)).not.toContain(ANN);
    // An agent in no org has no org on its card.
    const placeless = w.enrolled("placeless");
    w.directory.agents.set(placeless, { ...agentRecord(placeless, "placeless"), org: undefined });
    expect((await card(VISITOR, placeless)).body).toEqual({
      id: placeless,
      name: "placeless",
      kind: "interactive",
    });
    // An agent that signed itself up has a handle, which is its own namespace's, and no kind or org.
    const { jkt, jwk } = freshAgentKey();
    const { agent: keyed } = await w.runtime.runPromise(signUpAgent({ jkt, jwk }, "keyed"));
    expect(keyed.handle).toBe(givenHandle(keyed.id));
    expect((await card(VISITOR, keyed.id)).body).toEqual({
      id: keyed.id,
      name: "keyed",
      handle: keyed.handle,
    });
    // An id nobody has and one that is no id read the same.
    const missing = await card(VISITOR, makeId("agt", ulid()));
    expect(refusal(missing)).toEqual(NOT_THERE);
    expect(await card(VISITOR, "agt_not-an-id")).toEqual(missing);
    expect(await card(person(ANN), makeId("agt", ulid()))).toEqual(missing);
    await w.runtime.dispose();
  });
});
