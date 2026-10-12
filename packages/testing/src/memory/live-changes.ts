import { hearLiveChange, liveAnchors, liveChanges } from "@keeltown/core/application/coordination";
import type { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { type EventDraft, LiveChanges } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEventOutboxMemory } from "./event-outbox.ts";

/**
 * LiveChanges in memory: one index per project, folded by the same
 * `hearLiveChange` the Project DO runs, over an in-memory outbox of its own.
 * `hear` feeds it an event of one of the project's changes, as the fan-out
 * would, and answers the notices the Project DO would commit.
 */
export function makeLiveChangesMemory() {
  const indexes = new Map<ProjectId, ReturnType<typeof makeEventOutboxMemory>>();
  const indexOf = (projectId: ProjectId) => {
    let index = indexes.get(projectId);
    if (index === undefined) {
      index = makeEventOutboxMemory();
      indexes.set(projectId, index);
    }
    return index;
  };
  return {
    hear: (projectId: ProjectId, event: EventEnvelope): readonly EventDraft[] => {
      const { store, service: outbox } = indexOf(projectId);
      return store.service.transaction(() =>
        hearLiveChange({ store: store.service, outbox }, projectId, event),
      );
    },
    /** Where the project's live changes anchor their subjects, as the Project DO answers `liveAnchors`. */
    anchorsOf: (projectId: ProjectId) => liveAnchors(indexOf(projectId).store.service),
    /** The project's index outbox: who it would tell, as the Project DO's own subscriptions. */
    outboxOf: (projectId: ProjectId) => indexOf(projectId).service,
    layer: Layer.succeed(
      LiveChanges,
      LiveChanges.of({
        of: (projectId) => Effect.sync(() => liveChanges(indexOf(projectId).store.service)),
      }),
    ),
  };
}
