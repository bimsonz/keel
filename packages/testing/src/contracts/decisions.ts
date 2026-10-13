import { describe, expect, it } from "@effect/vitest";
import { DecisionId, type EventEnvelope, GuardId } from "@keeltown/core/kernel";
import { Decisions } from "@keeltown/core/ports";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { Effect, type Layer, Result, Schema } from "effect";
import { DISCRIMINATING } from "./probe-ledger.ts";
import { projectEvents } from "./project-views.ts";

/**
 * What the `Decisions` suite needs beside the port: a way to make an event
 * arrive, as a committing object's outbox delivers it to the Projector. A real
 * Projector is shared, so every case works in a project of its own.
 */
export interface DecisionsHarness {
  readonly layer: Layer.Layer<Decisions>;
  readonly arrive: (event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const id = (prefix: string) => `${prefix}_${ulid()}`;
const SUBJECT = "authz.permission-evaluation";
const subject = Schema.decodeUnknownSync(SubjectKey);
const ON_IT = subject(SUBJECT);
const ELSEWHERE = subject("billing.invoices");

/**
 * One conflict of a project from its suspicion to its ruling, as its objects
 * commit it: the conflict's own events in the Subject object's order, and the
 * ruling's decision from the namespace object, which names the conflict among
 * what it concerns. `holder` holds the premise and `other` makes the effect.
 */
export function ruledConflict(
  events: ReturnType<typeof projectEvents> = projectEvents(),
  guardId: string = id("grd"),
) {
  const [conflictId, probeId, escalationId, decisionId] = [
    id("cfl"),
    id("prb"),
    id("esc"),
    id("dec"),
  ];
  const [holder, other] = [id("chg"), id("chg")];
  /** The conflict's events up to its escalation, the guard admitted from its proof among them. */
  const conflict: readonly EventEnvelope[] = [
    events.suspected(conflictId, holder, other),
    events.probeDrafted(conflictId, probeId),
    ...[1, 2, 3].flatMap((run) =>
      DISCRIMINATING.map(([world, outcome]) =>
        events.probeRan(conflictId, probeId, world, run, outcome),
      ),
    ),
    events.guardAdmitted(conflictId, probeId, guardId),
    events.proven(conflictId, probeId),
    events.of({ kind: "conflict", id: conflictId }, {
      _tag: "ConflictEscalated",
      conflictId,
      escalationId,
      reason: "human-class",
    } as {
      _tag: string;
    }),
  ];
  const recorded = (option: "premise-holds" | "effect-stands"): EventEnvelope => ({
    ...events.of({ kind: "decision", id: decisionId }, {
      _tag: "DecisionRecorded",
      decisionId,
      escalationId,
      option,
      summary: option === "premise-holds" ? "The premise holds" : "The effect stands",
      evidence: [],
      alternatives: [],
    } as { _tag: string }),
    affected: [
      { kind: "escalation", id: escalationId },
      { kind: "conflict", id: conflictId },
    ],
  });
  const resolved = (against: readonly string[]): EventEnvelope =>
    events.of({ kind: "conflict", id: conflictId }, {
      _tag: "ConflictResolved",
      conflictId,
      move: "escalate",
      decisionId,
      against,
    } as {
      _tag: string;
    });
  /** A later decision superseding this one. */
  const superseded = (): EventEnvelope =>
    events.of({ kind: "decision", id: decisionId }, {
      _tag: "DecisionSuperseded",
      decisionId,
      by: id("dec"),
    } as { _tag: string });
  return {
    project: events.project,
    conflictId,
    guardId: GuardId.make(guardId),
    decisionId: DecisionId.make(decisionId),
    holder,
    other,
    conflict,
    recorded,
    resolved,
    superseded,
    /** The premise's proposition, which the guard asserts. */
    premise: {
      subject: SUBJECT,
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    },
    effect: { subject: SUBJECT, predicate: "freshness", relation: "is", value: "per-session" },
  };
}

export function describeDecisionsContract(adapter: string, make: () => DecisionsHarness) {
  describe(`Decisions contract: ${adapter}`, () => {
    it.live(
      "[decisions.contract] a ruling for the premise reads with its conflict, subject, what it upheld and the guard that holds it, by id, by subject and by guard, and in no other project",
      () => {
        const harness = make();
        const ruled = ruledConflict();
        const elsewhere = ruledConflict();
        return Effect.gen(function* () {
          for (const event of [
            ...ruled.conflict,
            ruled.recorded("premise-holds"),
            ruled.resolved([ruled.other]),
          ])
            yield* harness.arrive(event);
          const decisions = yield* Decisions;
          const read = yield* decisions.get(ruled.decisionId);

          expect(read).toMatchObject({
            decision: {
              id: ruled.decisionId,
              option: "premise-holds",
              summary: "The premise holds",
              state: "active",
            },
            project: ruled.project,
            conflictId: ruled.conflictId,
            subjectKey: SUBJECT,
            holds: [ruled.premise],
            against: [ruled.other],
            guards: [ruled.guardId],
          });
          expect(read.label).toMatch(/^D-[1-9]\d*$/);
          expect((yield* decisions.list({ project: ruled.project })).items).toEqual([read]);
          expect((yield* decisions.list({ project: ruled.project, subject: ON_IT })).items).toEqual(
            [read],
          );
          expect(
            (yield* decisions.list({ project: ruled.project, subject: ELSEWHERE })).items,
          ).toEqual([]);
          expect(
            yield* decisions.ofGuards(ruled.project, [ruled.guardId, GuardId.make(id("grd"))]),
          ).toEqual([{ guardId: ruled.guardId, decision: read }]);
          expect(yield* decisions.onSubjects(ruled.project, [ON_IT])).toEqual([read]);
          expect(yield* decisions.onSubjects(ruled.project, [ELSEWHERE])).toEqual([]);
          // Another project's guard, subject and list name nothing of this one.
          expect(yield* decisions.ofGuards(elsewhere.project, [ruled.guardId])).toEqual([]);
          expect(yield* decisions.onSubjects(elsewhere.project, [ON_IT])).toEqual([]);
          expect((yield* decisions.list({ project: elsewhere.project })).items).toEqual([]);
          const missing = yield* Effect.result(decisions.get(DecisionId.make(id("dec"))));
          expect(Result.isFailure(missing) && missing.failure._tag).toBe("DecisionNotFound");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] a decision heard before its conflict's resolution upholds nothing until the resolution arrives, then reads as if it had come in order",
      () => {
        const harness = make();
        const ruled = ruledConflict();
        return Effect.gen(function* () {
          const decisions = yield* Decisions;
          yield* harness.arrive(ruled.recorded("premise-holds"));
          expect(yield* decisions.get(ruled.decisionId)).toMatchObject({
            conflictId: ruled.conflictId,
            holds: [],
            guards: [],
          });
          expect(yield* decisions.ofGuards(ruled.project, [ruled.guardId])).toEqual([]);
          for (const event of ruled.conflict) yield* harness.arrive(event);
          expect((yield* decisions.get(ruled.decisionId)).holds).toEqual([]);
          yield* harness.arrive(ruled.resolved([ruled.other]));
          const read = yield* decisions.get(ruled.decisionId);

          expect(read).toMatchObject({
            subjectKey: SUBJECT,
            holds: [ruled.premise],
            against: [ruled.other],
            guards: [ruled.guardId],
          });
          expect(yield* decisions.ofGuards(ruled.project, [ruled.guardId])).toEqual([
            { guardId: ruled.guardId, decision: read },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] a ruling for the effect upholds the effect, and the guard drawn from the premise holds it not",
      () => {
        const harness = make();
        const ruled = ruledConflict();
        return Effect.gen(function* () {
          for (const event of [
            ...ruled.conflict,
            ruled.recorded("effect-stands"),
            ruled.resolved([ruled.holder]),
          ])
            yield* harness.arrive(event);
          const decisions = yield* Decisions;

          expect(yield* decisions.get(ruled.decisionId)).toMatchObject({
            holds: [ruled.effect],
            against: [ruled.holder],
            guards: [],
          });
          expect(yield* decisions.ofGuards(ruled.project, [ruled.guardId])).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] a project's decisions list newest first, a page at a time",
      () => {
        const harness = make();
        // One builder, so the three rulings are recorded in turn on one clock.
        const events = projectEvents();
        const project = events.project;
        const [first, second, third] = [
          ruledConflict(events),
          ruledConflict(events),
          ruledConflict(events),
        ];
        return Effect.gen(function* () {
          for (const ruled of [first, second, third])
            for (const event of [
              ...ruled.conflict,
              ruled.recorded("premise-holds"),
              ruled.resolved([ruled.other]),
            ])
              yield* harness.arrive(event);
          const decisions = yield* Decisions;
          const page = yield* decisions.list({ project, limit: 2 });
          const rest = yield* decisions.list({
            project,
            limit: 2,
            cursor: page.nextCursor,
          });

          expect(page.items.map((d) => d.decision.id)).toEqual([
            third.decisionId,
            second.decisionId,
          ]);
          expect(page.nextCursor).toBe(second.decisionId);
          expect(rest.items.map((d) => d.decision.id)).toEqual([first.decisionId]);
          expect(rest.nextCursor).toBeUndefined();
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
