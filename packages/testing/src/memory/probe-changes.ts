import type { PartyWorld, PlanState, WorldCheckJob } from "@keeltown/core/application/verification";
import { ChangeNotFound } from "@keeltown/core/domain/coordination";
import type { ChangeId } from "@keeltown/core/kernel";
import {
  type PartyAnswer,
  type PlanAnswer,
  ProbeChanges,
  type Subscriber,
  WorldChecks,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import type { ProbeChangesHarness } from "../contracts/probe-changes.ts";

/** Records a subscriber against a change, once. */
const keep = (waiters: Map<ChangeId, Subscriber[]>, changeId: ChangeId, subscriber: Subscriber) => {
  const subscribers = waiters.get(changeId) ?? [];
  if (!subscribers.includes(subscriber)) waiters.set(changeId, [...subscribers, subscriber]);
};

/**
 * ProbeChanges in memory: each change as the Probe Workflow and a world check
 * read it, moved by the harness. A read that answers Waiting records its
 * subscriber, once; the change's next move tells each one through `notify`
 * (the fan-out's sendEvent) and forgets them, as the Change DO's one-shot
 * subscriptions do. A wait for a submission and a wait for a plan are told
 * apart: a submission ends the first, and Precheck's answer the second.
 */
export function makeProbeChangesMemory(
  notify: (subscriber: Subscriber, changeId: ChangeId) => void = () => {},
): ProbeChangesHarness & {
  /** The change is a proposal Precheck read, its commit waiting for a maintainer's approval. */
  readonly awaitApproval: (changeId: ChangeId) => Effect.Effect<void>;
} {
  const changes = new Map<ChangeId, { readonly party: PartyAnswer; readonly plan: PlanState }>();
  const waiting = {
    submission: new Map<ChangeId, Subscriber[]>(),
    plan: new Map<ChangeId, Subscriber[]>(),
  };
  const tell = (waiters: Map<ChangeId, Subscriber[]>, changeId: ChangeId) => {
    const told = waiters.get(changeId) ?? [];
    waiters.delete(changeId);
    for (const subscriber of told) notify(subscriber, changeId);
  };
  const planOf = (changeId: ChangeId): PlanState =>
    changes.get(changeId)?.plan ?? { _tag: "None", state: "declared" };
  return {
    declare: (changeId) =>
      Effect.sync(() => {
        changes.set(changeId, {
          party: { _tag: "Waiting" },
          plan: { _tag: "None", state: "declared" },
        });
      }),
    submit: (changeId, world) =>
      Effect.sync(() => {
        changes.set(changeId, {
          party: { _tag: "Submitted", ...world } satisfies PartyWorld,
          plan: { _tag: "Pending" },
        });
        tell(waiting.submission, changeId);
      }),
    compile: (changeId, planHash) =>
      Effect.sync(() => {
        const change = changes.get(changeId);
        if (change === undefined) return;
        changes.set(changeId, { ...change, plan: { _tag: "Compiled", planHash } });
        tell(waiting.plan, changeId);
      }),
    refuse: (changeId) =>
      Effect.sync(() => {
        changes.set(changeId, {
          party: { _tag: "Waiting" },
          plan: { _tag: "None", state: "bounced" },
        });
        tell(waiting.plan, changeId);
      }),
    land: (changeId, landing, parent) =>
      Effect.sync(() => {
        changes.set(changeId, {
          party: { _tag: "Landed", landing, parent } satisfies PartyWorld,
          plan: planOf(changeId),
        });
        tell(waiting.submission, changeId);
      }),
    leave: (changeId, state) =>
      Effect.sync(() => {
        const plan = planOf(changeId);
        changes.set(changeId, {
          party: { _tag: "Gone", state },
          plan: plan._tag === "Compiled" ? plan : { _tag: "None", state },
        });
        tell(waiting.submission, changeId);
        tell(waiting.plan, changeId);
      }),
    awaitApproval: (changeId) =>
      Effect.sync(() => {
        changes.set(changeId, {
          party: { _tag: "Waiting", forApproval: true },
          plan: planOf(changeId),
        });
      }),
    waiting: (changeId) => [...(waiting.submission.get(changeId) ?? [])],
    waitingPlan: (changeId) => [...(waiting.plan.get(changeId) ?? [])],
    layer: Layer.succeed(
      ProbeChanges,
      ProbeChanges.of({
        awaitSubmission: (changeId, subscriber) =>
          Effect.gen(function* () {
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            if (change.party._tag === "Waiting") keep(waiting.submission, changeId, subscriber);
            return change.party;
          }),
        awaitPlan: (changeId, subscriber) =>
          Effect.gen(function* () {
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            if (change.plan._tag !== "Pending") return change.plan;
            keep(waiting.plan, changeId, subscriber);
            return { _tag: "Waiting" } satisfies PlanAnswer;
          }),
      }),
    ),
  };
}

/**
 * WorldChecks in memory: each instance started once, by id, with the job it
 * was started with; a second start of the same id starts nothing new.
 */
export function makeWorldChecksMemory() {
  const started = new Map<string, WorldCheckJob>();
  return {
    started,
    layer: Layer.succeed(
      WorldChecks,
      WorldChecks.of({
        start: (instanceId, job) =>
          Effect.sync(() => {
            if (!started.has(instanceId)) started.set(instanceId, job);
          }),
      }),
    ),
  };
}
