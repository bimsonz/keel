import { Option, Schema } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { InfraFailure, PlanStep, StepResult } from "../../domain/verification/index.ts";

/**
 * A project suite run in Tier 2, as its runner reports it on stdout. The suite
 * command always exits 0 (a non-zero exit would make @cloudflare/ci retry the
 * step in a fresh sandbox), so the real outcome travels in-band, one line per
 * marker, each exactly once, between `KEEL_SUITE/1` and `KEEL_END`:
 *
 *   KEEL_SUITE/1
 *   KEEL_HYDRATION ok | failed <reason>     the workspace matched the bundle manifest
 *   KEEL_LOCK ok | diverged                  the lockfile matched the baked dependencies
 *   KEEL_EXIT <n>                            the test runner's exit code
 *   KEEL_DURATION_MS <n>
 *   KEEL_TAIL <base64>                       the last bytes of the runner's console output
 *   KEEL_REPORT <base64 of gzip> | none      vitest's JSON report
 *   KEEL_END
 *
 * Values are base64 on one line, so nothing the tests print can forge a marker.
 */
export const SUITE_PROTOCOL = "KEEL_SUITE/1";

export type SuiteOutput =
  | { readonly _tag: "malformed"; readonly reason: string }
  | { readonly _tag: "hydration-failed"; readonly reason: string }
  | { readonly _tag: "lockfile-diverged" }
  | {
      readonly _tag: "ran";
      readonly exit: number;
      readonly durationMs: number;
      /** The console tail, base64; the doorway decodes it. */
      readonly tail: string;
      /** The report as base64 of gzip, still encoded; absent when the runner wrote none. */
      readonly report?: string;
    };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Reads the runner's stdout. Anything but exactly one well-formed run is `malformed`, which abstains. */
export const parseSuiteOutput = (stdout: string): SuiteOutput => {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const begin = lines.indexOf(SUITE_PROTOCOL);
  const end = lines.lastIndexOf("KEEL_END");
  if (begin === -1 || end === -1 || end < begin)
    return { _tag: "malformed", reason: "no suite report" };
  const body = lines.slice(begin + 1, end);
  const fields = new Map<string, string>();
  for (const line of body) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    if (!key.startsWith("KEEL_")) continue;
    if (fields.has(key) || key === "KEEL_SUITE/1" || key === "KEEL_END")
      return { _tag: "malformed", reason: `${key} appears twice` };
    fields.set(key, space === -1 ? "" : line.slice(space + 1));
  }
  if (lines.filter((l) => l === SUITE_PROTOCOL).length !== 1)
    return { _tag: "malformed", reason: "more than one suite report" };
  const hydration = fields.get("KEEL_HYDRATION");
  if (hydration === undefined) return { _tag: "malformed", reason: "no KEEL_HYDRATION" };
  if (hydration !== "ok")
    return {
      _tag: "hydration-failed",
      reason: hydration.startsWith("failed ") ? hydration.slice(7) : hydration,
    };
  const lock = fields.get("KEEL_LOCK");
  if (lock === "diverged") return { _tag: "lockfile-diverged" };
  if (lock !== "ok") return { _tag: "malformed", reason: "no KEEL_LOCK" };
  const exit = Number(fields.get("KEEL_EXIT"));
  const durationMs = Number(fields.get("KEEL_DURATION_MS"));
  if (!Number.isInteger(exit) || exit < 0) return { _tag: "malformed", reason: "bad KEEL_EXIT" };
  if (!Number.isFinite(durationMs) || durationMs < 0)
    return { _tag: "malformed", reason: "bad KEEL_DURATION_MS" };
  const tail = fields.get("KEEL_TAIL") ?? "";
  if (!BASE64.test(tail)) return { _tag: "malformed", reason: "bad KEEL_TAIL" };
  const report = fields.get("KEEL_REPORT");
  if (report === undefined) return { _tag: "malformed", reason: "no KEEL_REPORT" };
  if (report !== "none" && (report.length === 0 || !BASE64.test(report)))
    return { _tag: "malformed", reason: "bad KEEL_REPORT" };
  return { _tag: "ran", exit, durationMs, tail, ...(report === "none" ? {} : { report }) };
};

// ------------------------------------------------------------------ vitest's JSON report

const AssertionResult = Schema.Struct({
  fullName: Schema.String,
  status: Schema.String,
  failureMessages: Schema.optional(Schema.Array(Schema.String)),
});

const TestFileResult = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  message: Schema.optional(Schema.String),
  assertionResults: Schema.Array(AssertionResult),
});

/** The fields of vitest's `--reporter=json` output that a verdict rests on. */
export const VitestReport = Schema.Struct({
  success: Schema.Boolean,
  numTotalTests: Schema.Int,
  numPassedTests: Schema.Int,
  numFailedTests: Schema.Int,
  testResults: Schema.Array(TestFileResult),
});
export type VitestReport = typeof VitestReport.Type;

/** A failing test, or a test file that failed to run at all (`test` absent). */
export interface FailingTest {
  readonly file: string;
  readonly test?: string;
  readonly message: string;
}

/** What a suite step stores as its evidence: counts, failures, and the console tail. Redacted before it is stored. */
export interface SuiteEvidence {
  readonly stepId: string;
  readonly outcome: StepResult["outcome"];
  readonly why: string;
  readonly totals?: { readonly total: number; readonly passed: number; readonly failed: number };
  readonly failing: readonly FailingTest[];
  readonly tail: string;
}

/** How many failing tests the evidence names. The full report stays countable from `totals`. */
export const MAX_FAILING = 50;
const MAX_MESSAGE = 500;

const failingOf = (report: VitestReport): FailingTest[] =>
  report.testResults.flatMap((file) => {
    const tests = file.assertionResults
      .filter((a) => a.status === "failed")
      .map((a) => ({
        file: file.name,
        test: a.fullName,
        message: (a.failureMessages ?? []).join("\n").slice(0, MAX_MESSAGE),
      }));
    if (tests.length === 0 && file.status === "failed")
      return [
        { file: file.name, message: (file.message ?? "failed to run").slice(0, MAX_MESSAGE) },
      ];
    return tests;
  });

export interface SuiteJudgement {
  /** A result the verdict can use, with why it abstained when it did. */
  readonly report: StepResult & { readonly failure?: InfraFailure };
  readonly evidence: SuiteEvidence;
}

/**
 * Judges one suite run. Only a run that hydrated, ran tests, and agrees with
 * itself decides:
 * - `pass` needs exit 0, a successful report, at least one passing test and none failing (skips are allowed);
 * - `fail` needs a non-zero exit and a report that names a failure;
 * - everything else abstains: an infra failure (hydration, lockfile, a missing
 *   or unreadable report), no tests at all, or an exit code the report contradicts.
 *
 * The doorway decodes what the runner encoded: `report` is the report's JSON
 * (undefined when there was none, or it would not decode) and `tail` the
 * console tail as text. `resultRef` is set once the evidence is stored.
 */
export const judgeSuite = (
  step: PlanStep,
  output: SuiteOutput,
  decoded: { readonly report: unknown; readonly tail: string },
  resultRef?: ContentHash,
): SuiteJudgement => {
  const base = {
    stepId: step.id,
    evidenceClass: step.evidenceCeiling,
    tier: step.tier,
    ...(resultRef === undefined ? {} : { resultRef }),
  };
  const abstain = (
    failure: InfraFailure,
    why: string,
    durationMs = 0,
    tail = "",
  ): SuiteJudgement => ({
    report: { ...base, outcome: "abstain", failure, durationMs },
    evidence: { stepId: step.id, outcome: "abstain", why, failing: [], tail },
  });
  switch (output._tag) {
    case "malformed":
      return abstain("schema", `the runner's output is malformed: ${output.reason}`);
    case "hydration-failed":
      return abstain("unavailable", `hydration-failed: ${output.reason}`);
    case "lockfile-diverged":
      return abstain("unavailable", "lockfile-diverged: the baked dependencies do not match");
    default:
      break;
  }
  const { report, tail } = decoded;
  const parsed =
    report === undefined ? Option.none() : Schema.decodeUnknownOption(VitestReport)(report);
  if (Option.isNone(parsed))
    return abstain(
      "schema",
      report === undefined ? "no test report" : "the test report is not vitest's JSON",
      output.durationMs,
      tail,
    );
  const r = parsed.value;
  const failing = failingOf(r);
  const totals = { total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests };
  const decide = (outcome: "pass" | "fail", why: string): SuiteJudgement => ({
    report: { ...base, outcome, durationMs: output.durationMs },
    evidence: {
      stepId: step.id,
      outcome,
      why,
      totals,
      failing: failing.slice(0, MAX_FAILING),
      tail,
    },
  });
  if (r.numTotalTests === 0 || r.testResults.length === 0)
    return abstain("schema", "the suite ran no tests", output.durationMs, tail);
  const clean = r.success && r.numFailedTests === 0 && failing.length === 0 && r.numPassedTests > 0;
  if (output.exit === 0 && clean) return decide("pass", `${r.numPassedTests} tests passed`);
  if (output.exit !== 0 && !r.success && failing.length > 0)
    return decide(
      "fail",
      `${failing.length} failing (${r.numFailedTests} of ${r.numTotalTests} tests failed)`,
    );
  return abstain(
    "schema",
    `exit ${output.exit} contradicts the report (success ${r.success}, ${r.numFailedTests} failed)`,
    output.durationMs,
    tail,
  );
};
