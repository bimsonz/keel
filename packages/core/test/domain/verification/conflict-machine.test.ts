import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { compare } from "../../../src/domain/coordination/index.ts";
import { Instant } from "../../../src/domain/kernel/index.ts";
import {
  admit,
  type ConflictCommand,
  ConflictEvent,
  type ProbeCommand,
  replayConflict,
} from "../../../src/domain/verification/index.ts";
import { conflictChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import type { Fold } from "../../support/machine.ts";
import {
  BATCH,
  BUNDLE,
  CHANGE_A,
  CHANGE_B,
  comparableConflict,
  conflictLog,
  conflictOracle,
  CONFLICT,
  EFFECTS,
  ESCALATION,
  eventsIn,
  GUARD,
  type Ledger,
  type LedgerCommand,
  type LedgerEvent,
  ledgerMachine,
  ledgerTour,
  planArb,
  PREMISE,
  type Record_,
  run,
  SUBJECT,
  T0,
  TENET,
  throughTheWire,
  WORLDS,
} from "./ledger.ts";

const PROPERTY_TIMEOUT = 60_000;

/** Every conflict command a step took or tried. */
const conflictTries = (r: Record_) =>
  [r.taken, ...r.probes].flatMap((p) =>
    p.command._tag === "Conflict" ? [{ ...p, command: p.command.command }] : [],
  );

const C = (command: ConflictCommand): LedgerCommand => ({ _tag: "Conflict", command });
const P = (command: ProbeCommand): LedgerCommand => ({ _tag: "Probe", command });

/** Plays commands from nothing the way the DO would, keeping every result and the final pair. */
const drive = (commands: readonly LedgerCommand[]) => {
  let state: Ledger | undefined;
  const results = commands.map((command, i) => {
    const now = Instant(T0 + i + 1);
    const result = ledgerMachine.decide(state, command, { now });
    if (Result.isSuccess(result))
      state = result.success.reduce<Ledger | undefined>(
        (s, payload) => ledgerMachine.evolve(s, { at: now, payload }),
        state,
      );
    return result;
  });
  return { state, results };
};

const failureReason = (r: ReturnType<typeof ledgerMachine.decide> | undefined): unknown =>
  r !== undefined && Result.isFailure(r) && "reason" in r.failure ? r.failure.reason : r?._tag;

const suspectSemantic = {
  _tag: "Suspect",
  kind: "semantic",
  parties: [CHANGE_A, TENET],
  subjectId: SUBJECT,
  predicate: "freshness",
} as const satisfies ConflictCommand;
const draft = P({ _tag: "Draft", conflictId: CONFLICT, attempts: 1, bundleHash: BUNDLE });
const outcomesFor = { trunk: "pass", A: "pass", B: "n/a", AB: "fail", "A-noop": "fail" } as const;
/** Every cell of the S-1 matrix for runs 1..n, with one world's answer replaced on one run. */
const cells = (
  runs: number,
  spoil?: {
    readonly run: number;
    readonly world: keyof typeof outcomesFor;
    readonly outcome: "pass" | "fail" | "n/a";
  },
): LedgerCommand[] =>
  Array.from({ length: runs }, (_, i) => i + 1).flatMap((runNo) =>
    WORLDS.map((world) =>
      P({
        _tag: "Record",
        world,
        run: runNo,
        outcome:
          spoil !== undefined && spoil.run === runNo && spoil.world === world
            ? spoil.outcome
            : outcomesFor[world],
        resultRef: `r2://${runNo}/${world}`,
        guardId: GUARD,
      }),
    ),
  );
const settle = C({ _tag: "Settle", escalationId: ESCALATION });

/** Proven or dismissed only on proof or a ruling: what each such event rests on must be in the state it was decided from. */
const justified = (
  before: Ledger | undefined,
  command: ConflictCommand,
  events: readonly LedgerEvent[],
) =>
  events.every((e) => {
    if (e._tag === "ConflictProven") {
      const proof = e.evidence;
      if (proof._tag !== "probe") return true;
      const probe = before?.probe;
      return (
        probe?.id === proof.probeId &&
        probe.state === "admitted" &&
        admit(probe.cells)._tag === "admitted"
      );
    }
    if (e._tag !== "ConflictDismissed") return true;
    if (command._tag === "Dismiss") {
      const { outcome } = compare(command.premise, command.effect);
      return (
        before?.conflict?.origin !== "opinion" &&
        (outcome === "compatible" || outcome === "refines")
      );
    }
    return before?.probe?.state === "discarded" && before.probe.discarded === "non-discriminating";
  });

/** The S-1 premise, suspected, then dismissed against the i-th effect. */
const dismiss = (i: number) =>
  drive([
    C(suspectSemantic),
    C({ _tag: "Dismiss", premise: PREMISE, effect: EFFECTS[i] ?? PREMISE }),
  ]);

describe("the Conflict machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[conflict.transitions] in every state a run reaches, every conflict command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => {
            const expected = conflictOracle(r.before, p.command);
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) &&
                  !p.threw &&
                  (p.after?.conflict?.state ?? "none") === expected;
          }),
        ),
      ),
    );
    // S-1 end to end: suspected, a probe drafted, three discriminating runs, proven, resolved.
    const s1 = drive([
      C(suspectSemantic),
      draft,
      ...cells(3),
      settle,
      C({ _tag: "Resolve", move: "sequence" }),
    ]);
    expect(s1.state?.conflict?.state).toBe("resolved");
    // A lattice ruling dismisses only a conflict still Suspected, never one being probed.
    const probing = drive([
      C(suspectSemantic),
      draft,
      C({ _tag: "Dismiss", premise: PREMISE, effect: EFFECTS[0] ?? PREMISE }),
    ]);
    expect(Result.isFailure(probing.results[2] ?? Result.succeed([]))).toBe(true);
    expect(probing.state?.conflict?.state).toBe("probing");
  });

  it("[conflict.one-terminal] a resolved or dismissed conflict takes no command, and a conflict ends at most once", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => {
          const ended =
            r.before?.conflict?.state === "resolved" || r.before?.conflict?.state === "dismissed";
          const endings = conflictLog(r.log).filter(
            (c) => c.payload._tag === "ConflictResolved" || c.payload._tag === "ConflictDismissed",
          ).length;
          return (
            endings <= 1 && (!ended || conflictTries(r).every((p) => Result.isFailure(p.result)))
          );
        }),
      ),
    );
    const resolved = drive([
      C({ _tag: "Suspect", kind: "textual", parties: [CHANGE_A, CHANGE_B] }),
      C({ _tag: "Prove", evidence: { _tag: "merge-refused", batchId: BATCH } }),
      C({ _tag: "Resolve", move: "sequence" }),
      C({ _tag: "Resolve", move: "sequence" }),
    ]);
    expect(resolved.state?.conflict?.state).toBe("resolved");
    expect(Result.isFailure(resolved.results[3] ?? Result.succeed([]))).toBe(true);
  });

  it("[conflict.replay] at every step, the conflict's events so far, through the wire, replay to the same conflict", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            comparableConflict(
              replayConflict(throughTheWire(ConflictEvent, conflictLog(r.log))),
            ) === comparableConflict(r.after?.conflict),
        ),
      ),
    );
    const s1 = drive([C(suspectSemantic), draft, ...cells(1)]);
    expect(s1.state?.conflict?.probeId).toBeDefined();
  });

  it("[conflict.decide-evolvable] evolve takes every event decide emits, for every conflict command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => conflictTries(r).every((p) => !p.threw)),
      ),
    );
    const escalated = drive([
      C(suspectSemantic),
      C({ _tag: "Suspect", kind: "semantic", parties: [] }),
      P({ _tag: "DraftFailed", conflictId: CONFLICT }),
      settle,
      C({ _tag: "Escalate", escalationId: ESCALATION }),
    ]);
    expect(escalated.state?.conflict?.state).toBe("escalated");
    expect(Result.isFailure(escalated.results[4] ?? Result.succeed([]))).toBe(true);
  });

  it("[conflict.proof-or-ruling] only proof or a ruling proves or dismisses: the kind's own proof, an admitted probe, a lattice ruling over derived facts, or a probe that never discriminates", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => justified(r.before, p.command, eventsIn(p.result))),
        ),
      ),
    );
    // A probe still calibrating proves nothing, however good its runs so far.
    const pending = drive([C(suspectSemantic), draft, ...cells(2), settle]);
    expect(failureReason(pending.results.at(-1))).toBe("probe-pending");
    // One run that does not discriminate makes the probe unstable: the conflict escalates, it is neither proven nor dismissed.
    const unstable = drive([
      C(suspectSemantic),
      draft,
      ...cells(2, { run: 2, world: "A-noop", outcome: "pass" }),
      settle,
    ]);
    expect(unstable.state?.conflict?.state).toBe("escalated");
    // A probe that passes against the do-nothing mutant every time dismisses the alarm.
    const vacuous = drive([
      C(suspectSemantic),
      draft,
      ...cells(1, { run: 1, world: "A-noop", outcome: "pass" }),
      settle,
    ]);
    expect(vacuous.state?.conflict?.state).toBe("dismissed");
    // A decision model's suspicion is opinion: comparing over it is tainted, so it is not a ruling.
    const opinion = drive([
      C({ ...suspectSemantic, origin: "opinion" }),
      C({ _tag: "Dismiss", premise: PREMISE, effect: EFFECTS[0] ?? PREMISE }),
    ]);
    expect(failureReason(opinion.results[1])).toBe("opinion-is-not-a-ruling");
  });

  it("[conflict.dismiss-by-lattice] a suspected conflict is dismissed by a lattice comparison exactly when the effect is compatible with the premise or refines it", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => {
            const conflict = r.before?.conflict;
            if (
              p.command._tag !== "Dismiss" ||
              conflict?.state !== "suspected" ||
              conflict.origin === "opinion" ||
              conflict.subjectId === undefined
            )
              return true;
            const { outcome } = compare(p.command.premise, p.command.effect);
            return (
              Result.isSuccess(p.result) === (outcome === "compatible" || outcome === "refines")
            );
          }),
        ),
      ),
    );
    // B caches per session: the lattice contradicts the premise, so only a probe can settle it.
    expect(failureReason(dismiss(1).results[1])).toBe("lattice:contradicts");
    expect(failureReason(dismiss(2).results[1])).toBe("lattice:needs-probe");
    expect(dismiss(0).state?.conflict?.state).toBe("dismissed");
    expect(dismiss(3).state?.conflict?.state).toBe("dismissed");
  });
  it("[conflict.world-checks] a suite's cell is recorded only while the conflict is Probing, leaves its state, and a cell never changes its answer", () => {
    let recorded = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => {
            if (p.command._tag !== "RecordCheck") return true;
            const events = Result.isSuccess(p.result) ? p.result.success : [];
            if (events.length > 0) recorded++;
            const before = r.before?.conflict;
            return (
              (before?.state === "probing" || Result.isFailure(p.result)) &&
              events.every((e) => e._tag === "WorldCheckRan") &&
              (p.after?.conflict?.state ?? "none") === (before?.state ?? "none")
            );
          }),
        ),
      ),
    );
    expect(recorded).toBeGreaterThan(0);
    const check = (outcome: "pass" | "fail" | "n/a", reason?: string): LedgerCommand =>
      C({
        _tag: "RecordCheck",
        world: "AB",
        check: `suite:${CHANGE_A}`,
        run: 1,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });
    const early = drive([C(suspectSemantic), check("pass")]);
    expect(early.results.at(-1)?._tag).toBe("Failure");
    const played = drive([
      C(suspectSemantic),
      draft,
      check("fail"),
      check("fail"),
      check("pass"),
      check("n/a"),
    ]);
    expect(
      played.results.map((x) => (Result.isSuccess(x) ? x.success.length : failureReason(x))),
    ).toEqual([1, 1, 1, 0, "cell-recorded", "malformed-check"]);
    expect(played.state?.conflict).toMatchObject({
      state: "probing",
      checks: [{ world: "AB", run: 1, outcome: "fail" }],
    });
  });
});

const conflictView: View<Ledger, LedgerEvent> = {
  from: (f) => f.before?.conflict?.state ?? "none",
  to: (f) => f.after.conflict?.state ?? "none",
};

describe("the Conflict chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[conflict.chart] every state change a run makes is an edge of the Conflict chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            offChart(
              conflictChart,
              foldsOf(
                ledgerMachine,
                r.before,
                [r.taken.result, ...r.probes.map((p) => p.result)],
                r.now,
              ),
              conflictView,
            ).length === 0,
        ),
      ),
    );
    const walked: readonly Fold<Ledger, LedgerEvent>[] = ledgerTour();
    expect(offChart(conflictChart, walked, conflictView)).toEqual([]);
    expect(uncovered(conflictChart, walked, conflictView)).toEqual([]);
  });
});
