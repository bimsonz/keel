import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Instant } from "../../../src/domain/kernel/index.ts";
import {
  admit,
  type ConflictCommand,
  type DraftFailure,
  MAX_DRAFT_ATTEMPTS,
  type ProbeCommand,
  ProbeDiscarded,
  ProbeStateRefused,
  ProbeEvent,
  replayProbe,
} from "../../../src/domain/verification/index.ts";
import { probeChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import {
  BUNDLE,
  CHANGE_A,
  CHANGE_B,
  comparableProbe,
  CONFLICT,
  DECISION,
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
  probeLog,
  probeOracle,
  type Record_,
  run,
  SUBJECT,
  T0,
  TENET,
  throughTheWire,
  WORLDS,
} from "./ledger.ts";

const PROPERTY_TIMEOUT = 60_000;

/** Every probe command a step took or tried. */
const probeTries = (r: Record_) =>
  [r.taken, ...r.probes].flatMap((p) =>
    p.command._tag === "Probe" ? [{ ...p, command: p.command.command }] : [],
  );

const C = (command: ConflictCommand): LedgerCommand => ({ _tag: "Conflict", command });
const P = (command: ProbeCommand): LedgerCommand => ({ _tag: "Probe", command });

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

const tagsOf = (r: ReturnType<typeof ledgerMachine.decide> | undefined): readonly string[] =>
  r === undefined ? [] : eventsIn(r).map((e) => e._tag);

const suspect = C({
  _tag: "Suspect",
  kind: "semantic",
  parties: [CHANGE_A, TENET],
  subjectId: SUBJECT,
  predicate: "freshness",
  premise: { holder: CHANGE_A, proposition: PREMISE },
  effect: { changeId: CHANGE_B, proposition: EFFECTS[0] ?? PREMISE },
});
const draft = (attempts = 1) =>
  P({ _tag: "Draft", conflictId: CONFLICT, attempts, bundleHash: BUNDLE });
const S1 = { trunk: "pass", A: "pass", B: "n/a", AB: "fail", "A-noop": "fail" } as const;
const record = (
  runNo: number,
  world: keyof typeof S1,
  outcome: "pass" | "fail" | "n/a" = S1[world],
): LedgerCommand =>
  P({
    _tag: "Record",
    world,
    run: runNo,
    outcome,
    resultRef: `r2://${runNo}/${world}`,
    guardId: GUARD,
  });
const runOf = (n: number, noop: "pass" | "fail" | "n/a" = "fail"): LedgerCommand[] =>
  WORLDS.map((world) => record(n, world, world === "A-noop" ? noop : S1[world]));

describe("the Probe → Guard machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[probe.transitions] in every state a run reaches, every probe command lands where the docs' table says, is a no-op for a retried cell, or is refused", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          probeTries(r).every((p) => {
            const expected = probeOracle(r.before, p.command);
            if (expected === "refused") return Result.isFailure(p.result);
            if (expected === "same")
              return Result.isSuccess(p.result) && eventsIn(p.result).length === 0;
            return (
              Result.isSuccess(p.result) &&
              !p.threw &&
              (p.after?.probe?.state ?? "none") === expected
            );
          }),
        ),
      ),
    );
    // Calibration runs are numbered 1 to 3: a fourth is refused.
    const extra = drive([suspect, draft(), record(4, "A")]);
    expect(Result.isFailure(extra.results[2] ?? Result.succeed([]))).toBe(true);
    // A probe drafts only for a suspected conflict, and gets at most four drafts.
    expect(Result.isFailure(drive([draft()]).results[0] ?? Result.succeed([]))).toBe(true);
    expect(Result.isFailure(drive([suspect, draft(5)]).results[1] ?? Result.succeed([]))).toBe(
      true,
    );
    // A retried cell commits nothing; a contradicting one is refused.
    const retried = drive([
      suspect,
      draft(),
      record(1, "A"),
      record(1, "A"),
      record(1, "A", "fail"),
    ]);
    expect(tagsOf(retried.results[3])).toEqual([]);
    expect(Result.isFailure(retried.results[4] ?? Result.succeed([]))).toBe(true);
  });

  it("[probe.one-terminal] a discarded or retired probe takes no command, and a probe ends at most once", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => {
          const ended =
            r.before?.probe?.state === "discarded" || r.before?.probe?.state === "retired";
          const endings = probeLog(r.log).filter(
            (c) => c.payload._tag === "ProbeDiscarded" || c.payload._tag === "GuardRetired",
          ).length;
          return endings <= 1 && (!ended || probeTries(r).every((p) => Result.isFailure(p.result)));
        }),
      ),
    );
    // Discarded while its conflict is still Probing: a late cell is refused all the same.
    const late = drive([suspect, draft(), ...runOf(1, "pass"), record(2, "A")]);
    expect(late.state?.probe?.state).toBe("discarded");
    expect(late.state?.conflict?.state).toBe("probing");
    expect(Result.isFailure(late.results.at(-1) ?? Result.succeed([]))).toBe(true);
  });

  it("[probe.replay] at every step, the probe's events so far, through the wire, replay to the same probe", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            comparableProbe(replayProbe(throughTheWire(ProbeEvent, probeLog(r.log)))) ===
            comparableProbe(r.after?.probe),
        ),
      ),
    );
    const admitted = drive([suspect, draft(), ...runOf(1), ...runOf(2), ...runOf(3)]);
    expect(admitted.state?.probe?.cells).toHaveLength(15);
  });

  it("[probe.decide-evolvable] evolve takes every event decide emits, for every probe command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (plan) => run(plan).every((r) => probeTries(r).every((p) => !p.threw))),
    );
    // Discriminating, then not: unstable, and evolve agrees with the reason.
    const unstable = drive([suspect, draft(), ...runOf(1), ...runOf(2, "n/a")]);
    expect(unstable.state?.probe?.discarded).toBe("unstable");
  });

  it("[probe.admits-by-matrix] a cell admits the guard exactly when admission says the matrix is admitted, and discards the probe exactly when admission rejects it, for its reason", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          [r.taken, ...r.probes].every((p) => {
            const events = eventsIn(p.result);
            const admitted = events.find((e) => e._tag === "GuardAdmitted");
            const discarded = events.find((e) => e._tag === "ProbeDiscarded");
            if (
              p.command._tag !== "Probe" ||
              p.command.command._tag !== "Record" ||
              events.length === 0
            )
              return (
                admitted === undefined &&
                (discarded === undefined || discarded.reason === "draft-failed")
              );
            const cell = p.command.command;
            const admission = admit([
              ...(r.before?.probe?.cells ?? []),
              { world: cell.world, run: cell.run, outcome: cell.outcome },
            ]);
            return (
              (admission._tag === "admitted"
                ? admitted !== undefined && admitted.runs === admission.runs
                : admitted === undefined) &&
              (admission._tag === "rejected"
                ? discarded !== undefined && discarded.reason === admission.reason
                : discarded === undefined)
            );
          }),
        ),
      ),
    );
    // S-1: the fifteenth cell admits G-1; two good runs are not enough.
    const s1 = drive([suspect, draft(), ...runOf(1), ...runOf(2), ...runOf(3)]);
    expect(tagsOf(s1.results.at(-1))).toEqual(["ProbeRan", "GuardAdmitted"]);
    const two = drive([suspect, draft(), ...runOf(1), ...runOf(2)]);
    expect(two.state?.probe?.state).toBe("calibrating");
  });
});

const probeView: View<Ledger, LedgerEvent> = {
  from: (f) => f.before?.probe?.state ?? "none",
  to: (f) => f.after.probe?.state ?? "none",
};

describe("the Probe → Guard chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[probe.chart] every state change a run makes is an edge of the Probe → Guard chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            offChart(
              probeChart,
              foldsOf(
                ledgerMachine,
                r.before,
                [r.taken.result, ...r.probes.map((p) => p.result)],
                r.now,
              ),
              probeView,
            ).length === 0,
        ),
      ),
    );
    const walked = ledgerTour();
    expect(offChart(probeChart, walked, probeView)).toEqual([]);
    expect(uncovered(probeChart, walked, probeView)).toEqual([]);
    // A probe whose drafts all failed begins Discarded, and its conflict escalates as unprovable.
    const failed = drive([
      suspect,
      P({ _tag: "DraftFailed", conflictId: CONFLICT }),
      C({ _tag: "Settle", escalationId: ESCALATION }),
    ]);
    expect(failed.state?.probe?.state).toBe("discarded");
    expect(failed.state?.conflict?.state).toBe("escalated");
    const retired = drive([
      suspect,
      draft(),
      ...runOf(1),
      ...runOf(2),
      ...runOf(3),
      P({ _tag: "Retire", decisionId: DECISION }),
    ]);
    expect(retired.state?.probe?.state).toBe("retired");
  });
});

const DRAFT_FAILURES: readonly DraftFailure[] = [
  "schema",
  "truncated",
  "abstained",
  "repairs-exhausted",
];
const decodeDiscarded = Schema.decodeUnknownResult(ProbeDiscarded);

describe("a probe whose drafts failed", () => {
  it("[events.discard-detail] DraftFailed's detail reaches ProbeDiscarded, and a detail rides only with draft-failed", () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...DRAFT_FAILURES), { nil: undefined }),
        fc.constantFrom("non-discriminating", "unstable", "draft-failed"),
        (detail, reason) => {
          const { results } = drive([
            suspect,
            P({
              _tag: "DraftFailed",
              conflictId: CONFLICT,
              ...(detail === undefined ? {} : { detail }),
            }),
          ]);
          const [discarded] = results[1] === undefined ? [] : eventsIn(results[1]);
          const carried =
            discarded?._tag === "ProbeDiscarded" &&
            discarded.detail === detail &&
            "detail" in discarded === (detail !== undefined);
          const decoded = decodeDiscarded({
            _tag: "ProbeDiscarded",
            probeId: discarded?._tag === "ProbeDiscarded" ? discarded.probeId : undefined,
            reason,
            conflictId: CONFLICT,
            ...(detail === undefined ? {} : { detail }),
          });
          return (
            carried &&
            Result.isSuccess(decoded) === (detail === undefined || reason === "draft-failed")
          );
        },
      ),
    );
    const { results } = drive([
      suspect,
      P({ _tag: "DraftFailed", conflictId: CONFLICT, detail: "truncated" }),
    ]);
    expect(results[1] === undefined ? [] : eventsIn(results[1])).toMatchObject([
      { _tag: "ProbeDiscarded", reason: "draft-failed", detail: "truncated" },
    ]);
  });
});

const withPropositions = (premise: boolean, effect: boolean) => {
  const { command } = suspect;
  if (command._tag !== "Suspect") return suspect;
  const { premise: p, effect: e, ...bare } = command;
  return C({ ...bare, ...(premise ? { premise: p } : {}), ...(effect ? { effect: e } : {}) });
};
const refusalOf = (r: ReturnType<typeof ledgerMachine.decide> | undefined) =>
  r !== undefined && Result.isFailure(r) ? r.failure : undefined;

describe("drafting a probe", () => {
  it("[probe.unguessed] a probe is drafted only for a conflict naming both the premise and the effect; otherwise it escalates unprovable", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (premise, effect) => {
        const { results } = drive([withPropositions(premise, effect), draft()]);
        const refusal = refusalOf(results[1]);
        if (premise && effect) return tagsOf(results[1]).join() === "ProbeDrafted";
        return (
          refusal instanceof ProbeStateRefused &&
          refusal.reason === "no-propositions" &&
          refusal.nextActions.some((n) => n.kind === "escalate")
        );
      }),
    );
    const { results } = drive([withPropositions(true, false), draft()]);
    expect(refusalOf(results[1])).toMatchObject({ reason: "no-propositions" });
    const failed = drive([
      withPropositions(false, false),
      P({ _tag: "DraftFailed", conflictId: CONFLICT }),
    ]);
    expect(tagsOf(failed.results[1])).toEqual(["ProbeDiscarded"]);
  });

  it("[probe.draft-budget] a probe gets four drafts, the first and three repairs, and no more", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 7 }), (attempts) => {
        const { results } = drive([suspect, draft(attempts)]);
        const admitted = tagsOf(results[1]).join() === "ProbeDrafted";
        return admitted === (attempts >= 1 && attempts <= 4);
      }),
    );
    expect(MAX_DRAFT_ATTEMPTS).toBe(4);
    expect(tagsOf(drive([suspect, draft(4)]).results[1])).toEqual(["ProbeDrafted"]);
    expect(tagsOf(drive([suspect, draft(5)]).results[1])).toEqual([]);
  });
});
