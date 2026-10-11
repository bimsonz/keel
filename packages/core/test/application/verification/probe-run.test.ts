import { describe, expect, it } from "vitest";
import {
  PROBE_EXIT,
  PROBE_HARNESS_EXIT,
  readProbeRun,
} from "../../../src/application/verification/index.ts";
import type { ProbeOutcome } from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const parsesAsObject = (line: string): boolean => {
  try {
    const value: unknown = JSON.parse(line.trim());
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
};

/** A probe's observation: any one line that a JSON reader would not take for an outcome line. */
const observation = fc
  .string({ maxLength: 40 })
  .filter((l) => !l.includes("\n") && !parsesAsObject(l));
const outcomeArb = fc.constantFrom<ProbeOutcome>("pass", "fail", "n/a");
const runArb = fc.record({
  observations: fc.array(observation, { maxLength: 5 }),
  outcome: outcomeArb,
  reason: fc.string({ maxLength: 60 }),
});

/** What the runner prints: the observations, then the one JSON line. */
const printed = (observations: readonly string[], line: string) =>
  `${[...observations, line].join("\n")}\n`;
const jsonLine = (outcome: string, reason: string) => JSON.stringify({ outcome, reason });

describe("a probe run as its runner reports it", () => {
  it("[probe-run.reads] reads back what the runner prints, with the exit its outcome comes with", () => {
    fc.assert(
      fc.property(runArb, ({ observations, outcome, reason }) => {
        expect(
          readProbeRun(printed(observations, jsonLine(outcome, reason)), PROBE_EXIT[outcome]),
        ).toEqual({ _tag: "ran", outcome, reason, observations });
      }),
    );
  });

  it("[probe-run.exit-agrees] calls a run whose exit disagrees with its outcome a harness error", () => {
    fc.assert(
      fc.property(
        runArb,
        fc.oneof(fc.integer({ min: -1, max: 255 }), fc.constant(undefined)),
        ({ observations, outcome, reason }, exit) => {
          fc.pre(exit !== PROBE_EXIT[outcome]);
          const run = readProbeRun(printed(observations, jsonLine(outcome, reason)), exit);
          expect(run._tag).toBe("harness-error");
        },
      ),
    );
  });

  it("[probe-run.one-json-line] calls a second JSON line, a JSON line not last, or other keys a harness error", () => {
    fc.assert(
      fc.property(
        runArb,
        fc.nat(),
        fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), { maxKeys: 3 }),
        ({ observations, outcome, reason }, at, extra) => {
          const line = jsonLine(outcome, reason);
          const exit = PROBE_EXIT[outcome];
          const second = [...observations];
          second.splice(at % (observations.length + 1), 0, JSON.stringify(extra));
          expect(readProbeRun(printed(second, line), exit)._tag).toBe("harness-error");
          expect(readProbeRun(`${printed(observations, line)}after\n`, exit)._tag).toBe(
            "harness-error",
          );
          const keyed = JSON.stringify({ outcome, reason, extra: 1 });
          expect(readProbeRun(printed(observations, keyed), exit)._tag).toBe("harness-error");
        },
      ),
    );
    expect(readProbeRun("no json at all\n", 0)._tag).toBe("harness-error");
    expect(readProbeRun(undefined, 0)._tag).toBe("harness-error");
    expect(readProbeRun(printed([], jsonLine("maybe", "x")), 0)._tag).toBe("harness-error");
  });

  it("[probe-run.na-never-passes] never reads an outcome other than the one printed, so n/a is never a pass", () => {
    fc.assert(
      fc.property(
        runArb,
        fc.integer({ min: 0, max: 4 }),
        ({ observations, outcome, reason }, exit) => {
          const run = readProbeRun(printed(observations, jsonLine(outcome, reason)), exit);
          // Read at all, it is read as printed, with the exit its outcome comes with.
          expect(
            run._tag === "harness-error" ||
              (run.outcome === outcome && exit === PROBE_EXIT[outcome]),
          ).toBe(true);
        },
      ),
    );
    expect(readProbeRun(printed(["x"], jsonLine("n/a", "revoke route absent")), 0)._tag).toBe(
      "harness-error",
    );
  });

  it("keeps the text of a harness error the runner reported, and refuses any other exit 2", () => {
    expect(
      readProbeRun(
        printed(
          [],
          jsonLine("fail", "probe harness error: expected exactly one probe test, found 0"),
        ),
        PROBE_HARNESS_EXIT,
      ),
    ).toEqual({
      _tag: "harness-error",
      reason: "expected exactly one probe test, found 0",
      observations: [],
    });
    expect(
      readProbeRun(printed([], jsonLine("pass", "probe harness error: x")), PROBE_HARNESS_EXIT),
    ).toMatchObject({ _tag: "harness-error", reason: expect.stringMatching(/^invalid JSON line/) });
    expect(readProbeRun(printed([], jsonLine("fail", "plain")), PROBE_HARNESS_EXIT)).toMatchObject({
      reason: expect.stringMatching(/^invalid JSON line: exit 2/),
    });
  });
});
