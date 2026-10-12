import { describe, expect, it } from "@effect/vitest";
import {
  AGENT,
  currentSession,
  enrol,
  HELD_LEASE,
  hearEvent,
  type OpenSessionCommand,
  openSession,
  recordDelivery,
  takeNotices,
  viewSession,
} from "@keeltown/core/application/identity";
import {
  type Change,
  type ChangeCommand,
  ChangeEvent,
  decideChange,
  evolveChange,
  LEASE_TTL_MS,
  type Preflight,
  TERMINAL,
} from "@keeltown/core/domain/coordination";
import { Agent } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  agentActor,
  type ChangeId,
  CommitSha,
  ContentHash,
  EventEnvelope,
  Instant,
  makeId,
  type UserId,
} from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeEntityStoreMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeManualClock,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const agentId = makeId("agt", ulidOf(1));
const other = makeId("agt", ulidOf(2));
const sponsor = makeId("usr", ulidOf(3));

/** One AgentSession DO's state, in memory: its outbox and store, ids and a clock. */
const layer = () =>
  Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    makeManualClock().layer,
    makeAgentDirectoryMemory().layer,
  );

/** Enrols the agent as the operator would, sponsored by the user `by` names when given. */
const enrolled = (by?: UserId) =>
  enrol(agentId, {
    projectId: sampleProjectId,
    name: "session-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    ...(by === undefined ? {} : { sponsor: by }),
    clientId: "client-session-agent",
    secretHash: "sha256:aa",
    idempotencyKey: "enrol-1",
    fingerprint: "enrol-body",
  });

const opening = (
  idempotencyKey: string,
  fingerprint: string,
  more: Partial<OpenSessionCommand> = {},
): OpenSessionCommand => ({
  harness: "claude-code",
  model: "a-model-2026-10",
  idempotencyKey,
  fingerprint,
  ...more,
});

describe("openSession", () => {
  it.effect(
    "[b11.session-open] commits SessionOpened on the session's own entity as the agent's current session; a retry answers it without committing",
    () =>
      Effect.gen(function* () {
        yield* enrolled(sponsor);
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const first = yield* openSession(agentId, opening("key-1", "body-1"));
        expect(first).toMatchObject({
          agentId,
          harness: "claude-code",
          model: "a-model-2026-10",
          sponsor,
        });
        const [opened, ...more] = outbox.log({ kind: "session", id: first.id });
        expect(more).toEqual([]);
        expect(opened).toMatchObject({
          type: "SessionOpened",
          actor: agentActor(agentId),
          project: sampleProjectId,
          payload: {
            _tag: "SessionOpened",
            sessionId: first.id,
            agentId,
            harness: "claude-code",
            model: "a-model-2026-10",
            sponsor,
          },
        });
        expect(currentSession(store)).toEqual(first);

        expect(yield* openSession(agentId, opening("key-1", "body-1"))).toEqual(first);
        expect(outbox.log({ kind: "session", id: first.id })).toHaveLength(1);

        const second = yield* openSession(agentId, opening("key-2", "body-2"));
        expect(second.id).not.toBe(first.id);
        expect(currentSession(store)).toEqual(second);
        // A retry of the first answers it, and leaves the second current.
        expect(yield* openSession(agentId, opening("key-1", "body-1"))).toEqual(first);
        expect(currentSession(store)).toEqual(second);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("[b11.session-idem] refuses a used key with another body, and changes nothing", () =>
    Effect.gen(function* () {
      yield* enrolled();
      const first = yield* openSession(agentId, opening("key-1", "body-1"));
      const refused = yield* Effect.flip(
        openSession(agentId, opening("key-1", "body-2", { model: "another" })),
      );
      expect(refused).toMatchObject({ _tag: "IdempotencyConflict", idempotencyKey: "key-1" });
      expect(currentSession(yield* EntityStore)).toEqual(first);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each([
    { name: "the enrolment's sponsor", by: sponsor },
    { name: "none, for an agent enrolled without one", by: undefined },
  ])("[b11.session-sponsor] the session and SessionOpened carry $name", ({ by }) =>
    Effect.gen(function* () {
      yield* enrolled(by);
      const session = yield* openSession(agentId, opening("key-1", "body-1"));
      const [opened] = (yield* EventOutbox).log({ kind: "session", id: session.id });
      const payload: object = Object(opened?.payload);
      expect([session.sponsor, Reflect.get(payload, "sponsor")]).toEqual([by, by]);
      expect(["sponsor" in session, "sponsor" in payload]).toEqual([
        by !== undefined,
        by !== undefined,
      ]);
    }).pipe(Effect.provide(layer())),
  );

  describe("an agent this object never enrolled, or one that may not act", () => {
    it.effect("[b11.session-admit] is AgentNotKnown before enrolment", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(openSession(agentId, opening("key-1", "body-1")));
        expect(error).toMatchObject({ _tag: "AgentNotKnown", agentId });
      }).pipe(Effect.provide(layer())),
    );

    it.effect.each(["suspended", "revoked"] as const)(
      "[b11.session-admit] is AgentNotAdmitted when %s",
      (state) =>
        Effect.gen(function* () {
          const agent = yield* enrolled();
          const store = yield* EntityStore;
          store.put(
            AGENT,
            agentId,
            JSON.parse(JSON.stringify(Schema.encodeSync(Agent)({ ...agent, state }))),
          );
          const error = yield* Effect.flip(openSession(agentId, opening("key-1", "body-1")));
          expect(error).toMatchObject({ _tag: "AgentNotAdmitted", agentId, reason: state });
          expect(currentSession(store)).toBeNull();
        }).pipe(Effect.provide(layer())),
    );
  });
});

describe("the AgentSession's view", () => {
  it.effect(
    "[b11.snapshot] counts the notices after the piggyback cursor, the leases held and the current session",
    () =>
      Effect.gen(function* () {
        yield* enrolled();
        const store = yield* EntityStore;
        for (let n = 1; n <= 5; n += 1)
          recordDelivery(
            store,
            envelope(changeIdOf(n), n, "ChangeBounced", { _tag: "ChangeBounced" }),
          );
        yield* takeNotices(2);
        store.put(HELD_LEASE, changeIdOf(1), makeId("lse", ulidOf(1)));
        const session = yield* openSession(agentId, opening("key-1", "body-1"));
        expect(yield* viewSession(agentId)).toEqual({ session, inboxDepth: 3, openLeases: 1 });
      }).pipe(Effect.provide(layer())),
  );

  it.effect("is AgentNotKnown before enrolment", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(viewSession(agentId))).toMatchObject({ _tag: "AgentNotKnown" });
    }).pipe(Effect.provide(layer())),
  );
});

/* ---------------------------------------------------------------------------
 * [b11.held-leases]: the rows `hearEvent` keeps equal the changes whose lease
 * the agent holds, as the domain's own machine folds them, over any legal
 * history of several changes, two agents and lapses.
 * ------------------------------------------------------------------------- */

const changeIdOf = (n: number): ChangeId => makeId("chg", ulidOf(n));

function envelope(
  changeId: ChangeId,
  seq: number,
  type: string,
  payload: unknown,
  actor?: AgentId,
) {
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: { kind: "change", id: changeId },
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `change:${changeId}/cause-${seq}/${type}#1`,
    ...(actor === undefined ? {} : { actor: agentActor(actor) }),
    affected: [],
    notified: [],
    payload,
  });
}

const KINDS = [
  "declare",
  "start",
  "submit",
  "precheck",
  "compile",
  "queue",
  "batch",
  "land",
  "bounce",
  "lapse",
  "adopt",
  "withdraw",
  "supersede",
] as const;

const stepArb = fc.record({
  change: fc.integer({ min: 1, max: 3 }),
  kind: fc.constantFrom(...KINDS),
  byMe: fc.boolean(),
  lapse: fc.boolean(),
});

const preflight: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};
const clear = { openProvenConflicts: [], failingGuards: [], unresolvedHighDrift: [] };
const SHA = CommitSha.make("c".repeat(40));
const encodeEvent = Schema.encodeSync(ChangeEvent);

/** Who caused a command: the agent behind an agent's call, and nobody for the platform's own. */
function actorOf(kind: (typeof KINDS)[number], change: Change | undefined, by: AgentId) {
  if (kind === "declare" || kind === "adopt") return by;
  if (kind === "submit" || kind === "withdraw") return change?.agentId;
  return undefined;
}

type Step = typeof stepArb extends fc.Arbitrary<infer S> ? S : never;

/**
 * Replays steps through the domain's Change machine, feeding every event it
 * commits to `hearEvent`. Answers the rows kept and the changes whose lease
 * the agent holds, as the machine's own state says.
 */
function replay(steps: readonly Step[]): { rows: string[]; held: string[] } {
  const memory = makeEntityStoreMemory();
  const store = Effect.runSync(
    Effect.gen(function* () {
      return yield* EntityStore;
    }).pipe(Effect.provide(memory.layer)),
  );
  const changes = new Map<ChangeId, Change>();
  let now = 1_760_000_000_000;
  let seq = 0;
  let minted = 100;
  const fresh = <P extends "lse" | "wsp" | "bat" | "cnd" | "vrd">(prefix: P) =>
    makeId(prefix, ulidOf((minted += 1)));
  for (const step of steps) {
    now += step.lapse ? LEASE_TTL_MS + 1 : 1_000;
    const changeId = changeIdOf(step.change);
    const change = changes.get(changeId);
    const by = step.byMe ? agentId : other;
    const leaseId = change?.lease.id ?? fresh("lse");
    const commands: Record<(typeof KINDS)[number], ChangeCommand> = {
      declare: {
        _tag: "Declare",
        changeId,
        agentId: by,
        origin: "agent",
        goal: "g",
        footprint: [],
        premises: [],
        leaseId: fresh("lse"),
        preflight,
      },
      start: {
        _tag: "Start",
        workspaceId: fresh("wsp"),
        baseSha: CommitSha.make("b".repeat(40)),
      },
      submit: { _tag: "Submit", leaseId, commitSha: SHA, inWorkspace: true },
      precheck: { _tag: "StartPrecheck", instanceId: "precheck" },
      compile: {
        _tag: "CompilePlan",
        drift: [],
        planHash: ContentHash.make(`sha256:${"0".repeat(64)}`),
        steps: 1,
        costEstimate: 1,
      },
      queue: { _tag: "Queue", laneId: "lane:default", blockers: clear },
      batch: { _tag: "Batch", batchId: fresh("bat"), blockers: clear },
      land: {
        _tag: "Land",
        commitSha: SHA,
        trunkSha: CommitSha.make("d".repeat(40)),
        candidateId: fresh("cnd"),
        proofId: "proof",
      },
      bounce: {
        _tag: "Bounce",
        verdictId: fresh("vrd"),
        reasons: ["red"],
        nextActions: [],
        ...(change?.batchId === undefined ? {} : { batchId: change.batchId }),
      },
      lapse: { _tag: "Lapse", leaseId },
      adopt: { _tag: "Adopt", agentId: by, leaseId: fresh("lse"), briefRef: "brief" },
      withdraw: { _tag: "Withdraw", authority: { _tag: "Lease", leaseId } },
      supersede: { _tag: "Supersede", by: changeIdOf(step.change === 3 ? 1 : step.change + 1) },
    };
    const decided = decideChange(change, commands[step.kind], { now: Instant(now), changeId });
    if (decided._tag === "Failure") continue;
    const actor = actorOf(step.kind, change, by);
    let next = change;
    for (const payload of decided.success) {
      next = evolveChange(next, { at: Instant(now), payload });
      seq += 1;
      store.transaction(() =>
        hearEvent(
          store,
          agentId,
          envelope(changeId, seq, payload._tag, encodeEvent(payload), actor),
        ),
      );
    }
    if (next !== undefined) changes.set(changeId, next);
  }
  const held = [...changes.values()]
    .filter(
      (change) =>
        !TERMINAL.has(change.state) &&
        change.lease.agentId === agentId &&
        change.lease.state === "active",
    )
    .map((change) => change.id)
    .toSorted();
  return {
    rows: store
      .list(HELD_LEASE)
      .map((row) => row.id)
      .toSorted(),
    held,
  };
}

describe("[b11.held-leases] the held leases follow the change machine", () => {
  it("[b11.held-leases] keeps exactly the changes whose lease the agent holds, its own events included", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60, size: "max" }), (steps) => {
        const { rows, held } = replay(steps);
        expect(rows).toEqual(held);
      }),
    );
  });

  it("[b11.held-leases] drops a change adopted away before its lapse was committed", () => {
    const { rows, held } = replay([
      { change: 1, kind: "declare", byMe: true, lapse: false },
      { change: 2, kind: "declare", byMe: true, lapse: false },
      { change: 1, kind: "adopt", byMe: false, lapse: true },
    ]);
    expect(held).toEqual([changeIdOf(2)]);
    expect(rows).toEqual(held);
  });
});
