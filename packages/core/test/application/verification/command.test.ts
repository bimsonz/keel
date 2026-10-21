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
/** A JUnit report in which these tests fail and one other passes. */
const xml = (...names: readonly string[]) =>
  `<testsuites><testsuite>${names
    .map((n) => `<testcase classname="test/a.test.ts" name="${n}"><failure/></testcase>`)
    .join("")}<testcase classname="test/a.test.ts" name="passes"/></testsuite></testsuites>`;
const unread = (reportUnread: "missing" | "too-large", exit = 2): CommandOutput => ({
  _tag: "ran",
  exit,
  durationMs: 50,
  reportUnread,
});

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

  it("[command.parse-report] reads the report marker when the runner prints one, and anything but a report or why there is none is malformed", () => {
    const at = { _tag: "ran", exit: 0, durationMs: 1234, tail: btoa("Tests 12 passed\n") };
    expect(parseCommandOutput(stdout({ KEEL_REPORT: "H4sIAAAA" }))).toEqual({
      ...at,
      report: "H4sIAAAA",
    });
    expect(parseCommandOutput(stdout({ KEEL_REPORT: "none missing" }))).toEqual({
      ...at,
      reportUnread: "missing",
    });
    expect(parseCommandOutput(stdout({ KEEL_REPORT: "none too-large" }))).toEqual({
      ...at,
      reportUnread: "too-large",
    });
    for (const marker of ["none", "none other", "not base64!", "", "AAAA", "H4sI!"])
      expect({ marker, read: parseCommandOutput(stdout({ KEEL_REPORT: marker })) }).toEqual({
        marker,
        read: { _tag: "malformed", reason: "bad KEEL_REPORT" },
      });
  });

  it("[command.judge-report] a fail cites the tests its JUnit report says failed, and says why when it cannot", () => {
    const named: PlanStep = {
      ...step,
      run: { command: "pnpm test", timeoutMs: 240_000, report: { junit: "out/junit.xml" } },
    };
    const judge = (output: CommandOutput, report: string | undefined, at: PlanStep = named) =>
      judgeCommand(at, output, { tail: "FAIL\n", ...(report === undefined ? {} : { report }) })
        .evidence;
    expect(judge(ran(1), xml("a > breaks", "b"))).toMatchObject({
      outcome: "fail",
      why: "the command exited 1; its JUnit report names 2 failing tests",
      failing: [
        { file: "test/a.test.ts", test: "a > breaks" },
        { file: "test/a.test.ts", test: "b" },
      ],
    });
    expect(judge(ran(1), xml("only")).why).toBe(
      "the command exited 1; its JUnit report names 1 failing test",
    );
    const many = judge(ran(1), xml(...Array.from({ length: 60 }, (_, i) => `t${i}`)));
    expect([many.why, many.failing?.length, many.failing?.[49]?.test]).toEqual([
      "the command exited 1; its JUnit report names 60 failing tests",
      50,
      "t49",
    ]);
    for (const [output, report, why] of [
      [unread("missing"), undefined, "its JUnit report out/junit.xml was not written"],
      [
        unread("too-large"),
        undefined,
        "its JUnit report out/junit.xml is over 4194304 bytes, so unread",
      ],
      [ran(2), "not xml", "its JUnit report out/junit.xml did not read as JUnit XML"],
      [ran(2), undefined, "its JUnit report out/junit.xml did not read as JUnit XML"],
      [ran(2), xml(), "its JUnit report out/junit.xml names no failing test"],
    ] as const) {
      const evidence = judge(output, report);
      expect([evidence.outcome, evidence.why, evidence.failing]).toEqual([
        "fail",
        `the command exited 2; ${why}`,
        undefined,
      ]);
    }
    // The exit decides: a pass cites no failing test, only counts its report, and a step that names none never cites one.
    expect(judge(ran(0), xml("a"))).not.toHaveProperty("failing");
    expect(judge(ran(0), xml("a")).why).toBe(
      "the command exited 0; its JUnit report counts 2 tests, 1 passed",
    );
    expect(judge(ran(1), xml("a"), step)).toMatchObject({ why: "the command exited 1" });
    expect(judge(ran(1), xml("a"), step)).not.toHaveProperty("failing");
    expect(judge(ran(137), xml("a")).outcome).toBe("abstain");
    expect(judge(ran(137), xml("a"))).not.toHaveProperty("failing");
  });

  it("[command.counts] a pass counts the tests its JUnit report names, and none when the report was not written or does not read; a step naming no report, and an abstain, count nothing", () => {
    const named: PlanStep = {
      ...step,
      run: { command: "pnpm test", timeoutMs: 240_000, report: { junit: "out/junit.xml" } },
    };
    const judge = (output: CommandOutput, report: string | undefined, at: PlanStep = named) =>
      judgeCommand(at, output, { tail: "ok\n", ...(report === undefined ? {} : { report }) });
    const passing = `<testsuites><testsuite><testcase name="a"/><testcase name="b"/><testcase name="c"><skipped/></testcase></testsuite></testsuites>`;
    expect(judge(ran(0), passing).report).toMatchObject({
      outcome: "pass",
      tests: { total: 3, passed: 2 },
    });
    for (const [output, report, why] of [
      [unread("missing", 0), undefined, "out/junit.xml was not written"],
      [unread("too-large", 0), undefined, "out/junit.xml is over 4194304 bytes, so unread"],
      [ran(0), "not xml", "out/junit.xml did not read as JUnit XML"],
    ] as const) {
      const got = judge(output, report);
      expect([got.report.outcome, got.report.tests, got.evidence.why]).toEqual([
        "pass",
        { total: 0, passed: 0 },
        `the command exited 0; its JUnit report ${why}, so no test was counted`,
      ]);
    }
    expect(judge(ran(1), xml("a", "b")).report.tests).toEqual({ total: 3, passed: 1 });
    expect(judge(ran(0), passing, step).report).not.toHaveProperty("tests");
    expect(judge(ran(137), passing).report).not.toHaveProperty("tests");
  });
});
