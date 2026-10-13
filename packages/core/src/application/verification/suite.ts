import { Option, Schema } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { InfraFailure, PlanStep } from "../../domain/verification/index.ts";
import type { CredentialScan } from "./redact.ts";
import {
  BASE64,
  finishJudgement,
  type Hydrated,
  openRunnerOutput,
  readExit,
  type RunnerEvidence,
  type RunnerJudgement,
  type RunnerStop,
  stopped,
} from "./runner-output.ts";

/**
 * A project suite run in Tier 2, as its runner reports it on stdout, per the
 * shared runner protocol (`runner-output.ts`): after the hydration and deps
 * markers, between `KEEL_SUITE/1` and `KEEL_END`:
 *
 *   KEEL_EXIT <n>                            the test runner's exit code
 *   KEEL_DURATION_MS <n>
 *   KEEL_TAIL <base64>                       the last bytes of the runner's console output
 *   KEEL_REPORT <base64 of gzip> | none      vitest's JSON report
 */
export const SUITE_PROTOCOL = "KEEL_SUITE/1";

export type SuiteOutput =
  | RunnerStop
  | ({
      readonly _tag: "ran";
      readonly exit: number;
      readonly durationMs: number;
      /** The console tail, base64; the doorway decodes it. */
      readonly tail: string;
      /** The report as base64 of gzip, still encoded; absent when the runner wrote none. */
      readonly report?: string;
    } & Hydrated);

/** Reads the runner's stdout. Anything but exactly one well-formed run is `malformed`, which abstains. */
export const parseSuiteOutput = (stdout: string): SuiteOutput => {
  const opened = openRunnerOutput(stdout, SUITE_PROTOCOL, "suite");
  if (opened._tag !== "open") return opened;
  const { fields, hydrated } = opened;
  const ran = readExit(fields);
  if ("malformed" in ran) return { _tag: "malformed", reason: ran.malformed };
  const tail = fields.get("KEEL_TAIL") ?? "";
  if (!BASE64.test(tail)) return { _tag: "malformed", reason: "bad KEEL_TAIL" };
  const report = fields.get("KEEL_REPORT");
  if (report === undefined) return { _tag: "malformed", reason: "no KEEL_REPORT" };
  if (report !== "none" && (report.length === 0 || !BASE64.test(report)))
    return { _tag: "malformed", reason: "bad KEEL_REPORT" };
  return {
    _tag: "ran",
    ...ran,
    tail,
    ...(report === "none" ? {} : { report }),
    ...hydrated,
  };
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
export interface SuiteEvidence extends RunnerEvidence {
  readonly totals?: { readonly total: number; readonly passed: number; readonly failed: number };
  readonly failing: readonly FailingTest[];
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

export type SuiteJudgement = RunnerJudgement<SuiteEvidence>;

/**
 * Judges one suite run. Only a run that hydrated, ran tests, and agrees with
 * itself decides:
 * - `pass` needs exit 0, a successful report, at least one passing test and none failing (skips are allowed);
 * - `fail` needs a non-zero exit and a report that names a failure;
 * - everything else abstains: an infra failure (hydration, deps, a missing
 *   or unreadable report), no tests at all, or an exit code the report contradicts.
 *
 * The doorway decodes what the runner encoded: `report` is the report's JSON
 * (undefined when there was none, or it would not decode), `tail` the console
 * tail as text, and `diagnosis` a failed hydration's diagnosis as text.
 * `credentialScan` is its scan of all of that, raw: any hit abstains as
 * `credential-leak`, whatever the tests did, and the counts are kept in the
 * evidence either way. `resultRef` is set once the evidence is stored.
 */
export const judgeSuite = (
  step: PlanStep,
  output: SuiteOutput,
  decoded: {
    readonly report: unknown;
    readonly tail: string;
    readonly diagnosis?: string;
    readonly credentialScan?: CredentialScan;
  },
  resultRef?: ContentHash,
): SuiteJudgement =>
  finishJudgement(
    judgeRun(step, output, decoded, resultRef),
    output._tag === "ran" ? output : {},
    decoded,
  );

const judgeRun = (
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
  if (output._tag !== "ran") {
    const { failure, why } = stopped(output);
    return abstain(failure, why);
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
