import type { PartyWorld, WorldCheckJob } from "@keeltown/core/application/verification";
import { ChangeNotFound } from "@keeltown/core/domain/coordination";
import type { ChangeId, CommitSha, ContentHash } from "@keeltown/core/kernel";
import {
  type PartyAnswer,
  ProbeChanges,
  type RepoRef,
  type Subscriber,
  WorldChecks,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import type { ProbeChangesHarness } from "../contracts/probe-changes.ts";

/**
 * ProbeChanges in memory: each change as the Probe Workflow reads it, moved
 * by the harness. A read that answers Waiting records its subscriber, once;
 * the change's next submission, withdrawal or supersession tells each one
 * through `notify` (the fan-out's sendEvent) and forgets them, as the Change
 * DO's one-shot subscription does.
 */
export function makeProbeChangesMemory(
  notify: (subscriber: Subscriber, changeId: ChangeId) => void = () => {},
): ProbeChangesHarness {
  const changes = new Map<ChangeId, PartyAnswer>();
  const waiting = new Map<ChangeId, Subscriber[]>();
  const move = (changeId: ChangeId, to: PartyAnswer) =>
    Effect.sync(() => {
      changes.set(changeId, to);
      const told = waiting.get(changeId) ?? [];
      waiting.delete(changeId);
      for (const subscriber of told) notify(subscriber, changeId);
    });
  return {
    declare: (changeId) =>
      Effect.sync(() => {
        changes.set(changeId, { _tag: "Waiting" });
      }),
    submit: (
      changeId,
      world: {
        readonly repo: RepoRef;
        readonly head: CommitSha;
        readonly base: CommitSha;
        readonly planHash?: ContentHash;
      },
    ) => move(changeId, { _tag: "Submitted", ...world } satisfies PartyWorld),
    land: (changeId, landing, parent, planHash?: ContentHash) =>
      move(changeId, {
        _tag: "Landed",
        landing,
        parent,
        ...(planHash === undefined ? {} : { planHash }),
      } satisfies PartyWorld),
    leave: (changeId, state) => move(changeId, { _tag: "Gone", state }),
    waiting: (changeId) => [...(waiting.get(changeId) ?? [])],
    layer: Layer.succeed(
      ProbeChanges,
      ProbeChanges.of({
        awaitSubmission: (changeId, subscriber) =>
          Effect.gen(function* () {
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            if (change._tag === "Waiting") {
              const subscribers = waiting.get(changeId) ?? [];
              if (!subscribers.includes(subscriber))
                waiting.set(changeId, [...subscribers, subscriber]);
            }
            return change;
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
