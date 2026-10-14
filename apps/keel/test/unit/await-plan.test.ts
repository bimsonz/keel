import { describe, expect, it } from "@effect/vitest";
import { awaitPlan, CHANGE, declare } from "@keeltown/core/application/coordination";
import { planStateOf } from "@keeltown/core/application/verification";
import { Change, ChangeState } from "@keeltown/core/domain/coordination";
import { CommitSha, ContentHash, makeId } from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeDecisionsMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const encode = Schema.encodeSync(Change);
const decode = Schema.decodeUnknownSync(Change);

const changeId = makeId("chg", ulidOf(1));
const worldCheck = "workflow:KeelWorldCheck/wc-1";
const earlier = ContentHash.make(`sha256:${"a".repeat(64)}`);
const either = <A>(value: A) => [undefined, value];

const declared = declare({
  changeId,
  agentId: makeId("agt", ulidOf(11)),
  projectId: sampleProjectId,
  origin: "agent",
  goal: "Cache permission lookups per request",
  footprint: [],
  premises: [],
  idempotencyKey: "declare-1",
  fingerprint: "declare-1",
});

/** Fresh in-memory adapters for each case, so no case reads the change another left behind. */
const layers = () =>
  Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    makeManualClock().layer,
    makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
    makeCodeHostMemory().layer,
    makeLiveChangesMemory().layer,
    makeDecisionsMemory().layer,
  );

/** Rewrites the stored change as it would stand in `state`, holding `planHash` or none, and answers it as read back. */
const standing = (state: ChangeState, planHash: ContentHash | undefined) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const written = JSON.parse(
      JSON.stringify(encode({ ...decode(store.get(CHANGE, changeId)), state, planHash })),
    );
    store.put(CHANGE, changeId, written);
    return decode(written);
  });

/** Whether the change's next event of `type` would notify `subscriber`. */
const hears = (subscriber: string, type: string) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox
      .subscribers(type, { entity: { kind: "change", id: changeId }, affected: [] })
      .includes(subscriber),
  );

describe("[b21.await-plan-one-transaction] the read and the subscribe are one transaction", () => {
  it.effect(
    "[b21.await-plan-one-transaction] a waiting answer reads the change and subscribes the instance in the same transaction",
    () =>
      Effect.gen(function* () {
        yield* declared;
        yield* standing("submitted", undefined);
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        // Numbers each transaction, and notes which one the change was read in and which subscribed.
        let opened = 0;
        let open = 0;
        const seen: { read?: number; subscribed?: number } = {};
        const counted = EntityStore.of({
          ...store,
          transaction: (body) => {
            opened += 1;
            const outer = open;
            open = opened;
            try {
              return store.transaction(body);
            } finally {
              open = outer;
            }
          },
          get: (kind, id) => {
            if (kind === CHANGE) seen.read = open;
            return store.get(kind, id);
          },
        });
        const watched = EventOutbox.of({
          ...outbox,
          subscribe: (subscriber, types, scope, options) => {
            if (subscriber === worldCheck) seen.subscribed = open;
            outbox.subscribe(subscriber, types, scope, options);
          },
        });
        const answer = yield* awaitPlan(changeId, worldCheck).pipe(
          Effect.provideService(EntityStore, counted),
          Effect.provideService(EventOutbox, watched),
        );
        expect(answer).toEqual({ waiting: true });
        expect(seen.read).toBeGreaterThan(0);
        expect(seen.subscribed).toBe(seen.read);
      }).pipe(Effect.provide(layers())),
  );
});

describe("[b21.await-plan-agrees] the Change DO and KeelWorldCheck read a plan by one rule", () => {
  it.effect(
    "[b21.await-plan-agrees] in every state, with or without a plan hash, it waits and subscribes exactly when KeelWorldCheck would read Pending",
    () =>
      Effect.gen(function* () {
        yield* declared;
        let n = 0;
        const pending: ChangeState[] = [];
        for (const state of ChangeState.literals)
          for (const planHash of either(earlier)) {
            const change = yield* standing(state, planHash);
            const subscriber = `workflow:KeelWorldCheck/agrees-${(n += 1)}`;
            const answer = yield* awaitPlan(changeId, subscriber);
            const told = yield* hears(subscriber, "PlanCompiled");
            const waits = planStateOf(change)._tag === "Pending";
            if (waits) pending.push(state);
            expect({ state, planHash, told, ...answer }).toMatchObject(
              waits ? { waiting: true, told: true } : { change, told: false },
            );
            expect("waiting" in answer).toBe(waits);
          }
        expect(n).toBe(ChangeState.literals.length * 2);
        // A resubmitted change still holds its earlier plan's hash: both states wait with and without one.
        expect(pending).toEqual(["submitted", "submitted", "deriving", "deriving"]);
      }).pipe(Effect.provide(layers())),
  );
});

describe("[b21.await-plan] a waiter on a change's plan is told by what ends its Precheck", () => {
  it.effect(
    "[b21.await-plan] a waiting instance hears the plan, a drift, a bounce and the change's end, and nothing that leaves Precheck running",
    () =>
      Effect.gen(function* () {
        yield* declared;
        yield* standing("submitted", undefined);
        expect(yield* awaitPlan(changeId, worldCheck)).toEqual({ waiting: true });
        const told: Record<string, boolean> = {};
        for (const type of [
          "PlanCompiled",
          "ChangeDrifted",
          "ChangeBounced",
          "ChangeWithdrawn",
          "ChangeSuperseded",
          // Committed while Precheck still runs: hearing one would spend the waiter's only event.
          "PrecheckStarted",
          "EffectsDerived",
          "DriftDetected",
          "ConflictNoted",
        ])
          told[type] = yield* hears(worldCheck, type);
        expect(told).toEqual({
          PlanCompiled: true,
          ChangeDrifted: true,
          ChangeBounced: true,
          ChangeWithdrawn: true,
          ChangeSuperseded: true,
          PrecheckStarted: false,
          EffectsDerived: false,
          DriftDetected: false,
          ConflictNoted: false,
        });
      }).pipe(Effect.provide(layers())),
  );

  it.effect("[b21.await-plan] an unknown change is ChangeNotFound, and subscribes nothing", () =>
    Effect.gen(function* () {
      const unknown = "workflow:KeelWorldCheck/wc-unknown";
      const error = yield* Effect.flip(awaitPlan(makeId("chg", ulidOf(2)), unknown));
      expect(error._tag).toBe("ChangeNotFound");
      const outbox = yield* EventOutbox;
      const told = outbox.subscribers("PlanCompiled", {
        entity: { kind: "change", id: makeId("chg", ulidOf(2)) },
        affected: [],
      });
      expect(told).not.toContain(unknown);
    }).pipe(Effect.provide(layers())),
  );
});
