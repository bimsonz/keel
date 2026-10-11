import {
  conflictView,
  probeCellRan,
  probeDrafted,
  probeDraftFailed,
  subjectAddress,
  suspectConflict,
  worldCheckRan,
} from "@keeltown/core/application/coordination";
import type { ConflictCommand } from "@keeltown/core/domain/verification";
import type { ConflictId, EntityRef } from "@keeltown/core/kernel";
import {
  type Clock,
  type EntityStore,
  EventOutbox,
  type Ids,
  ProbeLedger,
  type SubjectRef,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEventOutboxMemory, makeManualClock } from "./event-outbox.ts";
import { makeIdsMemory } from "./identity.ts";

type Hosted = Clock | EntityStore | EventOutbox | Ids;

/**
 * ProbeLedger in memory: one object per Subject DO address, each with its own
 * store and outbox, running the same core use-cases the Subject DO runs.
 * `suspect` opens a conflict on a subject, as its fallout does.
 */
export function makeProbeLedgerMemory() {
  const ids = makeIdsMemory();
  const clock = makeManualClock();
  const objects = new Map<string, Layer.Layer<Hosted>>();
  const objectAt = (at: SubjectRef) => {
    const address = subjectAddress(at.projectId, at.key);
    let object = objects.get(address);
    if (object === undefined) {
      object = Layer.mergeAll(makeEventOutboxMemory().layer, ids.layer, clock.layer);
      objects.set(address, object);
    }
    return object;
  };
  const on = <A, E>(at: SubjectRef, program: Effect.Effect<A, E, Hosted>) =>
    Effect.provide(program, objectAt(at));
  return {
    suspect: (
      at: SubjectRef,
      conflictId: ConflictId,
      suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
    ) => on(at, suspectConflict(at.projectId, conflictId, suspect)),
    /** The events committed on `entity` at that subject. */
    log: (at: SubjectRef, entity: EntityRef) =>
      on(
        at,
        Effect.gen(function* () {
          return (yield* EventOutbox).log(entity);
        }),
      ),
    layer: Layer.succeed(
      ProbeLedger,
      ProbeLedger.of({
        conflict: (at, conflictId) => on(at, conflictView(conflictId)),
        probeDrafted: (at, drafted) => on(at, probeDrafted(at.projectId, drafted)),
        probeDraftFailed: (at, failed) => on(at, probeDraftFailed(at.projectId, failed)),
        probeCellRan: (at, cell) => on(at, probeCellRan(at.projectId, cell)),
        worldCheckRan: (at, cell) => on(at, worldCheckRan(at.projectId, cell)),
      }),
    ),
  };
}
