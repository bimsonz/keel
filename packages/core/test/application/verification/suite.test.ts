import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  JS_TS_SUITE_PACK,
  judgeSuite,
  parseSuiteOutput,
  SUITE_PROTOCOL,
  type SuiteOutput,
} from "../../../src/application/verification/index.ts";
import { CommitSha } from "../../../src/domain/kernel/index.ts";
import { compile } from "../../../src/domain/verification/index.ts";

const step = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: CommitSha.make("a".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    JS_TS_SUITE_PACK,
  ),
).steps[0];
if (step === undefined) throw new Error("the js-ts plan has no step");

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
  KEEL_DEPS: "ok",
  KEEL_VITEST: "ok",
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
    expect(
      parseSuiteOutput(
        stdout({ KEEL_HYDRATION_DIFF: b64("entry 3 c.bin missing"), KEEL_HYDRATION: "failed x" }),
      ),
    ).toEqual({ _tag: "hydration-failed", reason: "x", diagnosis: b64("entry 3 c.bin missing") });
    expect(
      parseSuiteOutput(
        stdout({
          ...ran(0),
          KEEL_HYDRATION_RETRIED: "hash-mismatch",
          KEEL_HYDRATION_DIFF: b64("entry 3 c.bin missing"),
        }),
      ),
    ).toMatchObject({
      _tag: "ran",
      rehydrated: "hash-mismatch",
      diagnosis: b64("entry 3 c.bin missing"),
    });
    // A diagnosis that is not base64 is dropped, never a reason to misread the stop.
    expect(
      parseSuiteOutput(stdout({ KEEL_HYDRATION_DIFF: "not base64!", KEEL_HYDRATION: "failed x" })),
    ).toEqual({ _tag: "hydration-failed", reason: "x" });
  });

  it("[runner.deps-marker] reads deps that did not arrive as a stop with the box's reason, and goes ahead only on ok", () => {
    for (const reason of ["part-hash-mismatch", "fetch-failed", "no-parts", "extract-failed"])
      expect(
        parseSuiteOutput(stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: `missing ${reason}` })),
      ).toEqual({ _tag: "deps-missing", reason });
    // The run's own markers after it change nothing: nothing ran on missing deps.
    expect(parseSuiteOutput(stdout({ ...ran(0), KEEL_DEPS: "missing fetch-failed" }))).toEqual({
      _tag: "deps-missing",
      reason: "fetch-failed",
    });
    // A workspace that did not hydrate is that stop, whatever the deps marker says.
    expect(
      parseSuiteOutput(stdout({ KEEL_HYDRATION: "failed hash-mismatch", KEEL_DEPS: "ok" })),
    ).toEqual({ _tag: "hydration-failed", reason: "hash-mismatch" });
    const unmarked = Object.fromEntries(
      Object.entries(ran(0)).filter(([name]) => name !== "KEEL_DEPS"),
    );
    expect(parseSuiteOutput(stdout(unmarked))).toEqual({
      _tag: "malformed",
      reason: "no KEEL_DEPS",
    });
    for (const value of ["", "missing", "diverged", "OK", "ok "])
      expect(parseSuiteOutput(stdout({ ...ran(0), KEEL_DEPS: value }))).toEqual({
        _tag: "malformed",
        reason: "bad KEEL_DEPS",
      });
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
      { _tag: "deps-missing", reason: "part-hash-mismatch" },
    ] satisfies SuiteOutput[])
      expect(judge(o, report(pass(10))).report.outcome).toBe("abstain");
  });

  it("[runner.deps-unavailable] abstains as unavailable on missing deps, with the reason, whatever report came with it", () => {
    const j = judge({ _tag: "deps-missing", reason: "part-hash-mismatch" }, report(pass(10)));
    expect(j.report).toMatchObject({ outcome: "abstain", failure: "unavailable", durationMs: 0 });
    expect(j.evidence).toMatchObject({
      outcome: "abstain",
      why: "deps-unavailable: part-hash-mismatch",
      failing: [],
    });
  });

  it("keeps a failed hydration's diagnosis in its evidence, and only there", () => {
    const hydration = { _tag: "hydration-failed", reason: "hash-mismatch" } as const;
    const kept = judgeSuite(step, hydration, { report: undefined, tail: "", diagnosis: "entry 3" });
    expect(kept.report.outcome).toBe("abstain");
    expect(kept.evidence).toMatchObject({
      why: "hydration-failed: hash-mismatch",
      diagnosis: "entry 3",
    });
    expect(
      judgeSuite(step, hydration, { report: undefined, tail: "" }).evidence,
    ).not.toHaveProperty("diagnosis");
  });

  it("keeps a rehydrated run's first failure and its diagnosis in the evidence, beside its outcome", () => {
    const rehydrated = { ...output(0), rehydrated: "hash-mismatch" };
    const judged = judgeSuite(step, rehydrated, {
      report: report(pass(5)),
      tail: "tail",
      diagnosis: "entry 3",
    });
    expect(judged.report.outcome).toBe("pass");
    expect(judged.evidence).toMatchObject({ rehydrated: "hash-mismatch", diagnosis: "entry 3" });
  });

  it("[suite.no-vitest] fails a candidate with no vitest installed as its dependencies refused, with what to do, never as a red suite; a run with no report still abstains", () => {
    const parsed = parseSuiteOutput(
      stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: "ok", KEEL_VITEST: "none" }),
    );
    expect(parsed).toEqual({ _tag: "no-vitest" });
    const withoutMarker = Object.fromEntries(
      Object.entries(ran(0)).filter(([name]) => name !== "KEEL_VITEST"),
    );
    expect(parseSuiteOutput(stdout(withoutMarker))).toEqual({
      _tag: "malformed",
      reason: "no KEEL_VITEST",
    });
    const judged = judgeSuite(step, parsed, { report: undefined, tail: "" });
    expect(judged.report).toEqual({
      stepId: step.id,
      outcome: "fail",
      evidenceClass: step.evidenceCeiling,
      tier: step.tier,
      durationMs: 0,
    });
    expect(judged.evidence).toEqual({
      stepId: step.id,
      outcome: "fail",
      why: "deps-refused: no-vitest",
      failing: [],
      tail: "",
      deps: {
        refused: "no-vitest",
        remedy:
          "the js-ts suite runs vitest from the repository's own dependencies, and they have none: add vitest as a devDependency, with at least one test, and commit the pnpm-lock.yaml",
      },
    });
    // vitest was there and wrote no report (a crash mid-run): that is still nobody's to fix.
    expect(judge(output(1), undefined).report.outcome).toBe("abstain");
  });
});
