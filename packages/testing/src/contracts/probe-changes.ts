import { describe, expect, it } from "@effect/vitest";
import { type ChangeId, CommitSha, ContentHash, makeId } from "@keeltown/core/kernel";
import { ProbeChanges, type RepoRef, type Subscriber } from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";

/** ProbeChanges, and the moves of a change it reads. */
export interface ProbeChangesHarness {
  readonly layer: Layer.Layer<ProbeChanges>;
  /** A change declared, with nothing submitted yet. */
  readonly declare: (changeId: ChangeId) => Effect.Effect<void>;
  /** The change submitted `head` on `base`, verified under `planHash` once Precheck compiled it. */
  readonly submit: (
    changeId: ChangeId,
    world: {
      readonly repo: RepoRef;
      readonly head: CommitSha;
      readonly base: CommitSha;
      readonly planHash?: ContentHash;
    },
  ) => Effect.Effect<void>;
  /** The change landed as `landing`, whose first parent on trunk is `parent`. */
  readonly land: (
    changeId: ChangeId,
    landing: CommitSha,
    parent: CommitSha,
    planHash?: ContentHash,
  ) => Effect.Effect<void>;
  readonly leave: (changeId: ChangeId, state: "withdrawn" | "superseded") => Effect.Effect<void>;
  /** Who the change's next move will be sent to. */
  readonly waiting: (changeId: ChangeId) => readonly Subscriber[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const sha = (c: string) => CommitSha.make(c.repeat(40));
const WORKSPACE: RepoRef = { namespace: "keel-ws-00", name: "ws-probe-changes" };
const SUBSCRIBER: Subscriber = "workflow:Probe/probe-cfl_contract";

export function describeProbeChangesContract(adapter: string, make: () => ProbeChangesHarness) {
  describe(`ProbeChanges contract: ${adapter}`, () => {
    it.effect(
      "[probe-changes.submitted] answers a submitted change's world: the commit it submitted on its base, in its workspace",
      () => {
        const harness = make();
        const changeId = makeId("chg", ulid());
        return Effect.gen(function* () {
          yield* harness.declare(changeId);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          expect(yield* (yield* ProbeChanges).awaitSubmission(changeId, SUBSCRIBER)).toEqual({
            _tag: "Submitted",
            repo: WORKSPACE,
            head: sha("b"),
            base: sha("a"),
          });
          expect(harness.waiting(changeId)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.waiting] a change with nothing submitted answers Waiting and keeps the subscriber, once, until it moves",
      () => {
        const harness = make();
        const changeId = makeId("chg", ulid());
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          yield* harness.declare(changeId);
          expect(yield* changes.awaitSubmission(changeId, SUBSCRIBER)).toEqual({ _tag: "Waiting" });
          expect(yield* changes.awaitSubmission(changeId, SUBSCRIBER)).toEqual({ _tag: "Waiting" });
          expect(harness.waiting(changeId)).toEqual([SUBSCRIBER]);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          expect(harness.waiting(changeId)).toEqual([]);
          expect((yield* changes.awaitSubmission(changeId, SUBSCRIBER))._tag).toBe("Submitted");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.plan] a submitted or landed change answers the plan it was verified under",
      () => {
        const harness = make();
        const [submitted, landed] = [makeId("chg", ulid()), makeId("chg", ulid())];
        const plan = ContentHash.make(`sha256:${"5".repeat(64)}`);
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          for (const changeId of [submitted, landed]) {
            yield* harness.declare(changeId);
            yield* harness.submit(changeId, {
              repo: WORKSPACE,
              head: sha("b"),
              base: sha("a"),
              planHash: plan,
            });
          }
          yield* harness.land(landed, sha("d"), sha("c"), plan);
          expect(yield* changes.awaitSubmission(submitted, SUBSCRIBER)).toMatchObject({
            _tag: "Submitted",
            planHash: plan,
          });
          expect(yield* changes.awaitSubmission(landed, SUBSCRIBER)).toMatchObject({
            _tag: "Landed",
            planHash: plan,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.landed] a landed change answers the commit it landed as and that commit's first parent",
      () => {
        const harness = make();
        const changeId = makeId("chg", ulid());
        return Effect.gen(function* () {
          yield* harness.declare(changeId);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          yield* harness.land(changeId, sha("d"), sha("c"));
          expect(yield* (yield* ProbeChanges).awaitSubmission(changeId, SUBSCRIBER)).toEqual({
            _tag: "Landed",
            landing: sha("d"),
            parent: sha("c"),
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.gone] a withdrawn or superseded change answers Gone at once, with its state, whatever it submitted",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          for (const state of ["withdrawn", "superseded"] as const) {
            const changeId = makeId("chg", ulid());
            yield* harness.declare(changeId);
            yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
            yield* harness.leave(changeId, state);
            expect(yield* changes.awaitSubmission(changeId, SUBSCRIBER)).toEqual({
              _tag: "Gone",
              state,
            });
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect("[probe-changes.unknown] a change that does not exist is ChangeNotFound", () => {
      const harness = make();
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          (yield* ProbeChanges).awaitSubmission(makeId("chg", ulid()), SUBSCRIBER),
        );
        expect(error._tag).toBe("ChangeNotFound");
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
