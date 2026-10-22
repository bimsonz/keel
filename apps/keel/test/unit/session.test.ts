import { describe, expect, it } from "@effect/vitest";
import {
  AGENT,
  currentSession,
  enrol,
  HELD_LEASE,
  hearEvent,
  INBOX,
  type OpenSessionCommand,
  openSession,
  readInbox,
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
import { Agent, InboxEntry } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  agentActor,
  type ChangeId,
  CommitSha,
  ContentHash,
  EventEnvelope,
  Instant,
  makeId,
  type RunId,
  RunLabel,
  type RunRef,
  type UserId,
} from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeEntityStoreMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeManualClock,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
  heldLease,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const agentId = makeId("agt", ulidOf(1));
const other = makeId("agt", ulidOf(2));
const sponsor = makeId("usr", ulidOf(3));

/** Two runs of the agent, as two of Keel's lanes would be, and a run of the other agent. */
const RUN_B: RunRef = { id: makeId("run", ulidOf(21)), label: RunLabel.make("run-b") };
const RUN_C: RunRef = { id: makeId("run", ulidOf(22)), label: RunLabel.make("run-c") };
const THEIRS: RunRef = { id: makeId("run", ulidOf(23)), label: RunLabel.make("run-b") };

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
    namespace: sampleOrgId,
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
  run?: RunRef,
) {
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: { kind: "change", id: changeId },
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `change:${changeId}/cause-${seq}/${type}#1`,
    ...(actor === undefined ? {} : { actor: agentActor(actor) }),
    ...(run === undefined ? {} : { run }),
    affected: [],
    notified: [],
    payload,
  });
}

/** An event another entity commits and delivers to the agent: a project's, a verdict's, a conflict's. */
function elsewhere(
  seq: number,
  type: string,
  at: {
    readonly entity: { readonly kind: string; readonly id: string };
    readonly payload: object;
    readonly affected?: readonly { readonly kind: string; readonly id: string }[];
  },
) {
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: at.entity,
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `${at.entity.kind}:${at.entity.id}/cause-${seq}/${type}#1`,
    affected: at.affected ?? [],
    notified: [],
    payload: { _tag: type, ...at.payload },
  });
}

/** An event of the agent itself, about no change: the end of its sponsor link, as `actor` (and `run`) caused it. */
function ofTheAgent(seq: number, actor?: AgentId, run?: RunRef) {
  return Schema.decodeUnknownSync(EventEnvelope)({
    ...Schema.encodeSync(EventEnvelope)(
      envelope(changeIdOf(1), seq, "AgentUnsponsored", { _tag: "AgentUnsponsored" }, actor, run),
    ),
    entity: { kind: "agent", id: agentId },
    dedupeKey: `agent:${agentId}/cause-${seq}/AgentUnsponsored#1`,
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
const clear = {
  openProvenConflicts: [],
  failingGuards: [],
  unresolvedHighDrift: [],
  awaitingRuling: [],
};
const SHA = CommitSha.make("c".repeat(40));
const encodeEvent = Schema.encodeSync(ChangeEvent);

/** Who caused a command: the agent behind an agent's call, and nobody for the platform's own. */
function actorOf(kind: (typeof KINDS)[number], change: Change | undefined, by: AgentId) {
  if (kind === "declare" || kind === "adopt") return by;
  if (kind === "submit" || kind === "withdraw") return change?.agentId;
  return undefined;
}

/** A step, and for an agent's own command the run that sends it: one of this agent's two, or the other agent's one. */
type Step = (typeof stepArb extends fc.Arbitrary<infer S> ? S : never) & {
  readonly run?: "b" | "c" | undefined;
};

/** One event `hearEvent` was fed, and the run of this agent that held its change, by the machine's own state. */
interface Heard {
  readonly event: EventEnvelope;
  readonly holder: RunId | undefined;
}

/** The run of this agent that holds a change, as the Change machine's state says. */
const holderOf = (change: Change | undefined): RunId | undefined =>
  change !== undefined && change.agentId === agentId ? change.run?.id : undefined;

/**
 * Replays steps through the domain's Change machine, feeding every event it
 * commits to `hearEvent`. Answers the rows kept and the changes whose lease
 * the agent holds, as the machine's own state says, with the store and every
 * event heard.
 */
function replay(steps: readonly Step[]): {
  rows: string[];
  held: string[];
  store: (typeof EntityStore)["Service"];
  heard: Heard[];
} {
  const memory = makeEntityStoreMemory();
  const store = Effect.runSync(
    Effect.gen(function* () {
      return yield* EntityStore;
    }).pipe(Effect.provide(memory.layer)),
  );
  const heard: Heard[] = [];
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
    const actor = actorOf(step.kind, change, by);
    const mine = step.run === "b" ? RUN_B : RUN_C;
    const run =
      actor === undefined || step.run === undefined ? undefined : actor === agentId ? mine : THEIRS;
    const sent = run === undefined ? {} : { run };
    const leaseId = change?.lease?.id ?? fresh("lse");
    const commands: Record<(typeof KINDS)[number], ChangeCommand> = {
      declare: {
        _tag: "Declare",
        changeId,
        agentId: by,
        ...sent,
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
      adopt: { _tag: "Adopt", agentId: by, ...sent, leaseId: fresh("lse"), briefRef: "brief" },
      withdraw: { _tag: "Withdraw", authority: { _tag: "Lease", leaseId } },
      supersede: { _tag: "Supersede", by: changeIdOf(step.change === 3 ? 1 : step.change + 1) },
    };
    const decided = decideChange(change, commands[step.kind], { now: Instant(now), changeId });
    if (decided._tag === "Failure") continue;
    let next = change;
    for (const payload of decided.success) {
      const before = holderOf(next);
      next = evolveChange(next, { at: Instant(now), payload });
      seq += 1;
      const event = envelope(changeId, seq, payload._tag, encodeEvent(payload), actor, run);
      store.transaction(() => hearEvent(store, agentId, event));
      heard.push({ event, holder: before ?? holderOf(next) });
    }
    if (next !== undefined) changes.set(changeId, next);
  }
  const held = [...changes.values()]
    .filter(
      (change) =>
        !TERMINAL.has(change.state) &&
        heldLease(change).agentId === agentId &&
        heldLease(change).state === "active",
    )
    .map((change) => change.id)
    .toSorted();
  return {
    rows: store
      .list(HELD_LEASE)
      .map((row) => row.id)
      .toSorted(),
    held,
    store,
    heard,
  };
}

type Store = (typeof EntityStore)["Service"];

/** Every notice a run of the agent reads from the start, page after page, as event ids. */
function readAll(store: Store, run?: RunId): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = Effect.runSync(
      readInbox(cursor, run).pipe(Effect.provideService(EntityStore, store)),
    );
    if (page.notices.length === 0) return ids;
    ids.push(...page.notices.map((notice) => notice.id));
    cursor = page.cursor;
  }
}

const hear = (store: Store, event: EventEnvelope) =>
  store.transaction(() => hearEvent(store, agentId, event));

const idsOf = (events: readonly EventEnvelope[]) => events.map((event) => String(event.eventId));
const ids = (notices: readonly { readonly id: string }[]) => notices.map((notice) => notice.id);

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

/* ---------------------------------------------------------------------------
 * Runs: one agent, several streams of work. Its object keeps one inbox and
 * shows each run what is for it, never what it caused.
 * ------------------------------------------------------------------------- */

const runArb = fc.constantFrom("b" as const, "c" as const, undefined);
const runStepArb: fc.Arbitrary<Step> = fc
  .record({ step: stepArb, run: runArb })
  .map(({ step, run }) => ({ ...step, run }));

describe("an agent's runs", () => {
  it("[run.inbox-other-run] what one run does to a change another run holds reaches the holder and not the run that did it", () => {
    const { store, heard } = replay([
      { change: 1, kind: "declare", byMe: true, run: "c", lapse: false },
      { change: 1, kind: "withdraw", byMe: true, run: "b", lapse: false },
    ]);
    const withdrawn = heard.filter(({ event }) => event.type === "ChangeWithdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.event.run).toEqual(RUN_B);
    expect(readAll(store, RUN_C.id)).toEqual(idsOf(withdrawn.map(({ event }) => event)));
    expect(readAll(store, RUN_B.id)).toEqual([]);

    // The same when it takes the change over: the run that held it is told, and what follows is the adopter's.
    const taken = replay([
      { change: 1, kind: "declare", byMe: true, run: "c", lapse: false },
      { change: 1, kind: "adopt", byMe: true, run: "b", lapse: true },
    ]);
    const adopted = taken.heard.filter(({ event }) => event.type === "ChangeAdopted");
    expect(adopted).toHaveLength(1);
    expect(readAll(taken.store, RUN_C.id)).toEqual(idsOf(adopted.map(({ event }) => event)));
    expect(readAll(taken.store, RUN_B.id)).toEqual([]);
    const bounced = envelope(changeIdOf(1), 900, "ChangeBounced", { _tag: "ChangeBounced" });
    hear(taken.store, bounced);
    expect(readAll(taken.store, RUN_B.id)).toEqual(idsOf([bounced]));
    expect(readAll(taken.store, RUN_C.id)).toEqual(idsOf(adopted.map(({ event }) => event)));
  });

  it("[run.inbox-own] a run never reads what it caused, by a read or on a tool result, and what it does to a change it holds is not kept at all", () => {
    const { store } = replay([
      { change: 1, kind: "declare", byMe: true, run: "b", lapse: false },
      { change: 1, kind: "withdraw", byMe: true, run: "b", lapse: false },
    ]);
    expect(store.list(INBOX.kind)).toEqual([]);

    // An event about no change is every run's but the one that caused it.
    const ended = ofTheAgent(901, agentId, RUN_B);
    hear(store, ended);
    const take = (run?: RunId) =>
      Effect.runSync(takeNotices(3, run).pipe(Effect.provideService(EntityStore, store))).map(
        (notice) => notice.id,
      );
    expect(take(RUN_B.id)).toEqual([]);
    expect(take(RUN_C.id)).toEqual(idsOf([ended]));
    expect(readAll(store, RUN_B.id)).toEqual([]);
    expect(readAll(store, RUN_C.id)).toEqual(idsOf([ended]));
    expect(readAll(store)).toEqual(idsOf([ended]));
  });

  it("[run.inbox-for] a notice about one run's change is that run's alone, whoever caused it; a notice about no change is every run's", () => {
    const { store } = replay([
      { change: 1, kind: "declare", byMe: true, run: "c", lapse: false },
      { change: 2, kind: "declare", byMe: true, run: "b", lapse: false },
      { change: 3, kind: "declare", byMe: true, lapse: false },
    ]);
    const onC = envelope(changeIdOf(1), 900, "ChangeBounced", { _tag: "ChangeBounced" });
    const onB = envelope(
      changeIdOf(2),
      901,
      "ChangeBounced",
      { _tag: "ChangeBounced" },
      other,
      THEIRS,
    );
    // The project's notice of an alternative names run C's change in its payload alone.
    const named = elsewhere(902, "AlternativeDeclared", {
      entity: { kind: "project", id: sampleProjectId },
      payload: { changeId: changeIdOf(1), alternativeId: changeIdOf(9) },
      affected: [{ kind: "change", id: changeIdOf(1) }],
    });
    // A verdict names the change it judged as its subject.
    const verdict = elsewhere(903, "VerdictIssued", {
      entity: { kind: "verdict", id: makeId("vrd", ulidOf(7)) },
      payload: { verdictId: makeId("vrd", ulidOf(7)), subject: changeIdOf(2) },
    });
    // A conflict put to a person names its parties only in what it affects: run C's change and another agent's.
    const escalated = elsewhere(904, "ConflictEscalated", {
      entity: { kind: "conflict", id: makeId("cfl", ulidOf(8)) },
      payload: { conflictId: makeId("cfl", ulidOf(8)) },
      affected: [
        { kind: "change", id: changeIdOf(9) },
        { kind: "change", id: changeIdOf(1) },
      ],
    });
    // One between two of the agent's own runs is for both, so for every run.
    const between = elsewhere(905, "ConflictResolved", {
      entity: { kind: "conflict", id: makeId("cfl", ulidOf(9)) },
      payload: { conflictId: makeId("cfl", ulidOf(9)) },
      affected: [
        { kind: "change", id: changeIdOf(1) },
        { kind: "change", id: changeIdOf(2) },
      ],
    });
    // A change the agent declared under no run is no run's: every run reads of it.
    const onNone = envelope(changeIdOf(3), 906, "ChangeBounced", { _tag: "ChangeBounced" });
    const ofAgent = ofTheAgent(907);
    const all = [onC, onB, named, verdict, escalated, between, onNone, ofAgent];
    for (const event of all) hear(store, event);
    expect(readAll(store, RUN_C.id)).toEqual(
      idsOf([onC, named, escalated, between, onNone, ofAgent]),
    );
    expect(readAll(store, RUN_B.id)).toEqual(idsOf([onB, verdict, between, onNone, ofAgent]));
    expect(readAll(store)).toEqual(idsOf([between, onNone, ofAgent]));
    const entries = store
      .list(INBOX.kind)
      .map((row) => Schema.decodeUnknownSync(InboxEntry)(row.value));
    expect(entries.map((entry) => [entry.for, entry.by])).toEqual([
      [RUN_C.id, undefined],
      [RUN_B.id, THEIRS.id],
      [RUN_C.id, undefined],
      [RUN_B.id, undefined],
      [RUN_C.id, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("[run.inbox-interleaved] over any interleaving of two runs' commands, another agent's and the platform's: no run reads an event it caused, an event about a change a run holds is read by that run alone, and each run reads exactly what the machine's own state says is for it", () => {
    fc.assert(
      fc.property(fc.array(runStepArb, { minLength: 1, maxLength: 60, size: "max" }), (steps) => {
        const { store, heard, rows, held } = replay(steps);
        expect(rows).toEqual(held);
        const told = heard.filter(
          ({ event }) => !(event.actor === agentActor(agentId) && event.run === undefined),
        );
        const readers = [RUN_B.id, RUN_C.id, undefined];
        const read = readers.map((reader) => readAll(store, reader));
        readers.forEach((reader, at) => {
          const expected = told.filter(
            ({ event, holder }) =>
              (holder === undefined || holder === reader) &&
              (event.run === undefined || event.run.id !== reader),
          );
          expect(read[at]).toEqual(idsOf(expected.map(({ event }) => event)));
        });
        for (const { event, holder } of told) {
          const readBy = readers.filter((_, at) => read[at]?.includes(event.eventId));
          const causer = event.run?.id;
          expect(causer !== undefined && readBy.includes(causer)).toBe(false);
          // An event about a change a run holds: that run alone, or nobody when it caused it.
          expect(holder === undefined ? "every run's" : readBy).toEqual(
            holder === undefined ? "every run's" : causer === holder ? [] : [holder],
          );
        }
        // Nothing is kept that no run would ever be shown.
        for (const row of store.list(INBOX.kind)) {
          const entry = Schema.decodeUnknownSync(InboxEntry)(row.value);
          expect(entry.for === undefined || entry.for !== entry.by).toBe(true);
        }
      }),
    );
  });

  it.effect(
    "[run.piggyback] one run's tool result does not take another run's notice: each run is handed every notice once",
    () =>
      Effect.gen(function* () {
        yield* enrolled();
        const store = yield* EntityStore;
        const events = [1, 2, 3, 4].map((n) =>
          envelope(changeIdOf(n), n, "ChangeBounced", { _tag: "ChangeBounced" }),
        );
        for (const event of events) recordDelivery(store, event);
        expect(ids(yield* takeNotices(3, RUN_B.id))).toEqual(idsOf(events.slice(0, 3)));
        expect(ids(yield* takeNotices(3, RUN_C.id))).toEqual(idsOf(events.slice(0, 3)));
        expect(ids(yield* takeNotices(3, RUN_B.id))).toEqual(idsOf(events.slice(3)));
        expect(ids(yield* takeNotices(3, RUN_B.id))).toEqual([]);
        expect(ids(yield* takeNotices(3))).toEqual(idsOf(events.slice(0, 3)));
        expect((yield* viewSession(agentId, RUN_B.id)).inboxDepth).toBe(0);
        expect((yield* viewSession(agentId, RUN_C.id)).inboxDepth).toBe(1);
        expect((yield* viewSession(agentId)).inboxDepth).toBe(1);
        // A read marks for the run that read, and for no other.
        yield* readInbox(undefined, RUN_C.id);
        expect((yield* viewSession(agentId, RUN_C.id)).inboxDepth).toBe(0);
        expect((yield* viewSession(agentId)).inboxDepth).toBe(1);
        // Three notices for one run alone and then one for the other: none counts for a run it is
        // not for, and the other's tool result reaches past the three to its own.
        const alone = [5, 6, 7, 8].map((n) =>
          envelope(changeIdOf(n), n, "ChangeBounced", { _tag: "ChangeBounced" }),
        );
        alone.forEach((event, at) => recordDelivery(store, event, at < 3 ? RUN_B.id : RUN_C.id));
        expect((yield* viewSession(agentId, RUN_B.id)).inboxDepth).toBe(3);
        expect((yield* viewSession(agentId, RUN_C.id)).inboxDepth).toBe(1);
        expect((yield* viewSession(agentId)).inboxDepth).toBe(1);
        expect(ids(yield* takeNotices(3, RUN_C.id))).toEqual(idsOf(alone.slice(3)));
        expect(ids(yield* takeNotices(3, RUN_B.id))).toEqual(idsOf(alone.slice(0, 3)));
        expect((yield* viewSession(agentId, RUN_B.id)).inboxDepth).toBe(0);
        expect((yield* viewSession(agentId, RUN_C.id)).inboxDepth).toBe(0);
      }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "[run.session] two runs hold a current session each, and a session says which run opened it",
    () =>
      Effect.gen(function* () {
        yield* enrolled(sponsor);
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const b = yield* openSession(agentId, opening("key-b", "body-b", { run: RUN_B }));
        const c = yield* openSession(agentId, opening("key-c", "body-c", { run: RUN_C }));
        expect(b.run).toEqual(RUN_B);
        expect(c.run).toEqual(RUN_C);
        expect(currentSession(store, RUN_B.id)).toEqual(b);
        expect(currentSession(store, RUN_C.id)).toEqual(c);
        expect(currentSession(store)).toBeNull();
        expect((yield* viewSession(agentId, RUN_B.id)).session).toEqual(b);
        expect((yield* viewSession(agentId, RUN_C.id)).session).toEqual(c);
        expect((yield* viewSession(agentId)).session).toBeNull();
        expect(outbox.log({ kind: "session", id: b.id })[0]).toMatchObject({ run: RUN_B });

        // A run's next session replaces its own, and one opened under no run is no run's.
        const again = yield* openSession(agentId, opening("key-b2", "body-b2", { run: RUN_B }));
        const plain = yield* openSession(agentId, opening("key-plain", "body-plain"));
        expect(plain).not.toHaveProperty("run");
        expect(currentSession(store, RUN_B.id)).toEqual(again);
        expect(currentSession(store, RUN_C.id)).toEqual(c);
        expect(currentSession(store)).toEqual(plain);
      }).pipe(Effect.provide(layer())),
  );
});
