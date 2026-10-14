import { describe, expect, it } from "@effect/vitest";
import { escalationIdOf, PREMISE_HOLDS } from "@keeltown/core/application/coordination";
import type { ConflictCommand } from "@keeltown/core/domain/verification";
import {
  type ConflictId,
  type EntityRef,
  type EventEnvelope,
  makeId,
  type NamespaceId,
  type ProjectId,
  RunRef,
} from "@keeltown/core/kernel";
import {
  ConflictMoves,
  type ConflictView,
  Escalations,
  ProbeLedger,
  type ResolveCommand,
  type SubjectRef,
} from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";
import { BUNDLE, conflictOn, DISCRIMINATING, ulid } from "./probe-ledger.ts";

/**
 * The `ConflictMoves` suite opens a conflict on a subject through `suspect`
 * and proves it through the ledger, places its project in a namespace through
 * `place`, and reads what was asked through `Escalations`. `settled` waits
 * until those reads show what the subject and its namespace committed.
 */
export interface ConflictMovesHarness {
  readonly layer: Layer.Layer<ConflictMoves | ProbeLedger | Escalations>;
  readonly suspect: (
    at: SubjectRef,
    conflictId: ConflictId,
    suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
  ) => Effect.Effect<ConflictView, unknown>;
  readonly log: (at: SubjectRef, entity: EntityRef) => Effect.Effect<readonly EventEnvelope[]>;
  readonly place: (projectId: ProjectId, namespace: NamespaceId) => Effect.Effect<void>;
  readonly settled: (at: SubjectRef, namespace: NamespaceId) => Effect.Effect<void>;
}

/** Drafts the conflict's probe and runs it three times discriminating: the probe is admitted and the conflict proven. */
const prove = (at: SubjectRef, conflictId: ConflictId) =>
  Effect.gen(function* () {
    const ledger = yield* ProbeLedger;
    const drafted = yield* ledger.probeDrafted(at, { conflictId, attempts: 1, bundleHash: BUNDLE });
    const probeId = drafted.probe?.id;
    if (probeId === undefined) throw new Error("a draft answers its probe");
    for (const run of [1, 2, 3])
      for (const [world, outcome] of DISCRIMINATING)
        yield* ledger.probeCellRan(at, {
          conflictId,
          probeId,
          world,
          run,
          outcome,
          resultRef: `r2://probe/${run}/${world}`,
        });
    return yield* ledger.conflict(at, conflictId);
  });

/** An escalate by a fresh agent, under a fresh key. */
const command = (conflictId: ConflictId, changeId: ResolveCommand["changeId"]) =>
  ({
    conflictId,
    changeId,
    agentId: makeId("agt", ulid()),
    move: "escalate",
    idempotencyKey: `resolve-${ulid()}`,
  }) satisfies ResolveCommand;

const failed = (conflictId: ConflictId) =>
  ({ conflictId, attempts: 3, reason: "worlds-unbuildable" }) as const;

/** The run that makes the move: one of an agent's, named on what it commits. */
const LANE = Schema.decodeUnknownSync(RunRef)({ id: makeId("run", ulid()), label: "run-c" });

const escalated = (log: readonly EventEnvelope[]) =>
  log.filter((event) => event.type === "ConflictEscalated");

export function describeConflictMovesContract(
  name: string,
  makeHarness: () => ConflictMovesHarness,
): void {
  describe(`ConflictMoves contract: ${name}`, () => {
    it.effect(
      "[t35.resolve-escalate] a party's escalate puts a proven conflict to a person once: its sponsor is asked first, under the agent's own name, and the other party's escalate or a retry asks nobody again",
      () => {
        const harness = makeHarness();
        const { at, conflictId, holder, other, suspect } = conflictOn();
        const namespace = makeId("org", ulid());
        const [agent, otherAgent] = [makeId("agt", ulid()), makeId("agt", ulid())];
        const [sponsor, otherSponsor] = [makeId("usr", ulid()), makeId("usr", ulid())];
        const escalationId = escalationIdOf(conflictId);
        const move: ResolveCommand = {
          conflictId,
          changeId: holder,
          agentId: agent,
          sponsor,
          run: LANE,
          move: "escalate",
          note: "the two cannot both ship",
          idempotencyKey: "resolve-1",
        };
        return Effect.gen(function* () {
          yield* harness.place(at.projectId, namespace);
          yield* harness.suspect(at, conflictId, suspect);
          const proven = yield* prove(at, conflictId);
          const moves = yield* ConflictMoves;
          const first = yield* moves.resolve(at, move);
          const retried = yield* moves.resolve(at, move);
          const others = yield* moves.resolve(at, {
            ...move,
            changeId: other,
            agentId: otherAgent,
            sponsor: otherSponsor,
            idempotencyKey: "resolve-2",
          });
          const otherBody = yield* Effect.flip(moves.resolve(at, { ...move, changeId: other }));
          yield* harness.settled(at, namespace);
          const asked = yield* (yield* Escalations).get(escalationId);
          const log = yield* harness.log(at, { kind: "conflict", id: conflictId });

          expect(proven.conflict.state).toBe("proven");
          expect(first.conflict).toMatchObject({ state: "escalated", escalationId });
          expect(retried).toEqual(first);
          expect(others).toEqual(first);
          expect(otherBody._tag).toBe("IdempotencyConflict");
          expect(escalated(log)).toHaveLength(1);
          expect(escalated(log)[0]).toMatchObject({
            actor: `agent:${agent}`,
            // The move is the run's that made it: one agent's lanes are told apart by it.
            run: LANE,
            project: at.projectId,
            payload: { conflictId, escalationId, reason: "human-class" },
            affected: [
              { kind: "change", id: holder },
              { kind: "change", id: other },
            ],
          });
          expect(asked).toMatchObject({
            namespace,
            project: at.projectId,
            sponsor,
            escalation: {
              state: "open",
              about: { kind: "conflict", id: conflictId },
              category: "ambiguous-requirement",
              default: PREMISE_HOLDS,
            },
          });
          // The agent's own words reach the person asked, beside the proof.
          expect(asked.escalation.evidence.map((evidence) => evidence.summary)).toEqual(
            expect.arrayContaining(["the two cannot both ship"]),
          );
          expect(asked.escalation.evidence.map((evidence) => evidence.class)).toContain("proof");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.resolve-escalate] a move Keel cannot make is refused and asks nobody: a change that is no party, a conflict not yet proven, a project in no namespace, an unknown conflict",
      () => {
        const harness = makeHarness();
        const proven = conflictOn();
        const suspected = conflictOn();
        const unplaced = conflictOn();
        const namespace = makeId("org", ulid());
        return Effect.gen(function* () {
          const moves = yield* ConflictMoves;
          yield* harness.place(proven.at.projectId, namespace);
          yield* harness.place(suspected.at.projectId, namespace);
          for (const each of [proven, suspected, unplaced])
            yield* harness.suspect(each.at, each.conflictId, each.suspect);
          yield* prove(proven.at, proven.conflictId);
          yield* prove(unplaced.at, unplaced.conflictId);

          const stranger = yield* Effect.flip(
            moves.resolve(proven.at, command(proven.conflictId, makeId("chg", ulid()))),
          );
          const early = yield* Effect.flip(
            moves.resolve(suspected.at, command(suspected.conflictId, suspected.holder)),
          );
          const nowhere = yield* Effect.flip(
            moves.resolve(unplaced.at, command(unplaced.conflictId, unplaced.holder)),
          );
          const missing = yield* Effect.flip(
            moves.resolve(proven.at, command(makeId("cfl", ulid()), proven.holder)),
          );
          yield* harness.settled(proven.at, namespace);
          const escalations = yield* Escalations;

          expect([stranger._tag, early._tag, nowhere._tag]).toEqual([
            "MoveRefused",
            "MoveRefused",
            "MoveRefused",
          ]);
          expect(missing._tag).toBe("ConflictNotFound");
          for (const each of [proven, suspected, unplaced]) {
            const asked = yield* Effect.flip(escalations.get(escalationIdOf(each.conflictId)));
            expect(asked._tag).toBe("EscalationNotFound");
            expect(
              escalated(yield* harness.log(each.at, { kind: "conflict", id: each.conflictId })),
            ).toEqual([]);
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.unprovable-escalates] a conflict whose probe could not be drafted is put to a person by Keel itself, once: ConflictEscalated unprovable, and its escalation in the project's namespace; in a project that belongs to none it stays open",
      () => {
        const harness = makeHarness();
        const placed = conflictOn();
        const unplaced = conflictOn();
        const namespace = makeId("org", ulid());
        const escalationId = escalationIdOf(placed.conflictId);
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.place(placed.at.projectId, namespace);
          for (const each of [placed, unplaced])
            yield* harness.suspect(each.at, each.conflictId, each.suspect);
          const first = yield* ledger.probeDraftFailed(placed.at, failed(placed.conflictId));
          const again = yield* ledger.probeDraftFailed(placed.at, failed(placed.conflictId));
          const open = yield* ledger.probeDraftFailed(unplaced.at, failed(unplaced.conflictId));
          yield* harness.settled(placed.at, namespace);
          const escalations = yield* Escalations;
          const asked = yield* escalations.get(escalationId);
          const log = yield* harness.log(placed.at, { kind: "conflict", id: placed.conflictId });

          expect(first.conflict).toMatchObject({ state: "escalated", escalationId });
          expect(again).toEqual(first);
          expect(escalated(log)).toHaveLength(1);
          expect(escalated(log)[0]?.payload).toMatchObject({ escalationId, reason: "unprovable" });
          // Keel's own move: nobody's name is on it.
          expect(escalated(log)[0]?.actor).toBeUndefined();
          expect(asked).toMatchObject({
            namespace,
            project: placed.at.projectId,
            escalation: { state: "open", category: "unprovable-conflict" },
          });
          expect(open.conflict.state).toBe("suspected");
          expect(
            (yield* Effect.flip(escalations.get(escalationIdOf(unplaced.conflictId))))._tag,
          ).toBe("EscalationNotFound");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[d22.run-failed-escalates] a conflict whose drafted probe's run failed is put to a person by Keel itself, once: ConflictEscalated unprovable, and its escalation in the project's namespace; in a project that belongs to none it stays probing",
      () => {
        const harness = makeHarness();
        const placed = conflictOn();
        const unplaced = conflictOn();
        const namespace = makeId("org", ulid());
        const escalationId = escalationIdOf(placed.conflictId);
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.place(placed.at.projectId, namespace);
          for (const each of [placed, unplaced]) {
            yield* harness.suspect(each.at, each.conflictId, each.suspect);
            yield* ledger.probeDrafted(each.at, {
              conflictId: each.conflictId,
              attempts: 1,
              bundleHash: BUNDLE,
            });
          }
          const first = yield* ledger.probeRunFailed(placed.at, placed.conflictId);
          const again = yield* ledger.probeRunFailed(placed.at, placed.conflictId);
          const open = yield* ledger.probeRunFailed(unplaced.at, unplaced.conflictId);
          yield* harness.settled(placed.at, namespace);
          const escalations = yield* Escalations;
          const asked = yield* escalations.get(escalationId);
          const log = yield* harness.log(placed.at, { kind: "conflict", id: placed.conflictId });

          expect(first.probe).toMatchObject({ state: "discarded", discarded: "run-failed" });
          expect(first.conflict).toMatchObject({ state: "escalated", escalationId });
          expect(again).toEqual(first);
          expect(escalated(log)).toHaveLength(1);
          expect(escalated(log)[0]?.payload).toMatchObject({ escalationId, reason: "unprovable" });
          expect(escalated(log)[0]?.actor).toBeUndefined();
          expect(asked).toMatchObject({
            namespace,
            project: placed.at.projectId,
            escalation: { state: "open", category: "unprovable-conflict" },
          });
          expect(open.conflict.state).toBe("probing");
          expect(
            (yield* Effect.flip(escalations.get(escalationIdOf(unplaced.conflictId))))._tag,
          ).toBe("EscalationNotFound");
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
