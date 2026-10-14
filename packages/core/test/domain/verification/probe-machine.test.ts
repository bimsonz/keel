import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Instant, makeId } from "../../../src/domain/kernel/index.ts";
import {
  admit,
  type ConflictCommand,
  decideProbe,
  type DraftFailure,
  evolveProbe,
  MAX_DRAFT_ATTEMPTS,
  type Probe,
  type ProbeCell,
  type ProbeCommand,
  ProbeDiscarded,
  ProbeStateRefused,
  ProbeEvent,
  replayProbe,
} from "../../../src/domain/verification/index.ts";
import { probeChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import type { Fold } from "../../support/machine.ts";
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
  foldsIntoProbe,
  GUARD,
  type Ledger,
  type LedgerCommand,
  type LedgerEvent,
  ledgerMachine,
  ledgerTour,
  planArb,
  PREMISE,
  PROBE,
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
              // No other command admits a guard, and each discards for its own reason alone: drafts that failed, or a run that did.
              return (
                admitted === undefined &&
                (discarded === undefined ||
                  discarded.reason ===
                    (p.command._tag === "Probe" && p.command.command._tag === "RunFailed"
                      ? "run-failed"
                      : "draft-failed"))
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

const ANOTHER = makeId("prb", `${"0".repeat(25)}2`);
const ANOTHER_CONFLICT = makeId("cfl", `${"0".repeat(25)}2`);
const ANOTHER_GUARD = makeId("grd", `${"0".repeat(25)}2`);

/** The probe's own half of the pair's tour: its states, and the events that fold into it. */
const probeTour = (): readonly Fold<Probe, ProbeEvent>[] =>
  ledgerTour().flatMap(({ before, event, after }) =>
    foldsIntoProbe(event) && after.probe !== undefined
      ? [{ before: before?.probe, event, after: after.probe }]
      : [],
  );

/** What the fold's table is about: whose the probe is, its conflict, its state, when it was made, the cells of its matrix recorded and how it ended. */
interface Folded {
  readonly id: Probe["id"];
  readonly conflict: Probe["conflictId"];
  readonly state: Probe["state"];
  /** The instant the probe's first event, its draft or a failed draft's discard, was folded at. */
  readonly createdAt: Instant;
  readonly cells: readonly ProbeCell[];
  readonly ended?: string;
}

/** What the matrix recorded so far says: admitted, still pending, or the reason it is rejected for. */
const matrixSays = (cells: readonly ProbeCell[]): string => {
  const admission = admit(cells);
  return admission._tag === "rejected" ? admission.reason : admission._tag;
};

/**
 * The fold's from-table (state-machines.md § Probe → Guard), typed apart from
 * `evolveProbe`. On a probe that is there, the table compares a cell's conflict
 * with the probe's and an admission's and a discard's with nothing: those two
 * name the probe, and the owning object folds only its own conflict's log.
 */
const folds = (from: Folded | undefined, event: ProbeEvent, at: Instant): Folded | "illegal" => {
  if (from === undefined) {
    if (event._tag === "ProbeDrafted")
      return {
        id: event.probeId,
        conflict: event.conflictId,
        state: "calibrating",
        createdAt: at,
        cells: [],
      };
    // Every draft failed: the probe begins discarded, by the one event that names its conflict.
    return event._tag === "ProbeDiscarded" &&
      event.reason === "draft-failed" &&
      event.conflictId !== undefined
      ? {
          id: event.probeId,
          conflict: event.conflictId,
          state: "discarded",
          createdAt: at,
          cells: [],
          ended: "draft-failed",
        }
      : "illegal";
  }
  const calibrating = from.state === "calibrating";
  switch (event._tag) {
    case "ProbeDrafted":
      return "illegal";
    case "ProbeRan":
      return calibrating &&
        event.probeId === from.id &&
        event.conflictId === from.conflict &&
        !from.cells.some((c) => c.world === event.world && c.run === event.run)
        ? {
            ...from,
            cells: [...from.cells, { world: event.world, run: event.run, outcome: event.outcome }],
          }
        : "illegal";
    case "GuardAdmitted":
      // Admission is computed from the cells: a log cannot admit a probe its matrix does not.
      return calibrating && event.probeId === from.id && matrixSays(from.cells) === "admitted"
        ? { ...from, state: "admitted", ended: event.guardId }
        : "illegal";
    case "ProbeDiscarded": {
      // And it cannot discard one for a reason the matrix does not give. A run that failed is no reason of the matrix's: it ends a probe whose matrix has decided nothing.
      const says = matrixSays(from.cells);
      const reasoned = event.reason === "run-failed" ? says === "pending" : says === event.reason;
      return calibrating && event.probeId === from.id && reasoned
        ? { ...from, state: "discarded", ended: event.reason }
        : "illegal";
    }
    case "GuardRetired":
      return from.state === "admitted" && event.guardId === from.ended
        ? { ...from, state: "retired", ended: `${from.ended} by ${event.decisionId}` }
        : "illegal";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/**
 * Each event in every form the fold could tell apart: another probe's and
 * another conflict's, a cell with another answer, an admission of another
 * guard, a discard for each reason (a failed run among them) with and without
 * its conflict, and a retirement of another guard.
 */
const probeForms = (event: ProbeEvent): readonly ProbeEvent[] => {
  switch (event._tag) {
    case "ProbeDrafted":
      return [event, { ...event, probeId: ANOTHER }, { ...event, conflictId: ANOTHER_CONFLICT }];
    case "ProbeRan":
      return [
        event,
        { ...event, probeId: ANOTHER },
        { ...event, conflictId: ANOTHER_CONFLICT },
        { ...event, outcome: event.outcome === "pass" ? "fail" : "pass" },
      ];
    case "GuardAdmitted":
      return [
        event,
        { ...event, probeId: ANOTHER },
        { ...event, conflictId: ANOTHER_CONFLICT },
        { ...event, guardId: ANOTHER_GUARD },
      ];
    case "ProbeDiscarded": {
      const { conflictId: _conflict, detail: _detail, ...bare } = event;
      return (["non-discriminating", "unstable", "draft-failed", "run-failed"] as const).flatMap(
        (reason): ProbeEvent[] => [
          { ...bare, reason },
          { ...bare, reason, conflictId: CONFLICT },
          { ...bare, reason, conflictId: ANOTHER_CONFLICT },
          { ...bare, reason, conflictId: CONFLICT, probeId: ANOTHER },
        ],
      );
    }
    case "GuardRetired":
      return [event, { ...event, guardId: ANOTHER_GUARD }];
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

describe("the Probe → Guard fold", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[probe.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Probe, ProbeEvent, Folded>({
      evolve: evolveProbe,
      walked: probeTour(),
      summary: (p) => ({
        id: p.id,
        conflict: p.conflictId,
        state: p.state,
        createdAt: p.createdAt,
        cells: p.cells,
        ...(p.discarded === undefined ? {} : { ended: p.discarded }),
        ...(p.guardId === undefined
          ? {}
          : { ended: p.retiredBy === undefined ? p.guardId : `${p.guardId} by ${p.retiredBy}` }),
      }),
      shown: (f) =>
        [
          `${f.id} of ${f.conflict} ${f.state}, made at ${f.createdAt}`,
          ...f.cells.map((c) => `${c.world} run ${c.run} ${c.outcome}`),
          ...(f.ended === undefined ? [] : [f.ended]),
        ].join(", "),
      forms: probeForms,
      // Two instants an hour apart: what the fold dates, it dates by its own, so a constant disagrees with one.
      times: [T0, Instant(T0 + 3_600_000)],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Forty-one rows, every form tried at both instants: 3731 folds at each, 334 of them taken
    // and 3397 refused, twice over.
    const shape = foldShape(cases);
    expect({ ...shape, rows: shape.rows.length }).toEqual({ folds: 7462, refused: 6794, rows: 41 });
  });
});

/** Every reason a draft can fail for, written out: the list in the source must be exactly this. */
const DRAFT_FAILURES: readonly DraftFailure[] = [
  "schema",
  "truncated",
  "abstained",
  "repairs-exhausted",
  "incomplete",
  "no-propositions",
  "no-submission",
  "party-gone",
  "worlds-unbuildable",
];
const decodeDiscarded = Schema.decodeUnknownResult(ProbeDiscarded);
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

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

describe("the reasons a draft fails for", () => {
  it("[probe.draft-failure-reasons] every reason reaches ProbeDiscarded from DraftFailed and survives the wire, and no other word decodes", () => {
    const carried = DRAFT_FAILURES.map((detail) => {
      const wire = { _tag: "ProbeDiscarded", reason: "draft-failed", conflictId: CONFLICT, detail };
      // The wire form first: a reason the list lacks never decodes, whatever decide does with it.
      const read = decodeDiscarded({ ...wire, probeId: PROBE });
      if (Result.isFailure(read)) return `${detail}: does not decode`;
      const { results } = drive([
        suspect,
        P({ _tag: "DraftFailed", conflictId: CONFLICT, detail }),
      ]);
      const [discarded] = results[1] === undefined ? [] : eventsIn(results[1]);
      if (discarded?._tag !== "ProbeDiscarded") return `${detail}: no ProbeDiscarded`;
      const back = decodeDiscarded(asJson(Schema.encodeSync(ProbeDiscarded)(discarded)));
      return Result.isSuccess(back) &&
        back.success.detail === detail &&
        back.success.reason === "draft-failed" &&
        back.success.conflictId === CONFLICT
        ? "carried"
        : `${detail}: lost on the way`;
    });
    expect(carried).toEqual(DRAFT_FAILURES.map(() => "carried"));
    expect(new Set(DRAFT_FAILURES).size).toBe(9);

    fc.assert(
      fc.property(fc.string(), (word) => {
        const known = DRAFT_FAILURES.some((reason) => reason === word);
        const read = decodeDiscarded({
          _tag: "ProbeDiscarded",
          probeId: PROBE,
          reason: "draft-failed",
          conflictId: CONFLICT,
          detail: word,
        });
        return Result.isSuccess(read) === known;
      }),
    );
    expect(
      Result.isSuccess(
        decodeDiscarded({
          _tag: "ProbeDiscarded",
          probeId: PROBE,
          reason: "draft-failed",
          conflictId: CONFLICT,
          detail: "timeout",
        }),
      ),
    ).toBe(false);
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

describe("a probe whose run failed", () => {
  it("[probe.run-failed] a failed run discards a probe exactly while it calibrates for a conflict probing it: one discard, no guard, the cells kept, and nothing more is taken; before a draft and once decided it is refused", () => {
    const failed = P({ _tag: "RunFailed" });
    const matrix = [...runOf(1), ...runOf(2), ...runOf(3)];
    /** The probe's own log of a played script, at the times it was played, through the wire and replayed. */
    const replayed = (played: ReturnType<typeof drive>) =>
      comparableProbe(
        replayProbe(
          throughTheWire(
            ProbeEvent,
            played.results.flatMap((r, i) =>
              eventsIn(r)
                .filter(foldsIntoProbe)
                .map((payload) => ({ at: Instant(T0 + i + 1), payload })),
            ),
          ),
        ),
      );
    // With any part of the matrix recorded, short of the cell that decides it.
    const recorded = Array.from({ length: matrix.length }, (_, cells) => cells);
    const ends = recorded.map((cells) => {
      const calibrating = [suspect, draft(), ...matrix.slice(0, cells)];
      const played = drive([...calibrating, failed, failed, record(3, "A-noop"), failed]);
      const probe = played.state?.probe;
      return {
        cells,
        events: eventsIn(played.results[calibrating.length] ?? Result.succeed([])),
        state: probe?.state,
        discarded: probe?.discarded,
        kept: probe?.cells.length,
        guard: probe?.guardId,
        conflict: played.state?.conflict?.state,
        after: played.results.slice(-3).map((r) => Result.isFailure(r) && r.failure._tag),
        replays: replayed(played) === comparableProbe(probe),
      };
    });
    expect(ends).toEqual(
      recorded.map((cells) => ({
        cells,
        events: [
          { _tag: "ProbeDiscarded", probeId: PROBE, reason: "run-failed", conflictId: CONFLICT },
        ],
        state: "discarded",
        discarded: "run-failed",
        kept: cells,
        guard: undefined,
        conflict: "probing",
        after: ["ProbeStateRefused", "ProbeStateRefused", "ProbeStateRefused"],
        replays: true,
      })),
    );
    // Before a draft there is no probe to fail, and a decided probe's run is over.
    const refusals = [
      [failed],
      [suspect, failed],
      [suspect, P({ _tag: "DraftFailed", conflictId: CONFLICT }), failed],
      [suspect, draft(), ...matrix, failed],
      [suspect, draft(), ...runOf(1, "pass"), ...runOf(2, "pass"), ...runOf(3, "pass"), failed],
    ].map((script) => {
      const played = drive(script);
      const last = played.results.at(-1);
      return {
        probe: played.state?.probe?.state ?? "none",
        ended: played.state?.probe?.discarded,
        refused: last !== undefined && Result.isFailure(last) && last.failure._tag,
      };
    });
    expect(refusals).toEqual([
      { probe: "none", ended: undefined, refused: "ProbeNotFound" },
      { probe: "none", ended: undefined, refused: "ProbeNotFound" },
      { probe: "discarded", ended: "draft-failed", refused: "ProbeStateRefused" },
      { probe: "admitted", ended: undefined, refused: "ProbeStateRefused" },
      { probe: "discarded", ended: "non-discriminating", refused: "ProbeStateRefused" },
    ]);
    // The probe's conflict must be probing it: with no conflict, or one probing another probe, the run's end is refused.
    const calibrating = drive([suspect, draft(), ...runOf(1)]).state;
    const conflict = calibrating?.conflict;
    if (calibrating?.probe === undefined || conflict === undefined)
      throw new Error("no calibrating probe");
    const ANOTHER_PROBE = makeId("prb", `${"0".repeat(25)}2`);
    const reasons = [undefined, { ...conflict, probeId: ANOTHER_PROBE }, conflict].map((held) => {
      const decided = decideProbe(
        calibrating.probe,
        { _tag: "RunFailed" },
        { now: T0, probeId: PROBE, ...(held === undefined ? {} : { conflict: held }) },
      );
      return Result.isFailure(decided)
        ? "reason" in decided.failure && decided.failure.reason
        : decided.success.length;
    });
    expect(reasons).toEqual(["conflict-not-probing", "conflict-not-probing", 1]);
  });
});
