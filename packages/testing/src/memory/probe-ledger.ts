import {
  conflictView,
  hearDecision,
  probeCellRanAt,
  probeDrafted,
  probeDraftFailedAt,
  resolveConflict,
  subjectAddress,
  suspectConflict,
  worldCheckRan,
} from "@keeltown/core/application/coordination";
import type { ConflictCommand } from "@keeltown/core/domain/verification";
import type { ConflictId, EntityRef, EventEnvelope } from "@keeltown/core/kernel";
import {
  type AgentDirectory,
  Clock,
  ConflictMoves,
  EntityStore,
  EventOutbox,
  type HumanGate,
  type Ids,
  ProbeLedger,
  type ProjectNamespaces,
  type SubjectRef,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEscalationsMemory } from "./escalations.ts";
import { makeEventOutboxMemory, makeManualClock } from "./event-outbox.ts";
import { makeAgentDirectoryMemory, makeIdsMemory } from "./identity.ts";
import { makeProjectNamespacesMemory } from "./tenancy.ts";

type Hosted =
  | Clock
  | EntityStore
  | EventOutbox
  | Ids
  | HumanGate
  | AgentDirectory
  | ProjectNamespaces;

/**
 * ProbeLedger and ConflictMoves in memory: one object per Subject DO address,
 * each with its own store and outbox, running the same core use-cases the
 * Subject DO runs. Beside them, what a subject reaches when it escalates: the
 * namespaces' objects (`escalations`), the agents' directory and the
 * projects' places, all empty until a test fills them, so a project belongs
 * to no namespace until it is placed. `suspect` opens a conflict on a
 * subject, as fallout does; `hear` delivers an event to a subject, as the
 * fan-out would.
 */
export function makeProbeLedgerMemory() {
  const ids = makeIdsMemory();
  const clock = makeManualClock();
  const escalations = makeEscalationsMemory(clock);
  const directory = makeAgentDirectoryMemory();
  const orgs = makeProjectNamespacesMemory();
  const objects = new Map<string, Layer.Layer<Hosted>>();
  const objectAt = (at: SubjectRef) => {
    const address = subjectAddress(at.projectId, at.key);
    let object = objects.get(address);
    if (object === undefined) {
      object = Layer.mergeAll(
        makeEventOutboxMemory().layer,
        ids.layer,
        clock.layer,
        escalations.gate,
        directory.layer,
        orgs.layer,
      );
      objects.set(address, object);
    }
    return object;
  };
  const on = <A, E>(at: SubjectRef, program: Effect.Effect<A, E, Hosted>) =>
    Effect.provide(program, objectAt(at));
  const layer = Layer.mergeAll(
    Layer.succeed(
      ProbeLedger,
      ProbeLedger.of({
        conflict: (at, conflictId) => on(at, conflictView(conflictId)),
        probeDrafted: (at, drafted) => on(at, probeDrafted(at.projectId, drafted)),
        probeDraftFailed: (at, failed) => on(at, probeDraftFailedAt(at, failed)),
        probeCellRan: (at, cell) => on(at, probeCellRanAt(at, cell)),
        worldCheckRan: (at, cell) => on(at, worldCheckRan(at.projectId, cell)),
      }),
    ),
    Layer.succeed(
      ConflictMoves,
      ConflictMoves.of({ resolve: (at, command) => on(at, resolveConflict(at, command)) }),
    ),
  );
  return {
    clock,
    escalations,
    directory,
    orgs,
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
    /** Delivers a decision to the subject that raised its escalation, committing what the subject makes of it. */
    hear: (at: SubjectRef, event: EventEnvelope) =>
      on(
        at,
        Effect.gen(function* () {
          const store = yield* EntityStore;
          const outbox = yield* EventOutbox;
          const now = yield* (yield* Clock).now;
          return store.transaction(() => {
            const reaction = hearDecision({ store, outbox, at: now }, at.projectId, event);
            if ("entity" in reaction)
              outbox.append(
                {
                  entity: reaction.entity,
                  cause: event.dedupeKey,
                  causation: event.eventId,
                  project: reaction.project,
                },
                now,
                reaction.drafts,
              );
            return reaction;
          });
        }),
      ),
    layer,
    /** The subjects with the namespaces they escalate into: every conflict and escalation port at once. */
    world: Layer.mergeAll(layer, escalations.layer),
  };
}
