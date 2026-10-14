import { describe, expect, it } from "vitest";
import {
  COMMAND_PROTOCOL,
  type CommandOutput,
  judgeCommand,
  parseCommandOutput,
} from "../../../src/application/verification/index.ts";
import type { PlanStep } from "../../../src/domain/verification/index.ts";

const step: PlanStep = {
  id: "keel.check",
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: [],
  tier: { tier: 2, reason: "a command of the project's own runs in a container" },
  because: "applies to every change",
  run: { command: "pnpm test", timeoutMs: 240_000 },
};

/** The command's stdout as the runner prints it, its lines between the protocol line and the end overridable. */
const stdout = (fields: Readonly<Record<string, string | undefined>> = {}): string =>
  [
    COMMAND_PROTOCOL,
    ...Object.entries({
      KEEL_HYDRATION: "ok",
      KEEL_DEPS: "ok",
      KEEL_EXIT: "0",
      KEEL_DURATION_MS: "1234",
      KEEL_TAIL: btoa("Tests 12 passed\n"),
      ...fields,
    }).flatMap(([marker, value]) => (value === undefined ? [] : [`${marker} ${value}`])),
    "KEEL_END",
    "",
  ].join("\n");

const judged = (output: CommandOutput, tail?: string) => judgeCommand(step, output, { tail });
const ran = (exit: number): CommandOutput => ({ _tag: "ran", exit, durationMs: 50 });

describe("a step command of the project's own, judged by its exit status", () => {
  it("[command.parse] reads the exit, the duration and the tail, and anything else is malformed", () => {
    expect(parseCommandOutput(stdout())).toEqual({
      _tag: "ran",
      exit: 0,
      durationMs: 1234,
      tail: btoa("Tests 12 passed\n"),
    });
    expect(parseCommandOutput(stdout({ KEEL_TAIL: "none" }))).toEqual({
      _tag: "ran",
      exit: 0,
      durationMs: 1234,
    });
    expect(parseCommandOutput(stdout({ KEEL_TAIL: undefined }))).toEqual({
      _tag: "malformed",
      reason: "no KEEL_TAIL",
    });
    expect(parseCommandOutput(stdout({ KEEL_TAIL: "not base64!" }))).toEqual({
      _tag: "malformed",
      reason: "bad KEEL_TAIL",
    });
    expect(parseCommandOutput(stdout({ KEEL_TAIL: "" }))).toEqual({
      _tag: "malformed",
      reason: "bad KEEL_TAIL",
    });
    expect(parseCommandOutput(stdout({ KEEL_EXIT: "-1" }))).toEqual({
      _tag: "malformed",
      reason: "bad KEEL_EXIT",
    });
    expect(parseCommandOutput(stdout({ KEEL_DEPS: "missing fetch-failed" }))).toEqual({
      _tag: "deps-missing",
      reason: "fetch-failed",
    });
    expect(parseCommandOutput(stdout().replace(COMMAND_PROTOCOL, "KEEL_SUITE/1"))._tag).toBe(
      "malformed",
    );
  });

  it("[command.judge] exit 0 passes, 1 to 127 fails citing the exit and the tail, and 128 and over abstains", () => {
    expect(judged(ran(0), "ok\n")).toEqual({
      report: {
        stepId: "keel.check",
        outcome: "pass",
        evidenceClass: "proof",
        tier: step.tier,
        durationMs: 50,
      },
      evidence: {
        stepId: "keel.check",
        outcome: "pass",
        why: "the command exited 0",
        exit: 0,
        tail: "ok\n",
      },
    });
    for (const exit of [1, 2, 127]) {
      const { report, evidence } = judged(ran(exit), "FAIL test/a.test.ts\n");
      expect([
        report.outcome,
        report.durationMs,
        evidence.why,
        evidence.exit,
        evidence.tail,
      ]).toEqual(["fail", 50, `the command exited ${exit}`, exit, "FAIL test/a.test.ts\n"]);
    }
    for (const [exit, signal] of [
      [128, 0],
      [137, 9],
      [143, 15],
    ] as const) {
      const { report, evidence } = judged(ran(exit), "Killed\n");
      expect([report.outcome, report.failure, evidence.why, evidence.exit, evidence.tail]).toEqual([
        "abstain",
        "timeout",
        `the command was killed by signal ${signal} (exit ${exit})`,
        exit,
        "Killed\n",
      ]);
    }
    // A command that printed nothing is judged on its exit alone.
    expect(judged(ran(0), undefined).evidence).toMatchObject({ outcome: "pass", tail: "" });
    expect(judged(ran(1), undefined).evidence).toMatchObject({ outcome: "fail", tail: "" });
  });

  it("[command.judge-abstains] a tail that did not decode, a failed hydration, missing deps and a malformed report decide nothing", () => {
    const undecoded = judged({ _tag: "ran", exit: 0, durationMs: 50, tail: "AAAA" }, undefined);
    expect([undecoded.report.outcome, undecoded.report.failure, undecoded.evidence.why]).toEqual([
      "abstain",
      "schema",
      "the command's output did not decode",
    ]);
    for (const output of [
      { _tag: "hydration-failed", reason: "hash-mismatch" },
      { _tag: "deps-missing", reason: "fetch-failed" },
      { _tag: "malformed", reason: "no KEEL_TAIL" },
    ] as const) {
      const { report, evidence } = judged(output);
      expect([output._tag, report.outcome]).toEqual([output._tag, "abstain"]);
      expect(evidence).not.toHaveProperty("exit");
    }
  });
});
