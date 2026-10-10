import { describe, expect, it } from "vitest";
import {
  judgeSuite,
  L1_SUITE_PLAN,
  parseSuiteOutput,
  SUITE_PROTOCOL,
  type SuiteOutput,
} from "../../../src/application/verification/index.ts";

const step = L1_SUITE_PLAN.steps[0];
if (step === undefined) throw new Error("the L1 plan has no step");

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A runner's stdout, built the way the suite command prints it. */
const stdout = (fields: Record<string, string>, extra: readonly string[] = []) =>
  [
    SUITE_PROTOCOL,
    ...Object.entries(fields).map(([k, v]) => `${k} ${v}`),
    ...extra,
    "KEEL_END",
    "",
  ].join("\n");

const ran = (exit: number, report = "H4sI"): Record<string, string> => ({
  KEEL_HYDRATION: "ok",
  KEEL_LOCK: "ok",
  KEEL_EXIT: String(exit),
  KEEL_DURATION_MS: "4321",
  KEEL_TAIL: b64("tail"),
  KEEL_REPORT: report,
});

type Test = { fullName: string; status: string; failureMessages?: string[] };
const report = (tests: readonly Test[], extra: Partial<Record<string, unknown>> = {}) => {
  const failed = tests.filter((t) => t.status === "failed").length;
  const passed = tests.filter((t) => t.status === "passed").length;
  return {
    success: failed === 0,
    numTotalTests: tests.length,
    numPassedTests: passed,
    numFailedTests: failed,
    testResults: [
      {
        name: "/workspace/test/a.test.ts",
        status: failed > 0 ? "failed" : "passed",
        assertionResults: tests,
      },
    ],
    ...extra,
  };
};

const pass = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ fullName: `t${i}`, status: "passed" }));
const output = (exit: number): SuiteOutput => ({
  _tag: "ran",
  exit,
  durationMs: 4321,
  tail: b64("tail"),
  report: "H4sI",
});
const judge = (o: SuiteOutput, r: unknown) => judgeSuite(step, o, { report: r, tail: "tail" });

describe("the suite runner's report", () => {
  it("reads a well-formed run", () => {
    expect(parseSuiteOutput(stdout(ran(1)))).toEqual({
      _tag: "ran",
      exit: 1,
      durationMs: 4321,
      tail: b64("tail"),
      report: "H4sI",
    });
    expect(parseSuiteOutput(stdout({ ...ran(0), KEEL_REPORT: "none" }))).toEqual({
      _tag: "ran",
      exit: 0,
      durationMs: 4321,
      tail: b64("tail"),
    });
  });

  it("reads the infra stops", () => {
    expect(parseSuiteOutput(stdout({ KEEL_HYDRATION: "failed hash-mismatch" }))).toEqual({
      _tag: "hydration-failed",
      reason: "hash-mismatch",
    });
    expect(parseSuiteOutput(stdout({ KEEL_HYDRATION: "ok", KEEL_LOCK: "diverged" }))._tag).toBe(
      "lockfile-diverged",
    );
  });

  it("calls anything else malformed: nothing, a missing marker, a duplicate, a forged value", () => {
    for (const text of [
      "",
      "KEEL_EXIT 0\n",
      stdout({ KEEL_HYDRATION: "ok" }),
      stdout(ran(0), ["KEEL_EXIT 0"]),
      stdout({ ...ran(0), KEEL_EXIT: "zero" }),
      stdout({ ...ran(0), KEEL_TAIL: "not base64!" }),
      stdout({ ...ran(0), KEEL_REPORT: "" }),
      `${stdout(ran(0))}${stdout(ran(0))}`,
    ])
      expect(parseSuiteOutput(text)._tag).toBe("malformed");
  });
});

describe("judging a suite run", () => {
  it("passes exit 0 with every test passing", () => {
    const j = judge(output(0), report(pass(200)));
    expect(j.report).toMatchObject({
      stepId: step.id,
      outcome: "pass",
      evidenceClass: "proof",
      durationMs: 4321,
    });
    expect(j.report.tier).toEqual(step.tier);
    expect(j.evidence.totals).toEqual({ total: 200, passed: 200, failed: 0 });
  });

  it("fails a non-zero exit whose report names the failures, and cites them", () => {
    const tests = [
      ...pass(3),
      { fullName: "sessions expire", status: "failed", failureMessages: ["expected 401"] },
    ];
    const j = judge(output(1), report(tests));
    expect(j.report.outcome).toBe("fail");
    expect(j.evidence.failing).toEqual([
      { file: "/workspace/test/a.test.ts", test: "sessions expire", message: "expected 401" },
    ]);
  });

  it("fails a test file that could not run at all", () => {
    const r = {
      success: false,
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      testResults: [
        { name: "a.test.ts", status: "passed", assertionResults: pass(3) },
        {
          name: "b.test.ts",
          status: "failed",
          message: "Cannot find module",
          assertionResults: [],
        },
      ],
    };
    const j = judge(output(1), r);
    expect(j.report.outcome).toBe("fail");
    expect(j.evidence.failing).toEqual([{ file: "b.test.ts", message: "Cannot find module" }]);
  });

  it("[suite.vacuous-abstains] abstains rather than pass on a missing, empty, unreadable or zero-test report", () => {
    for (const r of [undefined, {}, { success: true }, report([]), "not json at all", null])
      expect(judge(output(0), r).report).toMatchObject({ outcome: "abstain", failure: "schema" });
  });

  it("[suite.exit-agrees] abstains when the exit code and the report disagree", () => {
    expect(judge(output(1), report(pass(5))).report.outcome).toBe("abstain");
    expect(
      judge(output(0), report([...pass(2), { fullName: "x", status: "failed" }])).report.outcome,
    ).toBe("abstain");
    expect(judge(output(1), report(pass(5), { success: false })).report.outcome).toBe("abstain");
  });

  it("abstains on every infra stop, never deciding", () => {
    for (const o of [
      { _tag: "malformed", reason: "x" },
      { _tag: "hydration-failed", reason: "count-3-of-4" },
      { _tag: "lockfile-diverged" },
    ] satisfies SuiteOutput[])
      expect(judge(o, report(pass(10))).report.outcome).toBe("abstain");
  });
});
