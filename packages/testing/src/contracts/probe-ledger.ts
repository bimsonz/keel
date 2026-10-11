import { describe, expect, it } from "@effect/vitest";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { ConflictCommand, ProbeOutcome, World } from "@keeltown/core/domain/verification";
import {
  type ConflictId,
  ContentHash,
  type EntityRef,
  type EventEnvelope,
  makeId,
  type ProbeId,
} from "@keeltown/core/kernel";
import { type ConflictView, ProbeLedger, type SubjectRef } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * The `ProbeLedger` suite opens a conflict on a subject through `suspect`, as
 * its fallout does, and reads an entity's committed events through `log`.
 */
export interface ProbeLedgerHarness {
  readonly layer: Layer.Layer<ProbeLedger>;
  readonly suspect: (
    at: SubjectRef,
    conflictId: ConflictId,
    suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
  ) => Effect.Effect<ConflictView, unknown>;
  readonly log: (at: SubjectRef, entity: EntityRef) => Effect.Effect<readonly EventEnvelope[]>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const BUNDLE = ContentHash.make(`sha256:${"a".repeat(64)}`);
const OTHER_BUNDLE = ContentHash.make(`sha256:${"b".repeat(64)}`);

/** One discriminating run: passes on trunk and in the premise holder's world, fails combined and against the do-nothing mutant. */
const DISCRIMINATING: readonly (readonly [World, ProbeOutcome])[] = [
  ["trunk", "pass"],
  ["A", "pass"],
  ["B", "n/a"],
  ["AB", "fail"],
  ["A-noop", "fail"],
];

/** A suspected semantic conflict between two changes on a fresh subject. */
function conflictOn() {
  const at: SubjectRef = {
    projectId: makeId("prj", ulid()),
    key: Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation"),
  };
  const conflictId = makeId("cfl", ulid());
  const [holder, other] = [makeId("chg", ulid()), makeId("chg", ulid())];
  const suspect: Extract<ConflictCommand, { _tag: "Suspect" }> = {
    _tag: "Suspect",
    kind: "semantic",
    parties: [holder, other],
    subjectId: makeId("sub", ulid()),
    predicate: "freshness",
    origin: "fallout",
    premise: {
      holder,
      proposition: {
        subject: at.key,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
      },
    },
    effect: {
      changeId: other,
      proposition: {
        subject: at.key,
        predicate: "freshness",
        relation: "is",
        value: "per-session",
      },
    },
  };
  return { at, conflictId, holder, suspect };
}

const types = (log: readonly EventEnvelope[]) => log.map((event) => event.type);

export function describeProbeLedgerContract(
  name: string,
  makeHarness: () => ProbeLedgerHarness,
): void {
  describe(`ProbeLedger contract: ${name}`, () => {
    it.effect(
      "[b21.probe-draft] a draft starts the suspected conflict probing; a repeat answers the same and commits nothing, another bundle is refused",
      () => {
        const harness = makeHarness();
        const { at, conflictId, suspect } = conflictOn();
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.suspect(at, conflictId, suspect);
          const drafted = yield* ledger.probeDrafted(at, {
            conflictId,
            attempts: 1,
            bundleHash: BUNDLE,
          });
          const again = yield* ledger.probeDrafted(at, {
            conflictId,
            attempts: 1,
            bundleHash: BUNDLE,
          });
          const other = yield* Effect.flip(
            ledger.probeDrafted(at, { conflictId, attempts: 2, bundleHash: OTHER_BUNDLE }),
          );
          const missing = yield* Effect.flip(
            ledger.probeDrafted(at, {
              conflictId: makeId("cfl", ulid()),
              attempts: 1,
              bundleHash: BUNDLE,
            }),
          );
          const probeId = drafted.probe?.id;
          if (probeId === undefined) throw new Error("the draft answers its probe");

          expect(drafted.conflict).toMatchObject({ state: "probing", probeId });
          expect(drafted.probe).toMatchObject({ state: "calibrating", bundleHash: BUNDLE });
          expect(again).toEqual(drafted);
          expect(other._tag).toBe("IdempotencyConflict");
          expect(missing._tag).toBe("ConflictNotFound");
          expect(types(yield* harness.log(at, { kind: "probe", id: probeId }))).toEqual([
            "ProbeDrafted",
          ]);
          expect(yield* ledger.conflict(at, conflictId)).toEqual(drafted);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[b21.probe-cells] three discriminating runs admit the probe as a guard; a repeated cell commits nothing, a contradicting one and another probe's are refused",
      () => {
        const harness = makeHarness();
        const { at, conflictId, suspect } = conflictOn();
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.suspect(at, conflictId, suspect);
          const drafted = yield* ledger.probeDrafted(at, {
            conflictId,
            attempts: 1,
            bundleHash: BUNDLE,
          });
          const probeId: ProbeId | undefined = drafted.probe?.id;
          if (probeId === undefined) throw new Error("the draft answers its probe");
          const cell = (run: number, world: World, outcome: ProbeOutcome) =>
            ledger.probeCellRan(at, {
              conflictId,
              probeId,
              world,
              run,
              outcome,
              resultRef: `r2://probe/${run}/${world}`,
            });

          for (const [world, outcome] of DISCRIMINATING) yield* cell(1, world, outcome);
          yield* cell(1, "AB", "fail");
          const contradicting = yield* Effect.flip(cell(1, "AB", "pass"));
          const foreign = yield* Effect.flip(
            ledger.probeCellRan(at, {
              conflictId,
              probeId: makeId("prb", ulid()),
              world: "A",
              run: 2,
              outcome: "pass",
              resultRef: "r2://probe/foreign",
            }),
          );
          for (const run of [2, 3])
            for (const [world, outcome] of DISCRIMINATING) yield* cell(run, world, outcome);
          const view = yield* ledger.conflict(at, conflictId);
          const log = types(yield* harness.log(at, { kind: "probe", id: probeId }));

          expect(contradicting).toMatchObject({
            _tag: "ProbeStateRefused",
            reason: "cell-contradicts",
          });
          expect(foreign._tag).toBe("ProbeNotFound");
          expect(view.probe).toMatchObject({ state: "admitted" });
          expect(view.probe?.cells).toHaveLength(3 * DISCRIMINATING.length);
          expect(log.filter((type) => type === "ProbeRan")).toHaveLength(3 * DISCRIMINATING.length);
          expect(log.filter((type) => type === "GuardAdmitted")).toHaveLength(1);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[b21.world-check] a party's suite check is recorded only while the conflict probes, once, and an n/a without a reason is refused",
      () => {
        const harness = makeHarness();
        const { at, conflictId, holder, suspect } = conflictOn();
        const check = `suite:${holder}`;
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.suspect(at, conflictId, suspect);
          const early = yield* Effect.flip(
            ledger.worldCheckRan(at, { conflictId, world: "A", check, run: 1, outcome: "pass" }),
          );
          yield* ledger.probeDrafted(at, { conflictId, attempts: 1, bundleHash: BUNDLE });
          const recorded = yield* ledger.worldCheckRan(at, {
            conflictId,
            world: "A",
            check,
            run: 1,
            outcome: "pass",
            counts: { passed: 12, failed: 0, skipped: 1 },
          });
          yield* ledger.worldCheckRan(at, {
            conflictId,
            world: "A",
            check,
            run: 1,
            outcome: "pass",
            counts: { passed: 12, failed: 0, skipped: 1 },
          });
          const unexplained = yield* Effect.flip(
            ledger.worldCheckRan(at, { conflictId, world: "B", check, run: 1, outcome: "n/a" }),
          );
          const log = types(yield* harness.log(at, { kind: "conflict", id: conflictId }));

          expect(early._tag).toBe("ConflictStateRefused");
          expect(recorded.conflict.checks).toEqual([
            { world: "A", check, run: 1, outcome: "pass" },
          ]);
          expect(unexplained).toMatchObject({
            _tag: "ConflictStateRefused",
            reason: "malformed-check",
          });
          expect(log.filter((type) => type === "WorldCheckRan")).toHaveLength(1);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[b21.draft-failed] drafting that ends without a probe discards it as draft-failed, once per conflict, and a later draft is refused",
      () => {
        const harness = makeHarness();
        const { at, conflictId, suspect } = conflictOn();
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          yield* harness.suspect(at, conflictId, suspect);
          const failed = yield* ledger.probeDraftFailed(at, {
            conflictId,
            attempts: 3,
            reason: "repairs-exhausted",
          });
          const again = yield* ledger.probeDraftFailed(at, {
            conflictId,
            attempts: 3,
            reason: "repairs-exhausted",
          });
          const late = yield* Effect.flip(
            ledger.probeDrafted(at, { conflictId, attempts: 1, bundleHash: BUNDLE }),
          );
          const probeId = failed.probe?.id;
          if (probeId === undefined) throw new Error("a failed draft answers its probe");

          expect(failed.probe).toMatchObject({ state: "discarded", discarded: "draft-failed" });
          expect(failed.conflict.state).toBe("suspected");
          expect(types(yield* harness.log(at, { kind: "conflict", id: conflictId }))).toEqual([
            "ConflictSuspected",
          ]);
          expect(again).toEqual(failed);
          expect(late._tag).toBe("ProbeStateRefused");
          expect(yield* ledger.conflict(at, conflictId)).toEqual(failed);
          expect(types(yield* harness.log(at, { kind: "probe", id: probeId }))).toEqual([
            "ProbeDiscarded",
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[b21.settle] an admitted probe proves its conflict, on the conflict's own entity and once, a probe that never discriminates dismisses it, and an unprovable one leaves it open with no escalation minted",
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const ledger = yield* ProbeLedger;
          /** A suspected conflict, drafted, with `runs` of cells recorded; answers it as it then stands and its log. */
          const settled = (runs: readonly (readonly (readonly [World, ProbeOutcome])[])[]) =>
            Effect.gen(function* () {
              const { at, conflictId, suspect } = conflictOn();
              yield* harness.suspect(at, conflictId, suspect);
              const drafted = yield* ledger.probeDrafted(at, {
                conflictId,
                attempts: 1,
                bundleHash: BUNDLE,
              });
              const probeId: ProbeId | undefined = drafted.probe?.id;
              if (probeId === undefined) throw new Error("the draft answers its probe");
              const cell = (run: number, world: World, outcome: ProbeOutcome) =>
                ledger.probeCellRan(at, {
                  conflictId,
                  probeId,
                  world,
                  run,
                  outcome,
                  resultRef: `r2://probe/${run}/${world}`,
                });
              for (const [index, cells] of runs.entries())
                for (const [world, outcome] of cells) yield* cell(index + 1, world, outcome);
              // The deciding cell again: a replay commits nothing, so nothing settles twice.
              const last = runs.at(-1)?.at(-1);
              if (last !== undefined) yield* cell(runs.length, last[0], last[1]);
              return {
                view: yield* ledger.conflict(at, conflictId),
                conflictLog: yield* harness.log(at, { kind: "conflict", id: conflictId }),
                probeLog: types(yield* harness.log(at, { kind: "probe", id: probeId })),
                probeId,
              };
            });
          const blind: readonly (readonly [World, ProbeOutcome])[] = [
            ["trunk", "pass"],
            ["A", "pass"],
            ["AB", "fail"],
            ["A-noop", "pass"],
          ];

          const proven = yield* settled([DISCRIMINATING, DISCRIMINATING, DISCRIMINATING]);
          expect(proven.view.conflict.state).toBe("proven");
          expect(types(proven.conflictLog)).toEqual(["ConflictSuspected", "ConflictProven"]);
          expect(proven.conflictLog.at(-1)?.payload).toMatchObject({
            evidence: { _tag: "probe", probeId: proven.probeId },
          });
          expect(proven.probeLog.filter((type) => type.startsWith("Conflict"))).toEqual([]);

          const dismissed = yield* settled([blind]);
          expect(dismissed.view.probe).toMatchObject({ discarded: "non-discriminating" });
          expect(dismissed.view.conflict.state).toBe("dismissed");
          expect(types(dismissed.conflictLog)).toEqual(["ConflictSuspected", "ConflictDismissed"]);

          const unstable = yield* settled([DISCRIMINATING, blind]);
          expect(unstable.view.probe).toMatchObject({ discarded: "unstable" });
          expect(unstable.view.conflict).toMatchObject({ state: "probing" });
          expect(unstable.view.conflict.escalationId).toBeUndefined();
          expect(types(unstable.conflictLog)).toEqual(["ConflictSuspected"]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
