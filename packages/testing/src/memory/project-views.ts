import {
  conflictRecord,
  foldViews,
  listChanges,
  listConflicts,
  probeConflict,
  recordFeed,
  viewSnapshot,
} from "@keeltown/core/application/memory";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, ProjectViews } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEntityStoreMemory } from "./storage.ts";

/**
 * The Projector's read models over an in-memory store, folded by the same core
 * functions the Projector DO runs: `arrive` records an event on the feed and
 * folds it, as the DO's receipt does, in one transaction.
 */
export function makeProjectViewsMemory() {
  const store = makeEntityStoreMemory();
  const provided = <A, E>(effect: Effect.Effect<A, E, EntityStore>) =>
    Effect.provide(effect, store.layer);
  /** What a read model skipped, as the DO would log it. */
  const skipped: string[] = [];
  return {
    skipped,
    arrive: (event: EventEnvelope): Effect.Effect<void> =>
      provided(
        Effect.map(EntityStore, (entities) =>
          entities.transaction(() => {
            recordFeed(entities, event);
            const problem = foldViews(entities, event);
            if (problem !== undefined) skipped.push(problem);
          }),
        ),
      ),
    layer: Layer.succeed(
      ProjectViews,
      ProjectViews.of({
        changes: (read) => provided(listChanges(read)),
        snapshot: (project) => provided(viewSnapshot(project)),
        conflicts: (read) => provided(listConflicts(read)),
        conflict: (project, conflictId) => provided(conflictRecord(project, conflictId)),
        probeConflict: (project, probeId) => provided(probeConflict(project, probeId)),
      }),
    ),
  };
}
