import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { compare, SubjectKey } from "../../../src/domain/coordination/index.ts";
import { Instant, makeId } from "../../../src/domain/kernel/index.ts";
import {
  admit,
  type Conflict,
  type ConflictCommand,
  ConflictEvent,
  type ConflictKind,
  decideConflict,
  evolveConflict,
  type ProbeCommand,
  replayConflict,
  sidesAgainst,
} from "../../../src/domain/verification/index.ts";
import { conflictChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
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
  DECISION,
  EFFECTS,
  ESCALATION,
  eventsIn,
  foldsIntoConflict,
  GUARD,
  type Ledger,
  type LedgerCommand,
  type LedgerEvent,
  ledgerMachine,
  ledgerTour,
  planArb,
  PREMISE,
  PROBE,
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
  premise: { holder: CHANGE_A, proposition: PREMISE },
  effect: { changeId: CHANGE_B, proposition: EFFECTS[0] ?? PREMISE },
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
/** One cell of A's suite in the combined world, run 1. */
const check = (outcome: "pass" | "fail" | "n/a", reason?: string): LedgerCommand =>
  C({
    _tag: "RecordCheck",
    world: "AB",
    check: `suite:${CHANGE_A}`,
    run: 1,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });
/** How many events each decision committed, or why it was refused. */
const tally = (results: ReturnType<typeof drive>["results"]) =>
  results.map((x) => (Result.isSuccess(x) ? x.success.length : failureReason(x)));
/** A probe drafted and decided by `decided`, then one cell recorded, repeated, contradicted and left unexplained. */
const lateCells = (decided: readonly LedgerCommand[]) => {
  const played = drive([
    C(suspectSemantic),
    draft,
    ...decided,
    check("fail"),
    check("fail"),
    check("pass"),
    check("n/a"),
  ]);
  return { conflict: played.state?.conflict, last: tally(played.results).slice(-4) };
};
/** What a late cell does on a decided conflict: recorded once, never changed, never malformed. */
const LATE = [1, 0, "cell-recorded", "malformed-check"];
const CELL = { world: "AB", run: 1, outcome: "fail" };

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

  it("[conflict.one-terminal] a resolved or dismissed conflict takes no command but a late suite cell, which leaves it where it ended, and a conflict ends at most once", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => {
          const state = r.before?.conflict?.state;
          const ended = state === "resolved" || state === "dismissed";
          const endings = conflictLog(r.log).filter(
            (c) => c.payload._tag === "ConflictResolved" || c.payload._tag === "ConflictDismissed",
          ).length;
          return (
            endings <= 1 &&
            (!ended ||
              conflictTries(r).every((p) =>
                p.command._tag === "RecordCheck"
                  ? p.after?.conflict?.state === state
                  : Result.isFailure(p.result),
              ))
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
    // A suite's cell that arrives after the end is recorded, and the conflict stays ended.
    const ended = lateCells([...cells(3), settle, C({ _tag: "Resolve", move: "sequence" })]);
    expect(ended.last[0]).toBe(1);
    expect(ended.conflict?.state).toBe("resolved");
    const dismissed = lateCells([
      ...cells(1, { run: 1, world: "A-noop", outcome: "pass" }),
      settle,
    ]);
    expect(dismissed.last[0]).toBe(1);
    expect(dismissed.conflict?.state).toBe("dismissed");
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

  it("[conflict.settle-escalation-optional] a settle that proves or dismisses needs no escalation; one that would escalate is refused without one, and commits nothing", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => {
            if (p.command._tag !== "Settle" || p.command.escalationId !== undefined) return true;
            const withOne = conflictOracle(r.before, { _tag: "Settle", escalationId: ESCALATION });
            if (withOne === "escalated") return failureReason(p.result) === "escalation-required";
            return withOne === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && p.after?.conflict?.state === withOne;
          }),
        ),
      ),
    );
    const bare = C({ _tag: "Settle" });
    // Proven by an admitted probe, and dismissed by one that never discriminates: no escalation either way.
    expect(drive([C(suspectSemantic), draft, ...cells(3), bare]).state?.conflict?.state).toBe(
      "proven",
    );
    const vacuous = [
      C(suspectSemantic),
      draft,
      ...cells(1, { run: 1, world: "A-noop", outcome: "pass" }),
    ];
    expect(drive([...vacuous, bare]).state?.conflict?.state).toBe("dismissed");
    // An unstable probe escalates the conflict, so the settle needs the escalation it opens.
    const unstable = [
      C(suspectSemantic),
      draft,
      ...cells(2, { run: 2, world: "A-noop", outcome: "pass" }),
    ];
    const refused = drive([...unstable, bare]);
    expect(failureReason(refused.results.at(-1))).toBe("escalation-required");
    expect(refused.state?.conflict?.state).toBe("probing");
    expect(drive([...unstable, bare, settle]).state?.conflict?.state).toBe("escalated");
    // So does a probe whose every draft failed.
    const failed = drive([
      C(suspectSemantic),
      P({ _tag: "DraftFailed", conflictId: CONFLICT }),
      bare,
    ]);
    expect(failureReason(failed.results.at(-1))).toBe("escalation-required");
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
  it("[conflict.world-checks] a suite's cell is recorded exactly on a conflict whose probe was drafted, in whatever state it has reached since and never before; it leaves the state, and a cell never changes its answer", () => {
    let probing = 0;
    let late = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          conflictTries(r).every((p) => {
            if (p.command._tag !== "RecordCheck") return true;
            const events = Result.isSuccess(p.result) ? p.result.success : [];
            const before = r.before?.conflict;
            if (events.length > 0 && before?.state === "probing") probing++;
            if (events.length > 0 && before?.state !== "probing") late++;
            return (
              (before?.probeId !== undefined || Result.isFailure(p.result)) &&
              Result.isSuccess(p.result) === (conflictOracle(r.before, p.command) !== "refused") &&
              events.every((e) => e._tag === "WorldCheckRan") &&
              (p.after?.conflict?.state ?? "none") === (before?.state ?? "none")
            );
          }),
        ),
      ),
    );
    expect(probing).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    // Before any draft there is no matrix to fill, and a conflict decided without a probe never has one.
    const early = drive([C(suspectSemantic), check("pass")]);
    expect(failureReason(early.results.at(-1))).toBe("no-probe-drafted");
    const undrafted = drive([
      C(suspectSemantic),
      P({ _tag: "DraftFailed", conflictId: CONFLICT }),
      check("pass"),
      settle,
      check("pass"),
    ]);
    expect(undrafted.state?.conflict?.state).toBe("escalated");
    expect(tally(undrafted.results)).toEqual([1, 1, "no-probe-drafted", 1, "no-probe-drafted"]);
    const refusedMerge = drive([
      C({ _tag: "Suspect", kind: "textual", parties: [CHANGE_A, CHANGE_B] }),
      C({ _tag: "Prove", evidence: { _tag: "merge-refused", batchId: BATCH } }),
      check("pass"),
    ]);
    expect(refusedMerge.state?.conflict?.state).toBe("proven");
    expect(failureReason(refusedMerge.results.at(-1))).toBe("no-probe-drafted");
    const ruledOut = drive([
      C(suspectSemantic),
      C({ _tag: "Dismiss", premise: PREMISE, effect: EFFECTS[0] ?? PREMISE }),
      check("pass"),
    ]);
    expect(ruledOut.state?.conflict?.state).toBe("dismissed");
    expect(failureReason(ruledOut.results.at(-1))).toBe("no-probe-drafted");
    // While the probe runs.
    const played = drive([
      C(suspectSemantic),
      draft,
      check("fail"),
      check("fail"),
      check("pass"),
      check("n/a"),
    ]);
    expect(tally(played.results)).toEqual([1, 1, ...LATE]);
    expect(played.state?.conflict).toMatchObject({ state: "probing", checks: [CELL] });
    // The suites finish minutes after the probe's deciding cell: proven by it, dismissed by it, escalated when it is unstable, and resolved since.
    const proven = lateCells([...cells(3), settle]);
    expect(proven.last).toEqual(LATE);
    expect(proven.conflict).toMatchObject({ state: "proven", checks: [CELL] });
    const dismissed = lateCells([
      ...cells(1, { run: 1, world: "A-noop", outcome: "pass" }),
      settle,
    ]);
    expect(dismissed.last).toEqual(LATE);
    expect(dismissed.conflict).toMatchObject({ state: "dismissed", checks: [CELL] });
    const escalated = lateCells([
      ...cells(2, { run: 2, world: "A-noop", outcome: "pass" }),
      settle,
    ]);
    expect(escalated.last).toEqual(LATE);
    expect(escalated.conflict).toMatchObject({ state: "escalated", checks: [CELL] });
    const resolved = lateCells([...cells(3), settle, C({ _tag: "Resolve", move: "sequence" })]);
    expect(resolved.last).toEqual(LATE);
    expect(resolved.conflict).toMatchObject({ state: "resolved", checks: [CELL] });
    // A cell recorded while probing is the same cell after the decision.
    const across = drive([
      C(suspectSemantic),
      draft,
      check("fail"),
      ...cells(3),
      settle,
      check("fail"),
      check("pass"),
    ]);
    expect(tally(across.results).slice(-2)).toEqual([0, "cell-recorded"]);
    expect(across.state?.conflict).toMatchObject({ state: "proven", checks: [CELL] });
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

const ANOTHER = makeId("cfl", `${"0".repeat(25)}2`);
const ANOTHER_PROBE = makeId("prb", `${"0".repeat(25)}2`);
/** A change that is a party of no conflict here. */
const OUTSIDER = makeId("chg", `${"0".repeat(25)}3`);

/** The conflict's own half of the pair's tour: its states, and the events that fold into it. */
const conflictTour = (): readonly Fold<Conflict, ConflictEvent>[] =>
  ledgerTour().flatMap(({ before, event, after }) =>
    foldsIntoConflict(event) && after.conflict !== undefined
      ? [{ before: before?.conflict, event, after: after.conflict }]
      : [],
  );

/** What the fold's table is about: whose the conflict is, its kind and state, the probe drafted for it, the suite cells recorded and how it ended. */
interface Folded {
  readonly id: Conflict["id"];
  readonly kind: ConflictKind;
  readonly state: Conflict["state"];
  /** Who the conflict is between: a ruling goes against none but these. */
  readonly parties: readonly string[];
  readonly probe?: string;
  /** Each suite cell recorded, by world, check and run, with its answer. */
  readonly cells: Readonly<Record<string, string>>;
  readonly escalation?: string;
  readonly resolved?: string;
}

/** The proof that settles each kind with no probe (state-machines.md § Conflict, Suspected to Proven); a semantic conflict has none. */
const PROOF_OF: Readonly<Partial<Record<ConflictKind, string>>> = {
  textual: "merge-refused",
  precedent: "guard",
  interaction: "interaction",
};

/** How a conflict ended, as its line shows it: the move, the decision of a ruling, and who the ruling went against. */
const resolvedBy = (
  move: string,
  decisionId: string | undefined,
  against: readonly string[] = [],
): string =>
  [
    move,
    ...(decisionId === undefined ? [] : [`by ${decisionId}`]),
    ...(against.length === 0 ? [] : [`against ${against.join(" and ")}`]),
  ].join(" ");

/** The fold's from-table (state-machines.md § Conflict), typed apart from `evolveConflict`. */
const folds = (from: Folded | undefined, event: ConflictEvent): Folded | "illegal" => {
  if (from === undefined)
    return event._tag === "ConflictSuspected"
      ? {
          id: event.conflictId,
          kind: event.kind,
          state: "suspected",
          parties: event.parties,
          cells: {},
        }
      : "illegal";
  if (event.conflictId !== from.id) return "illegal";
  const undecided = from.state === "suspected" || from.state === "probing";
  switch (event._tag) {
    case "ConflictSuspected":
      return "illegal";
    case "ProbeDrafted":
      return from.state === "suspected"
        ? { ...from, state: "probing", probe: event.probeId }
        : "illegal";
    case "ProbeRan":
      return from.state === "probing" && event.probeId === from.probe ? from : "illegal";
    case "WorldCheckRan": {
      // A suite's cell is a fact of a conflict whose probe was drafted, whatever it has become; a cell is recorded once.
      const cell = `${event.world} ${event.check} run ${event.run}`;
      return from.probe !== undefined && from.cells[cell] === undefined
        ? { ...from, cells: { ...from.cells, [cell]: event.outcome } }
        : "illegal";
    }
    case "ConflictProven": {
      const proof = event.evidence;
      const proves =
        proof._tag === "probe"
          ? from.state === "probing" && proof.probeId === from.probe
          : from.state === "suspected" && PROOF_OF[from.kind] === proof._tag;
      return proves ? { ...from, state: "proven" } : "illegal";
    }
    case "ConflictDismissed":
      return undecided ? { ...from, state: "dismissed" } : "illegal";
    case "ConflictEscalated":
      // Unprovable is what an undecided conflict becomes; a proven one escalates as human-class.
      return (event.reason === "unprovable" ? undecided : from.state === "proven")
        ? { ...from, state: "escalated", escalation: event.escalationId }
        : "illegal";
    case "ConflictResolved": {
      // A proven conflict resolves by a move; an escalated one only on a ruling's decision.
      const resolves =
        from.state === "proven" || (from.state === "escalated" && event.decisionId !== undefined);
      // Only a ruling goes against anyone, and only against the conflict's own parties.
      const against = event.against ?? [];
      const ruled =
        against.length === 0 ||
        (event.decisionId !== undefined && against.every((id) => from.parties.includes(id)));
      return resolves && ruled
        ? {
            ...from,
            state: "resolved",
            resolved: resolvedBy(event.move, event.decisionId, against),
          }
        : "illegal";
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/**
 * Each event in every form the fold could tell apart: another probe's cell, a
 * suite cell with the other answer and of another run, each kind of proof, each
 * reason to escalate, a resolution with and without a decision, a ruling that
 * goes against a party, against a party and an outsider, and a resolution
 * against a party with no decision; and every one of those as another
 * conflict's.
 */
const conflictForms = (event: ConflictEvent): readonly ConflictEvent[] => {
  const forms = ((): readonly ConflictEvent[] => {
    switch (event._tag) {
      case "ProbeRan":
        return [event, { ...event, probeId: ANOTHER_PROBE }];
      case "WorldCheckRan":
        return [
          event,
          { ...event, outcome: event.outcome === "pass" ? "fail" : "pass" },
          { ...event, run: event.run === 1 ? 2 : 1 },
        ];
      case "ConflictProven":
        return [
          { ...event, evidence: { _tag: "probe", probeId: PROBE } },
          { ...event, evidence: { _tag: "probe", probeId: ANOTHER_PROBE } },
          { ...event, evidence: { _tag: "guard", guardId: GUARD } },
          { ...event, evidence: { _tag: "merge-refused", batchId: BATCH } },
          { ...event, evidence: { _tag: "interaction", batchId: BATCH } },
        ];
      case "ConflictEscalated":
        return [
          { ...event, reason: "human-class" },
          { ...event, reason: "unprovable" },
        ];
      case "ConflictResolved": {
        const { decisionId: _decision, against: _against, ...bare } = event;
        const ruled = { ...bare, decisionId: DECISION };
        return [
          bare,
          ruled,
          { ...ruled, against: [CHANGE_A] },
          { ...ruled, against: [CHANGE_A, OUTSIDER] },
          { ...bare, against: [CHANGE_A] },
        ];
      }
      default:
        return [event];
    }
  })();
  return forms.flatMap((form) => [form, { ...form, conflictId: ANOTHER }]);
};

describe("the Conflict fold", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[conflict.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Conflict, ConflictEvent, Folded>({
      evolve: evolveConflict,
      walked: conflictTour(),
      summary: (c) => ({
        id: c.id,
        kind: c.kind,
        state: c.state,
        parties: c.parties,
        ...(c.probeId === undefined ? {} : { probe: c.probeId }),
        cells: Object.fromEntries(
          (c.checks ?? []).map((k) => [`${k.world} ${k.check} run ${k.run}`, k.outcome]),
        ),
        ...(c.escalationId === undefined ? {} : { escalation: c.escalationId }),
        ...(c.move === undefined ? {} : { resolved: resolvedBy(c.move, c.decisionId, c.against) }),
      }),
      shown: (f) =>
        [
          `${f.id} ${f.kind} ${f.state}`,
          ...(f.probe === undefined ? [] : [`probe ${f.probe}`]),
          ...Object.entries(f.cells).map(([cell, outcome]) => `${cell} ${outcome}`),
          ...(f.escalation === undefined ? [] : [`escalated as ${f.escalation}`]),
          ...(f.resolved === undefined ? [] : [f.resolved]),
        ].join(", "),
      forms: conflictForms,
      times: [T0],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    const shape = foldShape(cases);
    expect({ ...shape, rows: shape.rows.length }).toEqual({ folds: 9424, refused: 8925, rows: 76 });
  });
});

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe("a suspicion's subject key", () => {
  it("[conflict.subject-key] a subject key given on a subject-owned suspicion reaches ConflictSuspected and the Conflict unchanged, through the wire; none given, none appears; on any other kind it is refused", () => {
    const keys = ["authz.permission-evaluation", "authz", "repo-view.owner"].map((k) =>
      SubjectKey.make(k),
    );
    const { premise: _p, effect: _e, subjectId: _s, predicate: _q, ...bare } = suspectSemantic;
    const commandOf = (
      kind: ConflictKind,
      subjectKey: SubjectKey | undefined,
    ): ConflictCommand => ({
      ...bare,
      kind,
      parties: [CHANGE_A, CHANGE_B],
      ...(kind === "semantic" || kind === "precedent" ? { subjectId: SUBJECT } : {}),
      ...(kind === "semantic" ? { predicate: "freshness" as const } : {}),
      ...(subjectKey === undefined ? {} : { subjectKey }),
    });
    fc.assert(
      fc.property(
        fc.constantFrom<ConflictKind>("semantic", "precedent", "textual", "interaction"),
        fc.option(fc.constantFrom(...keys), { nil: undefined }),
        (kind, subjectKey) => {
          const owned = kind === "semantic" || kind === "precedent";
          const decided = decideConflict(undefined, commandOf(kind, subjectKey), {
            now: T0,
            conflictId: CONFLICT,
          });
          if (!owned && subjectKey !== undefined)
            return (
              Result.isFailure(decided) &&
              "reason" in decided.failure &&
              decided.failure.reason === "subject-mismatch"
            );
          if (Result.isFailure(decided)) return false;
          const [suspected] = decided.success;
          const conflict = replayConflict(
            throughTheWire(
              ConflictEvent,
              decided.success.map((payload) => ({ at: T0, payload })),
            ),
          );
          return (
            suspected?._tag === "ConflictSuspected" &&
            suspected.subjectKey === subjectKey &&
            "subjectKey" in suspected === (subjectKey !== undefined) &&
            conflict !== undefined &&
            conflict.subjectKey === subjectKey &&
            "subjectKey" in conflict === (subjectKey !== undefined)
          );
        },
      ),
    );
    const key = SubjectKey.make("authz.permission-evaluation");
    const decided = decideConflict(undefined, commandOf("semantic", key), {
      now: T0,
      conflictId: CONFLICT,
    });
    const events = Result.isSuccess(decided) ? decided.success : [];
    expect(events).toMatchObject([{ _tag: "ConflictSuspected", subjectKey: key }]);
    expect(
      replayConflict(
        throughTheWire(
          ConflictEvent,
          events.map((payload) => ({ at: T0, payload })),
        ),
      ),
    ).toMatchObject({ subjectId: SUBJECT, subjectKey: key });
    const refused = decideConflict(undefined, commandOf("textual", key), {
      now: T0,
      conflictId: CONFLICT,
    });
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      reason: "subject-mismatch",
    });
  });
});

describe("a suspicion's propositions", () => {
  it("[conflict.suspect-propositions] Suspect's premise and effect reach ConflictSuspected and the Conflict, through the wire; none given, none appears", () => {
    const premise = { holder: CHANGE_A, proposition: PREMISE };
    const effect = { changeId: CHANGE_B, proposition: EFFECTS[0] ?? PREMISE };
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (withPremise, withEffect) => {
        const { premise: _p, effect: _e, ...bare } = suspectSemantic;
        const command: ConflictCommand = {
          ...bare,
          ...(withPremise ? { premise } : {}),
          ...(withEffect ? { effect } : {}),
        };
        const decided = decideConflict(undefined, command, { now: T0, conflictId: CONFLICT });
        if (Result.isFailure(decided)) return false;
        const conflict = replayConflict(
          throughTheWire(
            ConflictEvent,
            decided.success.map((payload) => ({ at: T0, payload })),
          ),
        );
        return (
          conflict !== undefined &&
          same(conflict.premise, withPremise ? premise : undefined) &&
          same(conflict.effect, withEffect ? effect : undefined) &&
          "premise" in conflict === withPremise &&
          "effect" in conflict === withEffect
        );
      }),
    );
    const decided = decideConflict(undefined, suspectSemantic, { now: T0, conflictId: CONFLICT });
    expect(Result.isSuccess(decided) && decided.success).toMatchObject([
      { _tag: "ConflictSuspected", premise, effect },
    ]);
  });
});

describe("a ruling's side", () => {
  const between = { ...suspectSemantic, parties: [CHANGE_A, CHANGE_B] } satisfies ConflictCommand;
  const facts = { now: T0, conflictId: CONFLICT };

  it("[conflict.ruling-against] a ruling goes against the side it does not let stand: never the standing side, always the other, never both, and no one when the conflict does not name two sides", () => {
    const CHANGES = [undefined, CHANGE_A, CHANGE_B, OUTSIDER];
    const { premise: _p, effect: _e, ...bare } = between;
    const pairs = CHANGES.flatMap((holder) => CHANGES.map((author) => ({ holder, author })));
    const ruled = pairs.map(({ holder, author }) => {
      const suspected = decideConflict(
        undefined,
        {
          ...bare,
          ...(holder === undefined ? {} : { premise: { holder, proposition: PREMISE } }),
          ...(author === undefined
            ? {}
            : { effect: { changeId: author, proposition: EFFECTS[0] ?? PREMISE } }),
        },
        facts,
      );
      const conflict = replayConflict(
        (Result.isSuccess(suspected) ? suspected.success : []).map((payload) => ({
          at: T0,
          payload,
        })),
      );
      if (conflict === undefined) throw new Error("the suspicion was refused");
      return {
        holder,
        author,
        premiseStands: sidesAgainst(conflict, "premise"),
        effectStands: sidesAgainst(conflict, "effect"),
      };
    });
    expect(ruled).toEqual(
      pairs.map(({ holder, author }) => {
        const twoSides = holder !== undefined && author !== undefined && holder !== author;
        return {
          holder,
          author,
          premiseStands: twoSides ? [author] : [],
          effectStands: twoSides ? [holder] : [],
        };
      }),
    );
  });

  it("[conflict.resolution-against] who a ruling goes against reaches ConflictResolved and the Conflict, through the wire; none given, none appears; it is refused with no decision and for a change that is no party", () => {
    const proven = [C(between), draft, ...cells(3), settle];
    const starts = {
      proven: drive(proven).state?.conflict,
      escalated: drive([...proven, C({ _tag: "Escalate", escalationId: ESCALATION })]).state
        ?.conflict,
    };
    expect([starts.proven?.state, starts.escalated?.state]).toEqual(["proven", "escalated"]);
    const AGAINST = [
      undefined,
      [],
      [CHANGE_A],
      [CHANGE_B],
      [CHANGE_B, CHANGE_A],
      [OUTSIDER],
      [CHANGE_A, OUTSIDER],
    ];
    const cases = (["proven", "escalated"] as const).flatMap((from) =>
      [undefined, DECISION].flatMap((decisionId) =>
        AGAINST.map((against) => ({ from, decisionId, against })),
      ),
    );
    type Case = (typeof cases)[number];
    /** What a resolution carried, or why it was refused. */
    const outcome = ({ from, decisionId, against }: Case) => {
      const decided = decideConflict(
        starts[from],
        {
          _tag: "Resolve",
          move: "escalate",
          ...(decisionId === undefined ? {} : { decisionId }),
          ...(against === undefined ? {} : { against }),
        },
        facts,
      );
      if (Result.isFailure(decided))
        return "reason" in decided.failure ? decided.failure.reason : decided.failure._tag;
      const [resolved] = decided.success;
      const conflict = throughTheWire(
        ConflictEvent,
        decided.success.map((payload) => ({ at: T0, payload })),
      ).reduce<Conflict | undefined>((state, event) => evolveConflict(state, event), starts[from]);
      return {
        events: decided.success.length,
        onEvent: resolved?._tag === "ConflictResolved" ? resolved.against : "another event",
        eventNamesIt: resolved !== undefined && "against" in resolved,
        state: conflict?.state,
        decisionId: conflict?.decisionId,
        onConflict: conflict?.against,
        conflictNamesIt: conflict !== undefined && "against" in conflict,
      };
    };
    const expected = ({ from, decisionId, against }: Case) => {
      const named = against ?? [];
      if (decisionId === undefined && (from === "escalated" || named.length > 0))
        return "no-ruling";
      if (named.includes(OUTSIDER)) return "not-a-party";
      return {
        events: 1,
        onEvent: named.length === 0 ? undefined : named,
        eventNamesIt: named.length > 0,
        state: "resolved",
        decisionId,
        onConflict: named.length === 0 ? undefined : named,
        conflictNamesIt: named.length > 0,
      };
    };
    expect(cases.map((c) => ({ ...c, outcome: outcome(c) }))).toEqual(
      cases.map((c) => ({ ...c, outcome: expected(c) })),
    );
  });
});

describe("a conflict whose probe's run failed", () => {
  it("[conflict.run-failed-unprovable] a probing conflict whose probe's run failed settles to Escalated as unprovable and nowhere else, and not without an escalation", () => {
    const failed = P({ _tag: "RunFailed" });
    const matrix = cells(3);
    const bare: ConflictCommand = { _tag: "Settle" };
    const named: ConflictCommand = { _tag: "Settle", escalationId: ESCALATION };
    const recorded = Array.from({ length: matrix.length }, (_, n) => n);
    const settled = recorded.map((n) => {
      const before = drive([C(suspectSemantic), draft, ...matrix.slice(0, n), failed]);
      const unnamed = drive([C(suspectSemantic), draft, ...matrix.slice(0, n), failed, C(bare)]);
      const escalated = drive([C(suspectSemantic), draft, ...matrix.slice(0, n), failed, C(named)]);
      return {
        cells: n,
        probe: before.state?.probe?.discarded,
        before: before.state?.conflict?.state,
        table: [conflictOracle(before.state, bare), conflictOracle(before.state, named)],
        unnamed: failureReason(unnamed.results.at(-1)),
        stays: unnamed.state?.conflict?.state,
        events: eventsIn(escalated.results.at(-1) ?? Result.succeed([])),
        after: escalated.state?.conflict?.state,
        escalation: escalated.state?.conflict?.escalationId,
      };
    });
    expect(settled).toEqual(
      recorded.map((n) => ({
        cells: n,
        probe: "run-failed",
        before: "probing",
        table: ["refused", "escalated"],
        unnamed: "escalation-required",
        stays: "probing",
        events: [
          {
            _tag: "ConflictEscalated",
            conflictId: CONFLICT,
            escalationId: ESCALATION,
            reason: "unprovable",
          },
        ],
        after: "escalated",
        escalation: ESCALATION,
      })),
    );
    // A failed run is the end of a probe that was drafted: on a conflict still suspected, such a probe settles nothing.
    const suspected = drive([C(suspectSemantic)]).state?.conflict;
    const probe = drive([C(suspectSemantic), draft, failed]).state?.probe;
    if (suspected === undefined || probe === undefined) throw new Error("no failed run to read");
    const early = decideConflict(suspected, named, { now: T0, conflictId: CONFLICT, probe });
    expect(Result.isFailure(early) && "reason" in early.failure && early.failure.reason).toBe(
      "probe-pending",
    );
  });
});
