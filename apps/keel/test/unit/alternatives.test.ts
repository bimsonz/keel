import { describe, expect, it } from "@effect/vitest";
import { declare, revise } from "@keeltown/core/application/coordination";
import { entriesAfter, recordDelivery } from "@keeltown/core/application/identity";
import {
  AlternativeDeclared,
  AlternativeLanded,
  alternativeDeclared,
  areAlternatives,
  type LiveChange,
  Proposition,
} from "@keeltown/core/domain/coordination";
import {
  type AgentId,
  ChangeId,
  CommitSha,
  type EventEnvelope,
  Instant,
  type LeaseId,
  makeId,
} from "@keeltown/core/kernel";
import { noticeOf } from "@keeltown/core/domain/identity";
import { type EventDraft, EventOutbox } from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEntityStoreMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeDecisionsMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
  ulidOf,
  heldLease,
  makeEscalationsMemory,
  makeProjectNamespacesMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import * as fc from "fast-check";
import { ulid } from "ulid";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 100, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** Three claims on three subjects: an intent's declared effects are any subset of them. */
const CLAIMS = ["authz.permission-evaluation", "billing.invoice-total", "search.ranking"].map(
  (subject) =>
    Schema.decodeUnknownSync(Proposition)({
      subject,
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    }),
);
const effectsOf = (set: number): Proposition[] => CLAIMS.filter((_, bit) => (set >> bit) & 1);

const changeOf = (i: number): ChangeId => makeId("chg", ulidOf(1 + i));
const agentOf = (i: number): AgentId => makeId("agt", ulidOf(11 + i));
const pair = (a: ChangeId, b: ChangeId) => `${a}/${b}`;

const decodeDeclared = Schema.decodeUnknownSync(AlternativeDeclared);
const decodeLanded = Schema.decodeUnknownSync(AlternativeLanded);

/** A notice the Project DO would commit, as who it tells and about which change. */
type Told =
  | { readonly kind: "declared"; readonly to: ChangeId; readonly about: ChangeId }
  | { readonly kind: "landed"; readonly to: ChangeId; readonly about: ChangeId };

const toldOf = (draft: EventDraft): Told => {
  if (draft.payload._tag === "AlternativeLanded") {
    const landed = decodeLanded(draft.payload);
    expect(draft.affected).toEqual([{ kind: "change", id: landed.changeId }]);
    return { kind: "landed", to: landed.changeId, about: landed.landedChangeId };
  }
  const declared = decodeDeclared(draft.payload);
  expect(draft.affected).toEqual([{ kind: "change", id: declared.changeId }]);
  return { kind: "declared", to: declared.changeId, about: declared.alternativeId };
};

/**
 * One project: each change in its own in-memory Change DO, and the project's
 * index, which hears each change's events only when the test delivers them,
 * so a preflight can read an index that is behind.
 */
function world() {
  const index = makeLiveChangesMemory();
  const object = () =>
    Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeIdsMemory().layer,
      makeManualClock().layer,
      makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
      makeCodeHostMemory().layer,
      index.layer,
      makeDecisionsMemory().layer,
      makeEscalationsMemory().gate,
      makeProjectNamespacesMemory().layer,
    );
  const objects = new Map<
    ChangeId,
    {
      readonly layer: ReturnType<typeof object>;
      leaseId: LeaseId;
      revision: number;
      known: number;
      last?: EventEnvelope | undefined;
      readonly queue: EventEnvelope[];
      ended: boolean;
    }
  >();
  /** Queues the change's newly committed events for the index, in commit order. */
  const enqueue = (changeId: ChangeId) =>
    Effect.gen(function* () {
      const held = objects.get(changeId);
      if (held === undefined) return;
      const log = yield* Effect.gen(function* () {
        return (yield* EventOutbox).log({ kind: "change", id: changeId });
      }).pipe(Effect.provide(held.layer));
      held.queue.push(...log.slice(held.known));
      held.known = log.length;
      held.last = log.at(-1);
    });

  const declared = (i: number, set: number) =>
    Effect.gen(function* () {
      const changeId = changeOf(i);
      const layer = object();
      const answer = yield* declare({
        changeId,
        agentId: agentOf(i),
        projectId: sampleProjectId,
        origin: "agent",
        goal: `attempt ${i}`,
        footprint: [],
        premises: [],
        declaredEffects: effectsOf(set),
        idempotencyKey: `declare-${changeId}`,
        fingerprint: `declare-${changeId}`,
      }).pipe(Effect.provide(layer));
      objects.set(changeId, {
        layer,
        leaseId: heldLease(answer.change).id,
        revision: answer.change.intent.revision,
        known: 0,
        queue: [],
        ended: false,
      });
      yield* enqueue(changeId);
      return answer.preflight;
    });

  const revised = (i: number, set: number) =>
    Effect.gen(function* () {
      const changeId = changeOf(i);
      const held = objects.get(changeId);
      if (held === undefined || held.ended) return undefined;
      const exit = yield* Effect.exit(
        revise(changeId, {
          agentId: agentOf(i),
          projectId: sampleProjectId,
          leaseId: held.leaseId,
          ifMatchRevision: held.revision,
          premisesAdded: [],
          premisesRetracted: [],
          declaredEffects: effectsOf(set),
          idempotencyKey: `revise-${changeId}-${held.revision}`,
        }).pipe(Effect.provide(held.layer)),
      );
      if (Exit.isFailure(exit)) return undefined;
      held.revision = exit.value.change.intent.revision;
      yield* enqueue(changeId);
      return exit.value.preflight;
    });

  /** Ends the change as its Change DO would, queued behind its other events. */
  const ended = (i: number, type: "ChangeLanded" | "ChangeWithdrawn") => {
    const changeId = changeOf(i);
    const held = objects.get(changeId);
    if (held === undefined || held.ended || held.last === undefined) return;
    held.ended = true;
    held.queue.push({
      ...held.last,
      eventId: makeId("evt", ulid()),
      type,
      seq: held.last.seq + 1,
      dedupeKey: `${type}-${changeId}`,
      payload: { _tag: type, changeId },
    });
  };

  const indexed = () => Effect.sync(() => index.live(sampleProjectId));

  /** Delivers the change's next queued event to the index, answering what the index told. */
  const deliver = (changeId: ChangeId) => {
    const event = objects.get(changeId)?.queue.shift();
    if (event === undefined) return undefined;
    return { event, told: index.hear(sampleProjectId, event).map(toldOf) };
  };

  return {
    declared,
    revised,
    ended,
    indexed,
    deliver,
    pending: () => [...objects.entries()].filter(([, held]) => held.queue.length > 0),
    outbox: () => index.outboxOf(sampleProjectId),
  };
}

const alternativePairs = (live: readonly LiveChange[]): ReadonlySet<string> =>
  new Set(
    live.flatMap((a) =>
      live
        .filter((b) => b.id !== a.id && areAlternatives(a.intent, b.intent))
        .map((b) => pair(a.id, b.id)),
    ),
  );

/** Delivers everything queued, change by change in the given order, collecting what was told. */
const settle = (w: ReturnType<typeof world>) => {
  const told: Told[] = [];
  for (;;) {
    const next = w.pending()[0];
    if (next === undefined) return told;
    told.push(...(w.deliver(next[0])?.told ?? []));
  }
};

const [A, B, C] = [changeOf(0), changeOf(1), changeOf(2)];

/** A notice the index commits on the project, about `changeId`. */
const about = (changeId: ChangeId) => ({
  entity: { kind: "project" as const, id: sampleProjectId },
  affected: [{ kind: "change" as const, id: changeId }],
});

/** An event of `type` delivered to the agent, as the fan-out delivers it. */
const arrival = (type: string, payload: object): EventEnvelope => ({
  eventId: makeId("evt", ulid()),
  type,
  entity: { kind: "change", id: A },
  seq: 1,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `${type}-1`,
  affected: [],
  notified: [],
  payload,
});

describe("[b24.awareness] each pair of alternatives is shown to each other once", () => {
  it.effect(
    "[b24.awareness] B declares after A is indexed: B's preflight shows A, and A is told by a notice; B is not",
    () =>
      Effect.gen(function* () {
        const w = world();
        yield* w.declared(0, 0b011);
        expect(settle(w)).toEqual([]);
        const preflight = yield* w.declared(1, 0b011);
        expect(preflight.alternatives).toEqual([A]);
        expect(settle(w)).toEqual([{ kind: "declared", to: A, about: B }]);
      }),
  );

  it.effect(
    "[b24.awareness] declared before either is indexed, each preflight missed the other: both are told",
    () =>
      Effect.gen(function* () {
        const w = world();
        const first = yield* w.declared(0, 0b101);
        const second = yield* w.declared(1, 0b101);
        expect(first.alternatives).toBeUndefined();
        expect(second.alternatives).toBeUndefined();
        expect(settle(w).toSorted((x, y) => x.to.localeCompare(y.to))).toEqual([
          { kind: "declared", to: A, about: B },
          { kind: "declared", to: B, about: A },
        ]);
      }),
  );

  it.effect(
    "[b24.awareness] a partial overlap, a superset and no effects at all are no one's alternative",
    () =>
      Effect.gen(function* () {
        const w = world();
        yield* w.declared(0, 0b011);
        settle(w);
        expect((yield* w.declared(1, 0b001)).alternatives).toBeUndefined();
        expect((yield* w.declared(2, 0b111)).alternatives).toBeUndefined();
        expect((yield* w.declared(3, 0)).alternatives).toBeUndefined();
        expect(settle(w)).toEqual([]);
      }),
  );

  it.effect(
    "[b24.awareness] B diverges and converges again: A is told again, and B's preflight shows A again",
    () =>
      Effect.gen(function* () {
        const w = world();
        yield* w.declared(0, 0b110);
        settle(w);
        yield* w.declared(1, 0b110);
        expect(settle(w)).toEqual([{ kind: "declared", to: A, about: B }]);
        expect((yield* w.revised(1, 0b010))?.alternatives).toBeUndefined();
        expect(settle(w)).toEqual([]);
        expect((yield* w.revised(1, 0b110))?.alternatives).toEqual([A]);
        expect(settle(w)).toEqual([{ kind: "declared", to: A, about: B }]);
        // A relying on nothing new changes nothing: they have been shown to each other.
        expect((yield* w.revised(0, 0b110))?.alternatives).toEqual([B]);
        expect(settle(w)).toEqual([]);
      }),
  );

  it("[b24.awareness] any declares, revisions, ends and delivery order: shown once per convergence, never redundantly, never wrongly", async () => {
    const op = fc.oneof(
      fc.record({ op: fc.constant("declare" as const), i: fc.nat(3), set: fc.nat(7) }),
      fc.record({ op: fc.constant("revise" as const), i: fc.nat(3), set: fc.nat(7) }),
      fc.record({ op: fc.constant("deliver" as const), i: fc.nat(3) }),
      fc.record({ op: fc.constant("deliver" as const), i: fc.nat(3) }),
      fc.record({ op: fc.constant("end" as const), i: fc.nat(3), landed: fc.boolean() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 30, size: "max" }), (ops) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const w = world();
            const declaredAt = new Set<number>();
            let step = 0;
            const convergedAt = new Map<string, number>();
            const shownAt = new Map<string, number>();
            const noticedAt = new Map<string, number>();
            let alternatives: ReadonlySet<string> = new Set();

            const deliverOne = (changeId: ChangeId) =>
              Effect.gen(function* () {
                const before = yield* w.indexed();
                const delivered = w.deliver(changeId);
                if (delivered === undefined) return;
                step += 1;
                const { event, told } = delivered;
                const after = yield* w.indexed();
                const now = alternativePairs(after);
                for (const p of now) if (!alternatives.has(p)) convergedAt.set(p, step);
                alternatives = now;
                if (event.type === "PreflightIssued") {
                  const listed = Schema.decodeUnknownSync(
                    Schema.Struct({ alternatives: Schema.optional(Schema.Array(ChangeId)) }),
                  )(event.payload).alternatives;
                  for (const b of listed ?? []) shownAt.set(pair(changeId, b), step);
                  // Never told what its own preflight just showed it.
                  for (const t of told)
                    if (t.kind === "declared" && t.to === changeId)
                      expect(listed ?? []).not.toContain(t.about);
                } else {
                  expect(told.filter((t) => t.kind === "declared")).toEqual([]);
                }
                for (const t of told.filter((x) => x.kind === "declared")) {
                  const p = pair(t.to, t.about);
                  // Never wrong: they are alternatives in the index as it now is.
                  expect(now.has(p)).toBe(true);
                  // Never twice per convergence.
                  expect((noticedAt.get(p) ?? -1) < (convergedAt.get(p) ?? 0)).toBe(true);
                  noticedAt.set(p, step);
                  shownAt.set(p, step);
                }
                const landedTold = told.filter((x) => x.kind === "landed");
                if (event.type === "ChangeLanded") {
                  const lander = before.find((l) => l.id === changeId);
                  const expected =
                    lander === undefined
                      ? []
                      : before
                          .filter(
                            (l) => l.id !== changeId && areAlternatives(lander.intent, l.intent),
                          )
                          .map((l) => l.id);
                  expect(landedTold.map((t) => t.to).toSorted()).toEqual(expected.toSorted());
                  for (const t of landedTold) expect(t.about).toBe(changeId);
                } else expect(landedTold).toEqual([]);
              });

            for (const o of ops) {
              if (o.op === "declare" && !declaredAt.has(o.i)) {
                declaredAt.add(o.i);
                yield* w.declared(o.i, o.set);
              } else if (o.op === "revise") yield* w.revised(o.i, o.set);
              else if (o.op === "deliver") yield* deliverOne(changeOf(o.i));
              else if (o.op === "end") w.ended(o.i, o.landed ? "ChangeLanded" : "ChangeWithdrawn");
            }
            for (let next = w.pending()[0]; next !== undefined; next = w.pending()[0])
              yield* deliverOne(next[0]);
            // Shown at least once since they last became alternatives, by a preflight or a notice.
            for (const p of alternatives)
              expect(shownAt.get(p) ?? -1).toBeGreaterThanOrEqual(convergedAt.get(p) ?? 0);
          }),
        ),
      ),
    );
  });
});

describe("[b24.alternative-landed] a landing tells each of the lander's alternatives", () => {
  it.effect(
    "[b24.alternative-landed] A lands: B, its alternative, is told; C, a partial overlap, is not; nor is A",
    () =>
      Effect.gen(function* () {
        const w = world();
        yield* w.declared(0, 0b011);
        yield* w.declared(1, 0b011);
        yield* w.declared(2, 0b001);
        settle(w);
        w.ended(0, "ChangeLanded");
        expect(settle(w)).toEqual([{ kind: "landed", to: B, about: A }]);
        expect((yield* w.indexed()).map((l) => l.id).toSorted()).toEqual([B, C].toSorted());
      }),
  );

  it.effect("[b24.alternative-landed] a withdrawn change tells no one", () =>
    Effect.gen(function* () {
      const w = world();
      yield* w.declared(0, 0b011);
      yield* w.declared(1, 0b011);
      settle(w);
      w.ended(0, "ChangeWithdrawn");
      expect(settle(w)).toEqual([]);
    }),
  );
});

describe("[b24.adopted] the index tells the change's current agent", () => {
  it.effect(
    "[b24.adopted] each change's agent hears its notices, scoped to its own change; an end stops it",
    () =>
      Effect.gen(function* () {
        const w = world();
        yield* w.declared(0, 0b011);
        yield* w.declared(1, 0b011);
        settle(w);
        const outbox = w.outbox();
        expect(outbox.subscribers("AlternativeDeclared", about(A))).toEqual([
          `agent:${agentOf(0)}`,
        ]);
        expect(outbox.subscribers("AlternativeLanded", about(B))).toEqual([`agent:${agentOf(1)}`]);
        w.ended(0, "ChangeWithdrawn");
        settle(w);
        expect(outbox.subscribers("AlternativeDeclared", about(A))).toEqual([]);
        expect(outbox.subscribers("AlternativeDeclared", about(B))).toEqual([
          `agent:${agentOf(1)}`,
        ]);
      }),
  );
});

describe("[b24.notice-detail] an inbox entry keeps what its event says beyond its type", () => {
  const view = { kind: "read", title: "View the conflict", operationId: "getConflict" } as const;

  it("[b24.notice-detail] [b24.notice-next-actions] ConflictNoted keeps its evidence and next actions, AlternativeDeclared names the other change, and an event naming neither keeps neither", () => {
    const store = makeEntityStoreMemory().service;
    recordDelivery(
      store,
      arrival("ConflictNoted", {
        _tag: "ConflictNoted",
        changeId: A,
        conflictId: makeId("cfl", ulidOf(5)),
        predicate: "freshness",
        policy: "advise",
        evidenceRef: "probe:prb_1",
        nextActions: [view],
      }),
    );
    recordDelivery(
      store,
      arrival(
        "AlternativeDeclared",
        Schema.encodeSync(AlternativeDeclared)(alternativeDeclared(sampleProjectId, A, B)),
      ),
    );
    recordDelivery(store, arrival("ChangeQueued", { _tag: "ChangeQueued", changeId: A }));
    const [noted, alternative, queued] = entriesAfter(store, undefined).map(({ position, entry }) =>
      noticeOf(entry, position),
    );
    expect(noted).toMatchObject({ detail: "probe:prb_1", nextActions: [view] });
    expect(alternative).toMatchObject({
      detail: `${B} was declared with the same intent as your change ${A}`,
      nextActions: alternativeDeclared(sampleProjectId, A, B).nextActions,
    });
    expect(queued).not.toHaveProperty("detail");
    expect(queued).not.toHaveProperty("nextActions");
  });
});
