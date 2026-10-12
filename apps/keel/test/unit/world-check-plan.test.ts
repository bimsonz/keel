// A world check's plans, read where the check runs: core's resolveCheckPlans
// over the memory ProbeChanges and the Workflow's steps in memory. The Probe
// starts a world's checks the moment a party submits, so the party's Precheck
// has usually not compiled its plan: the check waits for it by event.
import { describe, expect, it } from "@effect/vitest";
import {
  type PlannedCheck,
  partyEventType,
  resolveCheckPlans,
  WORLD_CHECK_PLAN_WAIT_MS,
} from "@keeltown/core/application/verification";
import { type ChangeId, CommitSha, ContentHash, makeId } from "@keeltown/core/kernel";
import type { RepoRef } from "@keeltown/core/ports";
import { makeManualClock, makeProbeChangesMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { memorySteps } from "./memory-steps.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const sha = (c: string) => CommitSha.make(c.repeat(40));
const WORKSPACE: RepoRef = { namespace: "keel-ws-00", name: "ws-world-check-plan" };
const [PLAN_A, PLAN_B, PLAN_TRUNK] = [hash(51), hash(52), hash(50)];

/** A check whose wait ran out, as it is recorded. */
const late = (changeId: ChangeId) => ({
  _tag: "Unplanned",
  reason: `${changeId}'s Precheck compiled no plan within 5 minutes`,
});

/** AB's world check of one conflict: both parties declared, nothing submitted until a case says so. */
function world() {
  const [A, B] = [makeId("chg", ulid()), makeId("chg", ulid())];
  const instanceId = `world-${makeId("cfl", ulid())}-AB`;
  // Written out, not derived: it is the address the fan-out routes to this instance.
  const subscriber = `workflow:KeelWorldCheck/${instanceId}`;
  const told: { readonly subscriber: string; readonly changeId: ChangeId }[] = [];
  const changes = makeProbeChangesMemory((to, changeId) => {
    told.push({ subscriber: to, changeId });
  });
  const clock = makeManualClock();
  const layer = Layer.mergeAll(changes.layer, clock.layer);
  const checks: readonly PlannedCheck[] = [
    { check: `suite:${A}`, plan: { _tag: "OfChange", changeId: A } },
    { check: `suite:${B}`, plan: { _tag: "OfChange", changeId: B } },
  ];
  const submit = (changeId: ChangeId) =>
    changes.submit(changeId, { repo: WORKSPACE, head: sha("b"), base: sha("a") });
  return {
    A,
    B,
    instanceId,
    subscriber,
    told,
    changes,
    clock,
    checks,
    submit,
    setup: Effect.all([changes.declare(A), changes.declare(B)]),
    /** Whether this instance was sent an event of `type`: the Workflow keeps one sent before the wait began. */
    heard: (type: string) =>
      Effect.sync(() =>
        told.some((t) => t.subscriber === subscriber && partyEventType(t.changeId) === type),
      ),
    run: (steps: ReturnType<ReturnType<typeof memorySteps>["steps"]>, of = checks) =>
      resolveCheckPlans(of, instanceId, steps).pipe(Effect.provide(layer)),
  };
}

describe("resolveCheckPlans", () => {
  it.effect(
    "[world-check-plan.compiled] a party whose Precheck has compiled reads its plan at once, with no wait and no subscriber kept",
    () => {
      const w = world();
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.setup;
        for (const [changeId, plan] of [
          [w.A, PLAN_A],
          [w.B, PLAN_B],
        ] as const) {
          yield* w.submit(changeId);
          yield* w.changes.compile(changeId, plan);
        }
        expect(yield* w.run(s.steps())).toEqual([
          { check: `suite:${w.A}`, plan: { _tag: "Planned", planHash: PLAN_A } },
          { check: `suite:${w.B}`, plan: { _tag: "Planned", planHash: PLAN_B } },
        ]);
        expect(s.waits).toEqual([]);
        expect(w.changes.waitingPlan(w.A)).toEqual([]);
        expect(w.changes.waitingPlan(w.B)).toEqual([]);
      });
    },
  );

  it.effect(
    "[world-check-plan.waits] a party submitted with its Precheck still running is waited for as this instance, and its plan is read once the change says it compiled",
    () => {
      const w = world();
      const s = memorySteps({
        onWait: (type) =>
          Effect.gen(function* () {
            // The party's Precheck answers while the instance sleeps.
            expect(w.changes.waitingPlan(w.A)).toEqual([w.subscriber]);
            yield* w.changes.compile(w.A, PLAN_A);
            return yield* w.heard(type);
          }),
      });
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.A);
        const [first] = w.checks;
        expect(yield* w.run(s.steps(), first === undefined ? [] : [first])).toEqual([
          { check: `suite:${w.A}`, plan: { _tag: "Planned", planHash: PLAN_A } },
        ]);
        expect(s.waits).toEqual([
          {
            name: `change suite:${w.A} 1`,
            type: partyEventType(w.A),
            timeoutMs: WORLD_CHECK_PLAN_WAIT_MS,
          },
        ]);
        expect(w.told).toEqual([{ subscriber: w.subscriber, changeId: w.A }]);
      });
    },
  );

  it.effect(
    "[world-check-plan.compiled-before-wait] a plan compiled between the read and the wait still reaches the check: the read itself subscribed, so the event was already sent",
    () => {
      const w = world();
      const s = memorySteps({
        // PlanCompiled lands right after the read answered Waiting, before the instance waits.
        after: { [`plan of suite:${w.A} 1`]: w.changes.compile(w.A, PLAN_A) },
        onWait: (type) => w.heard(type),
      });
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.A);
        const [first] = w.checks;
        expect(yield* w.run(s.steps(), first === undefined ? [] : [first])).toEqual([
          { check: `suite:${w.A}`, plan: { _tag: "Planned", planHash: PLAN_A } },
        ]);
        expect(w.told).toEqual([{ subscriber: w.subscriber, changeId: w.A }]);
        expect(s.ran).toContain(`plan of suite:${w.A} 2`);
      });
    },
  );

  it.effect(
    "[world-check-plan.none] a party with no plan coming is unplanned at once, saying its state: not yet submitted, refused by its Precheck, or not a change",
    () => {
      const w = world();
      const s = memorySteps();
      const stranger = makeId("chg", ulid());
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.B);
        yield* w.changes.refuse(w.B);
        const plans = yield* w.run(s.steps(), [
          ...w.checks,
          { check: `suite:${stranger}`, plan: { _tag: "OfChange", changeId: stranger } },
        ]);
        expect(plans).toEqual([
          {
            check: `suite:${w.A}`,
            plan: { _tag: "Unplanned", reason: `${w.A} is declared with no compiled plan` },
          },
          {
            check: `suite:${w.B}`,
            plan: { _tag: "Unplanned", reason: `${w.B} is bounced with no compiled plan` },
          },
          {
            check: `suite:${stranger}`,
            plan: { _tag: "Unplanned", reason: `${stranger} is not a change` },
          },
        ]);
        expect(s.waits).toEqual([]);
      });
    },
  );

  it.effect(
    "[world-check-plan.refused-while-waiting] a Precheck that refuses while the check waits ends the wait: the check is unplanned, saying the change bounced",
    () => {
      const w = world();
      const s = memorySteps({
        onWait: (type) =>
          Effect.gen(function* () {
            yield* w.changes.refuse(w.A);
            return yield* w.heard(type);
          }),
      });
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.A);
        const [first] = w.checks;
        expect(yield* w.run(s.steps(), first === undefined ? [] : [first])).toEqual([
          {
            check: `suite:${w.A}`,
            plan: { _tag: "Unplanned", reason: `${w.A} is bounced with no compiled plan` },
          },
        ]);
      });
    },
  );

  it.effect(
    "[world-check-plan.deadline] the checks of one world wait five minutes in all: a wait that runs out is unplanned, saying so, and the next party is given only what is left",
    () => {
      const w = world();
      let woken = 0;
      const s = memorySteps({
        // A's Precheck never answers: an event wakes its wait after four minutes, and the next runs out.
        onWait: () =>
          Effect.sync(() => {
            woken += 1;
            w.clock.advance(woken === 1 ? 4 * 60_000 : 60_000);
            return woken === 1;
          }),
      });
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.A);
        yield* w.submit(w.B);
        expect(yield* w.run(s.steps())).toEqual([
          { check: `suite:${w.A}`, plan: late(w.A) },
          { check: `suite:${w.B}`, plan: late(w.B) },
        ]);
        // A woke with a minute left and waited it out; B, read at the deadline, never waited.
        expect(s.waits.map((wait) => [wait.type, wait.timeoutMs])).toEqual([
          [partyEventType(w.A), WORLD_CHECK_PLAN_WAIT_MS],
          [partyEventType(w.A), 60_000],
        ]);
      });
    },
  );

  it.effect(
    "[world-check-plan.replay] a replay answers every kept step and wait without reading a change again, and counts the deadline from the first run's start",
    () => {
      const w = world();
      const s = memorySteps({
        onWait: (type) =>
          Effect.gen(function* () {
            yield* w.changes.compile(w.A, PLAN_A);
            yield* w.changes.compile(w.B, PLAN_B);
            return yield* w.heard(type);
          }),
      });
      return Effect.gen(function* () {
        yield* w.setup;
        yield* w.submit(w.A);
        yield* w.submit(w.B);
        const first = yield* w.run(s.steps());
        const ran = [...s.ran];
        expect(ran[0]).toBe("started");
        // The replay runs long after, with the changes moved on: it must answer what was kept.
        w.clock.advance(60 * 60_000);
        yield* w.changes.leave(w.A, "withdrawn");
        yield* w.submit(w.B);
        expect(yield* w.run(s.steps())).toEqual(first);
        expect(s.ran).toEqual(ran);
        expect(s.waits).toHaveLength(1);
      });
    },
  );

  it.effect(
    "[world-check-plan.named] a check that names its plan, or why it has none, is kept as it is: trunk's world reads no change and keeps no step",
    () => {
      const w = world();
      const s = memorySteps();
      const named: readonly PlannedCheck[] = [
        { check: "suite:trunk", plan: { _tag: "Planned", planHash: PLAN_TRUNK } },
        { check: "suite:other", plan: { _tag: "Unplanned", reason: "trunk's flow is invalid" } },
      ];
      return Effect.gen(function* () {
        expect(yield* w.run(s.steps(), named)).toEqual(named);
        expect(s.ran).toEqual([]);
      });
    },
  );
});
