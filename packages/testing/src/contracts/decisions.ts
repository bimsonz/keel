import { describe, expect, it } from "@effect/vitest";
import { DecisionId, type EventEnvelope, GuardId, type ProjectId } from "@keeltown/core/kernel";
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
 * what it concerns. `holder` holds the premise and `other` makes the effect:
 * new changes, unless `parties` names them.
 */
export function ruledConflict(
  events: ReturnType<typeof projectEvents> = projectEvents(),
  guardId: string = id("grd"),
  subjectKey: string = SUBJECT,
  parties: { readonly holder?: string; readonly other?: string } = {},
) {
  const [conflictId, probeId, escalationId, decisionId] = [
    id("cfl"),
    id("prb"),
    id("esc"),
    id("dec"),
  ];
  const [holder, other] = [parties.holder ?? id("chg"), parties.other ?? id("chg")];
  const subjectId = id("sub");
  /** The conflict's events up to its escalation, the guard admitted from its proof among them. */
  const conflict: readonly EventEnvelope[] = [
    events.suspected(conflictId, holder, other, undefined, subjectKey),
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
  /** The conflict's subject minted with an anchor in each of these files, as its Subject object commits it. */
  const minted = (paths: readonly string[]): EventEnvelope =>
    events.of({ kind: "subject", id: subjectId }, {
      _tag: "SubjectMinted",
      subjectId,
      key: subjectKey,
      anchors: paths.map((path) => ({ path, commit: "c".repeat(40) })),
      gloss: subjectKey,
      mintedBy: "agent",
    } as { _tag: string });
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
    minted,
    subjectKey: subject(subjectKey),
    /** The premise's proposition, which the guard asserts. */
    premise: {
      subject: subjectKey,
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    },
    effect: { subject: subjectKey, predicate: "freshness", relation: "is", value: "per-session" },
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
      "[decisions.contract] a decision is read by a file its subject is anchored in, the anchors heard before it, and by no other file or project",
      () => {
        const harness = make();
        const ruled = ruledConflict();
        const elsewhere = ruledConflict();
        return Effect.gen(function* () {
          for (const event of [
            ruled.minted(["src/authz/check.ts", "src/authz/cache.ts"]),
            ...ruled.conflict,
            ruled.recorded("premise-holds"),
            ruled.resolved([ruled.other]),
            // Another project rules on the same subject and anchors it nowhere.
            ...elsewhere.conflict,
            elsewhere.recorded("premise-holds"),
            elsewhere.resolved([elsewhere.other]),
          ])
            yield* harness.arrive(event);
          const decisions = yield* Decisions;
          const read = yield* decisions.get(ruled.decisionId);

          expect(yield* decisions.atPath(ruled.project, "src/authz/check.ts")).toEqual([read]);
          expect(yield* decisions.atPath(ruled.project, "src/authz/cache.ts")).toEqual([read]);
          expect(yield* decisions.atPath(ruled.project, "src/authz")).toEqual([]);
          expect(yield* decisions.atPath(ruled.project, "src/billing.ts")).toEqual([]);
          expect(yield* decisions.atPath(elsewhere.project, "src/authz/check.ts")).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] anchors heard after the decisions read the same, and every subject anchored in a file answers, newest first",
      () => {
        const harness = make();
        const events = projectEvents();
        const first = ruledConflict(events);
        const second = ruledConflict(events, id("grd"), "billing.invoices");
        return Effect.gen(function* () {
          for (const ruled of [first, second])
            for (const event of [
              ...ruled.conflict,
              ruled.recorded("premise-holds"),
              ruled.resolved([ruled.other]),
            ])
              yield* harness.arrive(event);
          const decisions = yield* Decisions;
          expect(yield* decisions.atPath(events.project, "src/shared.ts")).toEqual([]);
          yield* harness.arrive(first.minted(["src/shared.ts"]));
          yield* harness.arrive(second.minted(["src/shared.ts", "src/billing.ts"]));
          const [older, newer] = [
            yield* decisions.get(first.decisionId),
            yield* decisions.get(second.decisionId),
          ];

          expect(yield* decisions.atPath(events.project, "src/shared.ts")).toEqual([newer, older]);
          expect(yield* decisions.atPath(events.project, "src/billing.ts")).toEqual([newer]);
          // Read by path as by its subjects.
          expect(yield* decisions.atPath(events.project, "src/shared.ts")).toEqual(
            yield* decisions.onSubjects(events.project, [first.subjectKey, second.subjectKey]),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] explaining reads a subject's active decisions, or a file's, newest first, each with its conflict and the changes it names as folded, landed when their ChangeLanded says, and nothing of another project",
      () => {
        const harness = make();
        const events = projectEvents();
        const theirs = projectEvents();
        const [ended, older, newer] = [
          ruledConflict(events),
          ruledConflict(events),
          ruledConflict(events),
        ];
        const elsewhere = ruledConflict(theirs);
        const landing = events.landing(older.holder, "e".repeat(40));
        const landed = landing.at(-1);
        return Effect.gen(function* () {
          for (const ruled of [ended, older, newer, elsewhere])
            for (const event of [
              ...ruled.conflict,
              ruled.recorded("premise-holds"),
              ruled.resolved([ruled.other]),
            ])
              yield* harness.arrive(event);
          for (const event of [
            ended.superseded(),
            older.minted(["src/authz/check.ts"]),
            events.declared(older.holder, id("agt"), "Check permissions on every request"),
            events.declared(older.other, id("agt"), "Cache sessions for an hour"),
            events.started(older.holder),
            events.started(older.other),
            ...landing,
            // A conflict noted on the change after it landed arrives last, and is not when it landed.
            events.of({ kind: "change", id: older.holder }, {
              _tag: "ConflictNoted",
              changeId: older.holder,
              conflictId: older.conflictId,
              predicate: "freshness",
              policy: "annotate",
            } as { _tag: string }),
            // Another project's feed declares a change this project's conflict names.
            theirs.declared(newer.holder, id("agt"), "Another project's change"),
          ])
            yield* harness.arrive(event);
          const decisions = yield* Decisions;
          const bySubject = yield* decisions.explaining(events.project, {
            kind: "subject",
            subject: ON_IT,
          });

          expect(bySubject.map((source) => source.decision)).toEqual([
            yield* decisions.get(newer.decisionId),
            yield* decisions.get(older.decisionId),
          ]);
          const [ofNewer, ofOlder] = bySubject;
          expect(ofOlder?.conflict).toMatchObject({
            conflict: {
              id: older.conflictId,
              parties: [older.holder, older.other],
              decisionId: older.decisionId,
            },
            labels: { conflict: expect.stringMatching(/^C-[1-9]\d*$/) },
          });
          expect(
            ofOlder?.changes.map((view) => [view.change.id, view.change.state, view.landedAt]),
          ).toEqual([
            [older.holder, "landed", landed?.at],
            [older.other, "working", undefined],
          ]);
          expect(ofOlder?.changes[0]?.change.landedCommit).toBe("e".repeat(40));
          expect(ofNewer?.conflict?.conflict.id).toBe(newer.conflictId);
          expect(ofNewer?.changes).toEqual([]);
          // By a file the subject is anchored in, the same; by any other, nothing.
          expect(
            yield* decisions.explaining(events.project, {
              kind: "path",
              path: "src/authz/check.ts",
              line: 3,
            }),
          ).toEqual(bySubject);
          expect(
            yield* decisions.explaining(events.project, { kind: "path", path: "src/billing.ts" }),
          ).toEqual([]);
          expect(
            (yield* decisions.explaining(theirs.project, { kind: "subject", subject: ON_IT })).map(
              (source) => [source.decision.decision.id, source.changes],
            ),
          ).toEqual([[elsewhere.decisionId, []]]);
          expect(
            yield* decisions.explaining(theirs.project, {
              kind: "path",
              path: "src/authz/check.ts",
            }),
          ).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[decisions.contract] landedOn reads the changes that landed on a path most recently, newest first, as folded, under the paths their last derivation touched, and nothing of another project",
      () => {
        const harness = make();
        const events = projectEvents();
        const theirs = projectEvents();
        const [first, second, elsewhere] = [`chg_${ulid()}`, `chg_${ulid()}`, `chg_${ulid()}`];
        const firstLanding = events.landing(first, "a".repeat(40), ["src/a.ts"]);
        const secondLanding = events.landing(second, "b".repeat(40), ["src/a.ts", "src/b.ts"]);
        return Effect.gen(function* () {
          for (const event of [
            events.declared(first, `agt_${ulid()}`, "Rewrite a"),
            events.started(first),
            ...firstLanding,
            events.declared(second, `agt_${ulid()}`, "Rewrite a and b"),
            events.started(second),
            ...secondLanding,
            theirs.declared(elsewhere, `agt_${ulid()}`, "Rewrite their a"),
            theirs.started(elsewhere),
            ...theirs.landing(elsewhere, "c".repeat(40), ["src/a.ts"]),
          ])
            yield* harness.arrive(event);
          const decisions = yield* Decisions;
          const read = (project: ProjectId, path: string) =>
            Effect.map(decisions.landedOn(project, path), (views) =>
              views.map((view) => [view.change.id, view.change.landedCommit, view.landedAt]),
            );
          expect(yield* read(events.project, "src/a.ts")).toEqual([
            [second, "b".repeat(40), secondLanding.at(-1)?.at],
            [first, "a".repeat(40), firstLanding.at(-1)?.at],
          ]);
          expect(yield* read(events.project, "src/b.ts")).toEqual([
            [second, "b".repeat(40), secondLanding.at(-1)?.at],
          ]);
          expect(yield* read(events.project, "src/none.ts")).toEqual([]);
          expect((yield* read(theirs.project, "src/a.ts")).map(([changeId]) => changeId)).toEqual([
            elsewhere,
          ]);
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
