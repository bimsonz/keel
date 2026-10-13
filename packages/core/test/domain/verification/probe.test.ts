import { describe, expect, it } from "vitest";
import {
  admit,
  type ProbeCell,
  type ProbeOutcome,
  type World,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

const outcome: fc.Arbitrary<ProbeOutcome> = fc.constantFrom("pass", "fail", "n/a");

type RunCells = Readonly<Record<World, ProbeOutcome | undefined>>;

/** A calibration run: usually a discriminating one, sometimes noise, sometimes with a cell missing. */
const runArb: fc.Arbitrary<RunCells> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      trunk: fc.constantFrom("pass" as const, "n/a" as const),
      A: fc.constant("pass" as const),
      B: outcome,
      AB: fc.constant("fail" as const),
      "A-noop": fc.constant("fail" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      trunk: outcome,
      A: outcome,
      B: outcome,
      AB: outcome,
      "A-noop": outcome,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      trunk: fc.option(outcome, { nil: undefined }),
      A: fc.option(outcome, { nil: undefined }),
      B: outcome,
      AB: fc.option(outcome, { nil: undefined }),
      "A-noop": fc.option(outcome, { nil: undefined }),
    }),
  },
);

const cellsOf = (runs: readonly RunCells[]): ProbeCell[] =>
  runs.flatMap((r, i) =>
    (["trunk", "A", "B", "AB", "A-noop"] as const).flatMap((world) => {
      const o = r[world];
      return o === undefined ? [] : [{ world, run: i + 1, outcome: o }];
    }),
  );

const matrixArb = fc.array(runArb, { maxLength: 5 });

const isComplete = (r: RunCells): boolean =>
  r.trunk !== undefined && r.A !== undefined && r.AB !== undefined && r["A-noop"] !== undefined;
const discriminating = (r: RunCells): boolean =>
  (r.trunk === "pass" || r.trunk === "n/a") &&
  r.A === "pass" &&
  r.AB === "fail" &&
  r["A-noop"] === "fail";
const good: RunCells = { trunk: "pass", A: "pass", B: "pass", AB: "fail", "A-noop": "fail" };

describe("probe admission", () => {
  it("[probe.admitted-means-discriminating] an admitted probe passed on trunk or did not apply, passed for the holder, failed combined and failed against the do-nothing mutant, on every run", () => {
    let admitted = 0;
    assertReaching(
      fc.property(matrixArb, (runs) => {
        if (admit(cellsOf(runs))._tag !== "admitted") return true;
        admitted++;
        const done = runs.filter(isComplete);
        return done.length >= 3 && done.every(discriminating);
      }),
    );
    expect(admitted).toBeGreaterThan(0);
    // Red on trunk means the probe is not about the combination: never a guard, however it behaves elsewhere.
    const redTrunk: RunCells = { ...good, trunk: "fail" };
    expect(admit(cellsOf([redTrunk, redTrunk, redTrunk]))._tag).toBe("rejected");
    // A run with a cell missing does not count towards the three; generated matrices rarely land on exactly this.
    const partial: RunCells = { ...good, AB: undefined };
    expect(admit(cellsOf([good, good, partial]))._tag).toBe("pending");
  });

  it("[probe.discriminating-runs-admitted] three or more complete runs that all discriminate admit the probe", () => {
    fc.assert(
      fc.property(matrixArb, (runs) => {
        const done = runs.filter(isComplete);
        return (
          !(done.length >= 3 && done.every(discriminating)) ||
          admit(cellsOf(runs))._tag === "admitted"
        );
      }),
    );
    expect(admit(cellsOf([good, good, good]))).toEqual({ _tag: "admitted", runs: 3 });
    // forge-lite's S-1 matrix: A passes, B does not apply, A+B fails.
    const forgeLite: RunCells = { ...good, B: "n/a" };
    expect(admit(cellsOf([forgeLite, forgeLite, forgeLite]))).toEqual({
      _tag: "admitted",
      runs: 3,
    });
    expect(admit(cellsOf([{ ...good, trunk: "n/a" }, good, good]))._tag).toBe("admitted");
  });

  it("[probe.na-never-admitted] a probe that does not apply where it must decide is never admitted", () => {
    fc.assert(
      fc.property(
        matrixArb,
        fc.nat(),
        fc.constantFrom("A" as const, "AB" as const),
        (runs, pick, world) => {
          if (runs.length === 0) return true;
          const i = pick % runs.length;
          // Complete the spoiled run, so the n/a lands in a run that counts.
          const spoiled = runs.map((r, j) =>
            j === i
              ? {
                  ...r,
                  trunk: r.trunk ?? "pass",
                  A: r.A ?? "pass",
                  AB: r.AB ?? "fail",
                  "A-noop": r["A-noop"] ?? "fail",
                  [world]: "n/a" as const,
                }
              : r,
          );
          return admit(cellsOf(spoiled))._tag !== "admitted";
        },
      ),
    );
    const na: RunCells = { trunk: "n/a", A: "n/a", B: "n/a", AB: "n/a", "A-noop": "n/a" };
    expect(admit(cellsOf([na, na, na]))).toEqual({
      _tag: "rejected",
      reason: "non-discriminating",
    });
  });

  it("[probe.passing-everywhere-never-admitted] a probe that passes everywhere is dismissed, not admitted", () => {
    const everywhere: RunCells = {
      trunk: "pass",
      A: "pass",
      B: "pass",
      AB: "pass",
      "A-noop": "pass",
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (n) => admit(cellsOf(Array.from({ length: n }, () => everywhere)))._tag === "rejected",
      ),
    );
    expect(admit(cellsOf([everywhere, everywhere, everywhere]))).toEqual({
      _tag: "rejected",
      reason: "non-discriminating",
    });
    const trunkRed: RunCells = { ...good, trunk: "fail" };
    expect(admit(cellsOf([trunkRed, trunkRed, trunkRed]))._tag).toBe("rejected");
  });

  it("[probe.needs-three-runs] fewer than three complete runs never admit, however good", () => {
    fc.assert(
      fc.property(
        matrixArb,
        (runs) => runs.filter(isComplete).length >= 3 || admit(cellsOf(runs))._tag !== "admitted",
      ),
    );
    expect(admit(cellsOf([good, good]))).toEqual({ _tag: "pending", complete: 2 });
  });

  it("[probe.one-bad-run-rejects] one complete run that does not discriminate rejects the probe: unstable if others did, else non-discriminating", () => {
    fc.assert(
      fc.property(matrixArb, (runs) => {
        const done = runs.filter(isComplete);
        const goodRuns = done.filter(discriminating).length;
        const result = admit(cellsOf(runs));
        if (goodRuns === done.length) return result._tag !== "rejected";
        return (
          result._tag === "rejected" &&
          result.reason === (goodRuns === 0 ? "non-discriminating" : "unstable")
        );
      }),
    );
    const flaky: RunCells = { ...good, AB: "pass" };
    expect(admit(cellsOf([good, good, flaky]))).toEqual({ _tag: "rejected", reason: "unstable" });
  });

  it("[probe.noop-mutant-fails] a probe that passes, or does not apply, against the do-nothing mutant of the holder's world is never admitted", () => {
    fc.assert(
      fc.property(
        matrixArb,
        fc.nat(),
        fc.constantFrom("pass" as const, "n/a" as const),
        (runs, pick, noop) => {
          if (runs.length === 0) return true;
          const i = pick % runs.length;
          // Complete the spoiled run, so the vacuous answer lands in a run that counts.
          const spoiled = runs.map((r, j) =>
            j === i
              ? {
                  ...r,
                  trunk: r.trunk ?? "pass",
                  A: r.A ?? "pass",
                  AB: r.AB ?? "fail",
                  "A-noop": noop,
                }
              : r,
          );
          return admit(cellsOf(spoiled))._tag !== "admitted";
        },
      ),
    );
    // S26: a probe that only counts store lookups passes the whole matrix, and passes against a revoke that removes nothing.
    const vacuous: RunCells = { ...good, "A-noop": "pass" };
    expect(admit(cellsOf([vacuous, vacuous, vacuous]))).toEqual({
      _tag: "rejected",
      reason: "non-discriminating",
    });
    // A template that cannot build the do-nothing world never completes a run, so the probe is never admitted.
    const noNoop: RunCells = { ...good, "A-noop": undefined };
    expect(admit(cellsOf([noNoop, noNoop, noNoop]))).toEqual({ _tag: "pending", complete: 0 });
  });
});
