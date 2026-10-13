import {
  conflictRecord,
  decisionsOfGuards,
  decisionsOnSubjects,
  foldViews,
  getDecision,
  listDecisions,
  listChanges,
  listConflicts,
  probeConflict,
  recordFeed,
  viewSnapshot,
} from "@keeltown/core/application/memory";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { Decisions, EntityStore, ProjectViews } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEntityStoreMemory } from "./storage.ts";

/**
 * The Projector's store in memory: `arrive` records an event on the feed and
 * folds it, as the DO's receipt does, in one transaction.
 */
function projectorMemory() {
  const store = makeEntityStoreMemory();
  const provided = <A, E>(effect: Effect.Effect<A, E, EntityStore>) =>
    Effect.provide(effect, store.layer);
  /** What a read model skipped, as the DO would log it. */
  const skipped: string[] = [];
  const arrive = (event: EventEnvelope): Effect.Effect<void> =>
    provided(
      Effect.map(EntityStore, (entities) =>
        entities.transaction(() => {
          recordFeed(entities, event);
          const problem = foldViews(entities, event);
          if (problem !== undefined) skipped.push(problem);
        }),
      ),
    );
  return { provided, skipped, arrive };
}

/** The Projector's read models over an in-memory store, folded by the same core functions the Projector DO runs. */
export function makeProjectViewsMemory() {
  const { provided, skipped, arrive } = projectorMemory();
  return {
    skipped,
    arrive,
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

/** The Projector's decision index over an in-memory store, folded and joined by the same core functions the Projector DO runs. */
export function makeDecisionsMemory() {
  const { provided, skipped, arrive } = projectorMemory();
  return {
    skipped,
    arrive,
    layer: Layer.succeed(
      Decisions,
      Decisions.of({
        get: (decisionId) => provided(getDecision(decisionId)),
        list: (read) => provided(listDecisions(read)),
        ofGuards: (project, guardIds) => provided(decisionsOfGuards(project, guardIds)),
        onSubjects: (project, subjects) => provided(decisionsOnSubjects(project, subjects)),
      }),
    ),
  };
}
