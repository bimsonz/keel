import {
  decisionIdOf,
  giveRuling,
  namespaceAddress,
  raiseEscalation,
  wideningsOwed,
  widenEscalation,
  withdrawEscalation,
} from "@keeltown/core/application/coordination";
import {
  escalationView,
  foldEscalationViews,
  listEscalations,
  recordFeed,
} from "@keeltown/core/application/memory";
import { EscalationNotFound } from "@keeltown/core/domain/verification";
import type {
  ConflictId,
  EntityRef,
  EscalationId,
  EventEnvelope,
  NamespaceId,
} from "@keeltown/core/kernel";
import {
  type Clock,
  type EntityStore,
  Escalations,
  type EventOutbox,
  HumanGate,
  type ProjectAgents,
  QuestionRaisers,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEventOutboxMemory, makeManualClock, type ManualClock } from "./event-outbox.ts";
import { makeProjectAgentsMemory } from "./invitations.ts";
import { makeEntityStoreMemory } from "./storage.ts";

type Hosted = Clock | EntityStore | EventOutbox | ProjectAgents;

const notFound = (escalationId: EscalationId) =>
  new EscalationNotFound({ escalationId, nextActions: [] });

/**
 * HumanGate and Escalations in memory: one object per namespace address, each
 * with its own store and outbox, running the use-cases the namespace's
 * Durable Object runs; and one view store recording and folding what they
 * commit as the Projector does (the feed first, so each question has its
 * `E-n`), as soon as it is committed.
 */
export function makeEscalationsMemory(clock: ManualClock = makeManualClock()) {
  const objects = new Map<string, ReturnType<typeof makeEventOutboxMemory>>();
  // The rows of the agents invited to a project, which a raise outside an org reads for who is asked first.
  const projectAgents = makeProjectAgentsMemory();
  const views = makeEntityStoreMemory().service;
  const folded = new Set<string>();
  const objectAt = (namespace: NamespaceId) => {
    const address = namespaceAddress(namespace);
    let object = objects.get(address);
    if (object === undefined) {
      object = makeEventOutboxMemory();
      objects.set(address, object);
    }
    return object;
  };
  const on = <A, E>(namespace: NamespaceId, program: Effect.Effect<A, E, Hosted>) =>
    Effect.provide(
      program,
      Layer.mergeAll(objectAt(namespace).layer, clock.layer, projectAgents.layer),
    );
  const log = (namespace: NamespaceId, entity: EntityRef): readonly EventEnvelope[] =>
    objectAt(namespace).service.log(entity);
  /** Folds what the namespace's object has committed on an escalation and its decision, in commit order. */
  const project = (namespace: NamespaceId, escalationId: EscalationId) => {
    const events = [
      ...log(namespace, { kind: "escalation", id: escalationId }),
      ...log(namespace, { kind: "decision", id: decisionIdOf(escalationId) }),
    ];
    for (const event of events) {
      // Each namespace's object mints its own event ids, so two namespaces' ids can be the same.
      const heard = `${namespaceAddress(namespace)}/${event.eventId}`;
      if (folded.has(heard)) continue;
      folded.add(heard);
      recordFeed(views, event);
      foldEscalationViews(views, event);
    }
  };
  const gate = Layer.succeed(
    HumanGate,
    HumanGate.of({
      raise: (request) =>
        on(request.namespace, raiseEscalation(request)).pipe(
          Effect.tap(() => Effect.sync(() => project(request.namespace, request.escalationId))),
        ),
      withdraw: (request) =>
        on(request.namespace, withdrawEscalation(request)).pipe(
          Effect.tap(() => Effect.sync(() => project(request.namespace, request.escalationId))),
        ),
    }),
  );
  const escalations = Layer.succeed(
    Escalations,
    Escalations.of({
      list: (read) => Effect.sync(() => listEscalations(views, read)),
      get: (escalationId) =>
        Effect.suspend(() => {
          const record = escalationView(views, escalationId);
          return record === undefined
            ? Effect.fail(notFound(escalationId))
            : Effect.succeed(record);
        }),
      rule: (command) =>
        Effect.suspend(() => {
          const known = escalationView(views, command.escalationId);
          if (known === undefined) return Effect.fail(notFound(command.escalationId));
          return on(known.namespace, giveRuling(command)).pipe(
            Effect.tap(() => Effect.sync(() => project(known.namespace, command.escalationId))),
            Effect.map((ruled) => ({ ...ruled, label: known.label })),
          );
        }),
    }),
  );
  return {
    clock,
    projectAgents: projectAgents.service,
    gate,
    layer: Layer.mergeAll(gate, escalations),
    /** The events committed on `entity` in a namespace's object. */
    log,
    /** The widenings a namespace's object owes: what its deadlines are armed from. */
    owed: (namespace: NamespaceId) => on(namespace, wideningsOwed),
    /** An escalation's widening deadline coming due, as the object's alarm runs it; what it commits is folded. */
    widen: (namespace: NamespaceId, escalationId: EscalationId) =>
      on(namespace, widenEscalation(escalationId)).pipe(
        Effect.tap(() => Effect.sync(() => project(namespace, escalationId))),
      ),
  };
}
export type EscalationsMemory = ReturnType<typeof makeEscalationsMemory>;

/** `QuestionRaisers` in memory: each recheck it was asked, in order. It withdraws nothing itself. */
export function makeQuestionRaisersMemory() {
  const asked: { readonly raisedBy: string; readonly conflictId: ConflictId }[] = [];
  return {
    asked,
    layer: Layer.succeed(
      QuestionRaisers,
      QuestionRaisers.of({
        recheck: (raisedBy, conflictId) =>
          Effect.sync(() => {
            asked.push({ raisedBy, conflictId });
          }),
      }),
    ),
  };
}
