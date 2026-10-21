import type { ContentHash } from "../../domain/kernel/index.ts";
import type { InfraFailure, PlanStep, StepTests } from "../../domain/verification/index.ts";
import { failingTestsOf, type JunitFailure, testCountsOf } from "./junit.ts";
import type { CredentialScan } from "./redact.ts";
import { MAX_FAILING } from "./suite.ts";
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
 * A step command of the project's own (`PlanStep.run`) run in Tier 2, as its
 * runner reports it on stdout, per the shared runner protocol
 * (`runner-output.ts`): after the hydration and deps markers, between
 * `KEEL_COMMAND/1` and `KEEL_END`:
 *
 *   KEEL_EXIT <n>                    the command's exit status
 *   KEEL_DURATION_MS <n>
 *   KEEL_TAIL <base64> | none        the last COMMAND_TAIL_LIMIT bytes of its output
 *   KEEL_REPORT <base64 of gzip>     the JUnit XML report the step names, only when it names one;
 *     | none missing | none too-large  or why there is none to read
 */
export const COMMAND_PROTOCOL = "KEEL_COMMAND/1";

/** How much of the end of a command's output the runner keeps, in bytes. */
export const COMMAND_TAIL_LIMIT = 4096;

/** The largest JUnit report the runner reads back, in bytes before compression. */
export const COMMAND_REPORT_LIMIT = 4 * 1024 * 1024;

/** Why a report the step names could not be read back from the box. */
export type ReportUnread = "missing" | "too-large";

export type CommandOutput =
  | RunnerStop
  | ({
      readonly _tag: "ran";
      readonly exit: number;
      readonly durationMs: number;
      /** The end of the command's output as base64, still encoded; absent when it printed nothing. */
      readonly tail?: string;
      /** The JUnit report the step names, as base64 of gzip, still encoded. */
      readonly report?: string;
      /** Why the report the step names was not there to read. */
      readonly reportUnread?: ReportUnread;
    } & Hydrated);

/** Reads the runner's stdout. Anything but exactly one well-formed run is `malformed`, which abstains. */
export const parseCommandOutput = (stdout: string): CommandOutput => {
  const opened = openRunnerOutput(stdout, COMMAND_PROTOCOL, "command");
  if (opened._tag !== "open") return opened;
  const { fields, hydrated } = opened;
  const ran = readExit(fields);
  if ("malformed" in ran) return { _tag: "malformed", reason: ran.malformed };
  const tail = fields.get("KEEL_TAIL");
  if (tail === undefined) return { _tag: "malformed", reason: "no KEEL_TAIL" };
  if (tail !== "none" && (tail.length === 0 || !BASE64.test(tail)))
    return { _tag: "malformed", reason: "bad KEEL_TAIL" };
  const report = reportOf(fields.get("KEEL_REPORT"));
  if (report === "malformed") return { _tag: "malformed", reason: "bad KEEL_REPORT" };
  return { _tag: "ran", ...ran, ...(tail === "none" ? {} : { tail }), ...report, ...hydrated };
};

/** The KEEL_REPORT marker read: nothing when the runner printed none, as for a step naming no report. */
const reportOf = (
  marker: string | undefined,
): { readonly report?: string; readonly reportUnread?: ReportUnread } | "malformed" => {
  if (marker === undefined) return {};
  if (marker === "none missing") return { reportUnread: "missing" };
  if (marker === "none too-large") return { reportUnread: "too-large" };
  // A gzip stream begins 1f 8b 08, which base64 writes as H4sI.
  return marker.startsWith("H4sI") && BASE64.test(marker) ? { report: marker } : "malformed";
};

/** What a command step stores as its evidence: its exit status and the end of its output. Redacted before it is stored. */
export interface CommandEvidence extends RunnerEvidence {
  /** The command's exit status, when it ran to one. */
  readonly exit?: number;
  /** On a fail, the tests the step's JUnit report says failed, the first MAX_FAILING of them. */
  readonly failing?: readonly JunitFailure[];
}

export type CommandJudgement = RunnerJudgement<CommandEvidence>;

/**
 * Judges one run of a project's own command by its exit status alone:
 * - `pass` is exit 0, counting the tests the JUnit report it names lists (none
 *   when that report was not written or does not read as one);
 * - `fail` is an exit from 1 to 127, citing the exit and the end of the output;
 * - everything else abstains: 128 and over (killed by a signal, which is the
 *   box's timeout or its memory, not the project's answer), an infra
 *   failure, or an output tail that did not decode.
 *
 * The doorway decodes what the runner encoded: `tail` is the end of the
 * command's output as text (undefined when it printed none, or it would not
 * decode), `diagnosis` a failed hydration's diagnosis, and `credentialScan`
 * its scan of all of that, raw, as for a suite. `resultRef` is set once the
 * evidence is stored.
 */
export const judgeCommand = (
  step: PlanStep,
  output: CommandOutput,
  decoded: {
    readonly tail: string | undefined;
    /** The step's JUnit report as text, when the runner sent one and it decoded. */
    readonly report?: string;
    readonly diagnosis?: string;
    readonly credentialScan?: CredentialScan;
  },
  resultRef?: ContentHash,
): CommandJudgement =>
  finishJudgement(
    judgeRun(step, output, decoded.tail, decoded.report, resultRef),
    output._tag === "ran" ? output : {},
    decoded,
  );

/**
 * What the JUnit report a step names says, whatever the command's exit: the
 * tests it counts, the failing tests it lists, and a clause for the why
 * saying what was read when it could not be.
 */
const reportRead = (
  path: string,
  output: { readonly reportUnread?: ReportUnread },
  report: string | undefined,
): {
  readonly clause: string;
  readonly tests?: StepTests;
  readonly failing?: readonly JunitFailure[];
} => {
  if (output.reportUnread === "missing")
    return { clause: `; its JUnit report ${path} was not written` };
  if (output.reportUnread === "too-large")
    return {
      clause: `; its JUnit report ${path} is over ${COMMAND_REPORT_LIMIT} bytes, so unread`,
    };
  const counts = report === undefined ? undefined : testCountsOf(report);
  const failing = report === undefined ? undefined : failingTestsOf(report);
  if (counts === undefined || failing === undefined)
    return { clause: `; its JUnit report ${path} did not read as JUnit XML` };
  const tests = { total: counts.total, passed: counts.passed };
  if (failing.length === 0)
    return { clause: `; its JUnit report ${path} names no failing test`, tests };
  return {
    clause: `; its JUnit report names ${failing.length} failing test${failing.length === 1 ? "" : "s"}`,
    tests,
    failing: failing.slice(0, MAX_FAILING),
  };
};

const judgeRun = (
  step: PlanStep,
  output: CommandOutput,
  text: string | undefined,
  report: string | undefined,
  resultRef?: ContentHash,
): CommandJudgement => {
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
    extra: { readonly exit?: number; readonly tail?: string } = {},
  ): CommandJudgement => ({
    report: { ...base, outcome: "abstain", failure, durationMs },
    evidence: { stepId: step.id, outcome: "abstain", why, tail: "", ...extra },
  });
  if (output._tag !== "ran") {
    const { failure, why } = stopped(output);
    return abstain(failure, why);
  }
  if (output.tail !== undefined && text === undefined)
    return abstain("schema", "the command's output did not decode", output.durationMs, {
      exit: output.exit,
    });
  const tail = text ?? "";
  const decide = (outcome: "pass" | "fail", why: string, tests?: StepTests): CommandJudgement => ({
    report: {
      ...base,
      outcome,
      durationMs: output.durationMs,
      ...(tests === undefined ? {} : { tests }),
    },
    evidence: { stepId: step.id, outcome, why, exit: output.exit, tail },
  });
  const named = step.run?.report;
  if (output.exit === 0) {
    if (named === undefined) return decide("pass", "the command exited 0");
    // A pass counts the tests its report names; one whose report cannot be read counted none.
    const read = reportRead(named.junit, output, report);
    return read.tests === undefined
      ? decide("pass", `the command exited 0${read.clause}, so no test was counted`, {
          total: 0,
          passed: 0,
        })
      : decide(
          "pass",
          `the command exited 0; its JUnit report counts ${read.tests.total} tests, ${read.tests.passed} passed`,
          read.tests,
        );
  }
  if (output.exit < 128) {
    if (named === undefined) return decide("fail", `the command exited ${output.exit}`);
    const read = reportRead(named.junit, output, report);
    const failed = decide("fail", `the command exited ${output.exit}${read.clause}`, read.tests);
    return read.failing === undefined
      ? failed
      : { ...failed, evidence: { ...failed.evidence, failing: read.failing } };
  }
  return abstain(
    "timeout",
    `the command was killed by signal ${output.exit - 128} (exit ${output.exit})`,
    output.durationMs,
    { exit: output.exit, tail },
  );
};
