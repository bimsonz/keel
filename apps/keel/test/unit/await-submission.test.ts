import { describe, expect, it } from "@effect/vitest";
import { awaitSubmission, CHANGE, declare } from "@keeltown/core/application/coordination";
import { submissionStateOf } from "@keeltown/core/application/verification";
import { Change, ChangeState } from "@keeltown/core/domain/coordination";
import { CommitSha, makeId } from "@keeltown/core/kernel";
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
const probe = "workflow:Probe/probe-1";
const sha = (n: number) => CommitSha.make(String(n).repeat(40));
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

const layers = Layer.mergeAll(
  makeEventOutboxMemory().layer,
  makeIdsMemory().layer,
  makeManualClock().layer,
  makeWorkspacePoolMemory({ baseSha: CommitSha.make("b".repeat(40)) }).layer,
  makeCodeHostMemory().layer,
  makeLiveChangesMemory().layer,
  makeDecisionsMemory().layer,
);

describe("[b21.await-one-transaction] the read and the subscribe are one transaction", () => {
  it.effect(
    "[b21.await-one-transaction] a waiting answer reads the change and subscribes the instance in the same transaction",
    () =>
      Effect.gen(function* () {
        yield* declared;
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
            if (subscriber === probe) seen.subscribed = open;
            outbox.subscribe(subscriber, types, scope, options);
          },
        });
        const answer = yield* awaitSubmission(changeId, probe).pipe(
          Effect.provideService(EntityStore, counted),
          Effect.provideService(EventOutbox, watched),
        );
        expect(answer).toEqual({ waiting: true });
        expect(seen.read).toBeGreaterThan(0);
        expect(seen.subscribed).toBe(seen.read);
      }).pipe(Effect.provide(layers)),
  );
});

describe("[b21.await-proposal] a Probe waits for a proposal's approval", () => {
  it.effect(
    "[b21.await-proposal] a proposal parked for approval is no submission yet: a Probe waits on it and hears its approval, and an approved one is answered at once",
    () =>
      Effect.gen(function* () {
        yield* declared;
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const stored = decode(store.get(CHANGE, changeId));
        const proposed = (approved?: CommitSha) =>
          JSON.parse(
            JSON.stringify(
              encode({
                ...stored,
                state: "parked",
                parkReason: "awaiting-approval",
                commitSha: sha(1),
                baseSha: sha(2),
                proposal: {
                  fork: makeId("prj", ulidOf(21)),
                  proposer: `user:${makeId("usr", ulidOf(22))}`,
                  ...(approved === undefined ? {} : { approved }),
                },
              }),
            ),
          );
        store.put(CHANGE, changeId, proposed());
        const waiting = yield* awaitSubmission(changeId, "workflow:Probe/unapproved");
        expect(waiting).toEqual({ waiting: true });
        expect(
          outbox.subscribers("ProposalApproved", {
            entity: { kind: "change", id: changeId },
            affected: [],
          }),
        ).toContain("workflow:Probe/unapproved");
        store.put(CHANGE, changeId, proposed(sha(1)));
        const answered = yield* awaitSubmission(changeId, "workflow:Probe/approved");
        expect("waiting" in answered).toBe(false);
      }).pipe(Effect.provide(layers)),
  );
});

describe("[b21.await-agrees] the Change DO and the Probe read a submission by one rule", () => {
  it.effect(
    "[b21.await-agrees] in every state, with or without a commit, a base and a landing, it waits and subscribes exactly when the Probe would read Unsubmitted",
    () =>
      Effect.gen(function* () {
        yield* declared;
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const stored = decode(store.get(CHANGE, changeId));
        let n = 0;
        for (const state of ChangeState.literals)
          for (const commitSha of either(sha(1)))
            for (const baseSha of either(sha(2)))
              for (const landedCommit of either(sha(3))) {
                const written = JSON.parse(
                  JSON.stringify(encode({ ...stored, state, commitSha, baseSha, landedCommit })),
                );
                store.put(CHANGE, changeId, written);
                const change = decode(written);
                const subscriber = `workflow:Probe/agrees-${(n += 1)}`;
                const answer = yield* awaitSubmission(changeId, subscriber);
                const hears = outbox
                  .subscribers("ChangeSubmitted", {
                    entity: { kind: "change", id: changeId },
                    affected: [],
                  })
                  .includes(subscriber);
                const unsubmitted = submissionStateOf(change)._tag === "Unsubmitted";
                expect({ state, commitSha, baseSha, landedCommit, hears, ...answer }).toMatchObject(
                  unsubmitted ? { waiting: true, hears: true } : { change, hears: false },
                );
                expect("waiting" in answer).toBe(unsubmitted);
              }
        expect(n).toBe(ChangeState.literals.length * 8);
      }).pipe(Effect.provide(layers)),
  );
});
