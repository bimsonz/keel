import { describe, expect, it } from "@effect/vitest";
import { type ChangeId, CommitSha, ContentHash, makeId } from "@keeltown/core/kernel";
import { ProbeChanges, type RepoRef, type Subscriber } from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";

/** ProbeChanges, and the moves of a change it reads. */
export interface ProbeChangesHarness {
  readonly layer: Layer.Layer<ProbeChanges>;
  /** A change declared, with nothing submitted yet. */
  readonly declare: (changeId: ChangeId) => Effect.Effect<void>;
  /** The change submitted `head` on `base`: its Precheck now runs, so its plan is still to come. */
  readonly submit: (
    changeId: ChangeId,
    world: { readonly repo: RepoRef; readonly head: CommitSha; readonly base: CommitSha },
  ) => Effect.Effect<void>;
  /** The change's Precheck compiled its current submission's plan. */
  readonly compile: (changeId: ChangeId, planHash: ContentHash) => Effect.Effect<void>;
  /** The change's Precheck refused its current submission: it is bounced, with no plan. */
  readonly refuse: (changeId: ChangeId) => Effect.Effect<void>;
  /** The change landed as `landing`, whose first parent on trunk is `parent`. */
  readonly land: (changeId: ChangeId, landing: CommitSha, parent: CommitSha) => Effect.Effect<void>;
  readonly leave: (changeId: ChangeId, state: "withdrawn" | "superseded") => Effect.Effect<void>;
  /** Who the change's next submission, or the end of it, will be sent to. */
  readonly waiting: (changeId: ChangeId) => readonly Subscriber[];
  /** Who the change's plan, or the end that leaves it without one, will be sent to. */
  readonly waitingPlan: (changeId: ChangeId) => readonly Subscriber[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const sha = (c: string) => CommitSha.make(c.repeat(40));
const WORKSPACE: RepoRef = { namespace: "keel-ws-00", name: "ws-probe-changes" };
const SUBSCRIBER: Subscriber = "workflow:Probe/probe-cfl_contract";
const PLAN_SUBSCRIBER: Subscriber = "workflow:KeelWorldCheck/world-cfl_contract-A";

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
      "[probe-changes.plan] a change's plan is read where it stands: none before it submits, compiled once its Precheck compiled it and still when it lands, none when its Precheck refused",
      () => {
        const harness = make();
        const [compiled, landed, refused] = [
          makeId("chg", ulid()),
          makeId("chg", ulid()),
          makeId("chg", ulid()),
        ];
        const plan = ContentHash.make(`sha256:${"5".repeat(64)}`);
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          for (const changeId of [compiled, landed, refused]) {
            yield* harness.declare(changeId);
            expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({
              _tag: "None",
              state: "declared",
            });
            yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          }
          yield* harness.compile(compiled, plan);
          yield* harness.compile(landed, plan);
          yield* harness.land(landed, sha("d"), sha("c"));
          yield* harness.refuse(refused);
          const compiledPlan = { _tag: "Compiled", planHash: plan };
          expect(yield* changes.awaitPlan(compiled, PLAN_SUBSCRIBER)).toEqual(compiledPlan);
          expect(yield* changes.awaitPlan(landed, PLAN_SUBSCRIBER)).toEqual(compiledPlan);
          expect(yield* changes.awaitPlan(refused, PLAN_SUBSCRIBER)).toEqual({
            _tag: "None",
            state: "bounced",
          });
          // An answer that is not Waiting records nobody: nothing more is coming to tell them of.
          for (const changeId of [compiled, landed, refused])
            expect(harness.waitingPlan(changeId)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.plan-waiting] a submitted change whose Precheck has not answered is Waiting, and the read itself keeps the subscriber, once, until the plan compiles",
      () => {
        const harness = make();
        const changeId = makeId("chg", ulid());
        const plan = ContentHash.make(`sha256:${"6".repeat(64)}`);
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          yield* harness.declare(changeId);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({ _tag: "Waiting" });
          // The subscription is the read's own: a plan compiled the moment after still reaches it.
          expect(harness.waitingPlan(changeId)).toEqual([PLAN_SUBSCRIBER]);
          expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({ _tag: "Waiting" });
          expect(harness.waitingPlan(changeId)).toEqual([PLAN_SUBSCRIBER]);
          // A wait for the plan is not a wait for a submission.
          expect(harness.waiting(changeId)).toEqual([]);
          yield* harness.compile(changeId, plan);
          expect(harness.waitingPlan(changeId)).toEqual([]);
          expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({
            _tag: "Compiled",
            planHash: plan,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.plan-ended] a wait for a plan ends when the change's Precheck refuses or the change leaves: the subscriber is let go and the answer is none",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          for (const end of ["bounced", "withdrawn", "superseded"] as const) {
            const changeId = makeId("chg", ulid());
            yield* harness.declare(changeId);
            yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
            expect((yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER))._tag).toBe("Waiting");
            yield* end === "bounced" ? harness.refuse(changeId) : harness.leave(changeId, end);
            expect(harness.waitingPlan(changeId)).toEqual([]);
            expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({
              _tag: "None",
              state: end,
            });
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-changes.plan-resubmitted] a change that submits again is Waiting for the new submission's plan, whatever plan its earlier one compiled",
      () => {
        const harness = make();
        const changeId = makeId("chg", ulid());
        const [first, second] = [
          ContentHash.make(`sha256:${"7".repeat(64)}`),
          ContentHash.make(`sha256:${"8".repeat(64)}`),
        ];
        return Effect.gen(function* () {
          const changes = yield* ProbeChanges;
          yield* harness.declare(changeId);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
          yield* harness.compile(changeId, first);
          yield* harness.submit(changeId, { repo: WORKSPACE, head: sha("c"), base: sha("a") });
          expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({ _tag: "Waiting" });
          yield* harness.compile(changeId, second);
          expect(yield* changes.awaitPlan(changeId, PLAN_SUBSCRIBER)).toEqual({
            _tag: "Compiled",
            planHash: second,
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
        const changes = yield* ProbeChanges;
        const unknown = makeId("chg", ulid());
        const error = yield* Effect.flip(changes.awaitSubmission(unknown, SUBSCRIBER));
        expect(error._tag).toBe("ChangeNotFound");
        const planError = yield* Effect.flip(changes.awaitPlan(unknown, PLAN_SUBSCRIBER));
        expect(planError._tag).toBe("ChangeNotFound");
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
