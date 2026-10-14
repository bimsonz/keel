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
import { MAX_FAILING } from "./suite.ts";

/**
 * The worker-app typecheck run in Tier 2, as its runner reports it on stdout,
 * per the shared runner protocol (`runner-output.ts`): after the hydration and
 * deps markers, between `KEEL_TYPECHECK/1` and `KEEL_END`:
 *
 *   KEEL_TSCONFIG ok | none                  the candidate has a tsconfig.json at its root
 *   KEEL_EXIT <n>                            tsc's exit code
 *   KEEL_DURATION_MS <n>
 *   KEEL_OUTPUT_BYTES <n>                    the size of tsc's whole output
 *   KEEL_OUTPUT <base64 of gzip> | none      its first TYPECHECK_OUTPUT_LIMIT bytes
 *
 * Only `ok` is followed by the rest.
 */
export const TYPECHECK_PROTOCOL = "KEEL_TYPECHECK/1";

/**
 * How much of tsc's output the runner keeps. Gzipped and base64'd it stays
 * well under the engine's 300 kB log limit, even when it does not compress.
 */
export const TYPECHECK_OUTPUT_LIMIT = 131_072;

export type TypecheckOutput =
  | RunnerStop
  | { readonly _tag: "no-tsconfig" }
  | ({
      readonly _tag: "ran";
      readonly exit: number;
      readonly durationMs: number;
      /** The size of tsc's whole output; more than TYPECHECK_OUTPUT_LIMIT means `output` is cut short. */
      readonly outputBytes: number;
      /** tsc's output as base64 of gzip, still encoded; absent when it printed nothing. */
      readonly output?: string;
    } & Hydrated);

/** Reads the runner's stdout. Anything but exactly one well-formed run is `malformed`, which abstains. */
export const parseTypecheckOutput = (stdout: string): TypecheckOutput => {
  const opened = openRunnerOutput(stdout, TYPECHECK_PROTOCOL, "typecheck");
  if (opened._tag !== "open") return opened;
  const { fields, hydrated } = opened;
  const tsconfig = fields.get("KEEL_TSCONFIG");
  if (tsconfig === "none") return { _tag: "no-tsconfig" };
  if (tsconfig !== "ok") return { _tag: "malformed", reason: "no KEEL_TSCONFIG" };
  const ran = readExit(fields);
  if ("malformed" in ran) return { _tag: "malformed", reason: ran.malformed };
  const outputBytes = Number(fields.get("KEEL_OUTPUT_BYTES"));
  if (!Number.isInteger(outputBytes) || outputBytes < 0)
    return { _tag: "malformed", reason: "bad KEEL_OUTPUT_BYTES" };
  const output = fields.get("KEEL_OUTPUT");
  if (output === undefined) return { _tag: "malformed", reason: "no KEEL_OUTPUT" };
  if (output !== "none" && (output.length === 0 || !BASE64.test(output)))
    return { _tag: "malformed", reason: "bad KEEL_OUTPUT" };
  return {
    _tag: "ran",
    ...ran,
    outputBytes,
    ...(output === "none" ? {} : { output }),
    ...hydrated,
  };
};

/** One error tsc reported: where, when it names a place, its code, and its message. */
export interface TscDiagnostic {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly code: string;
  readonly message: string;
}

const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const UNLOCATED = /^error (TS\d+): (.*)$/;
const REPORTED = /error TS/;
const MAX_MESSAGE = 500;

/**
 * Reads tsc's `--pretty false` output: one diagnostic per `error TS` line,
 * with the indented lines after it folded into its message. `reported` counts
 * every line that mentions an error at all, read or not, so output in a shape
 * this reader does not know can never pass.
 */
export const readDiagnostics = (
  text: string,
): { readonly diagnostics: readonly TscDiagnostic[]; readonly reported: number } => {
  const diagnostics: TscDiagnostic[] = [];
  let reported = 0;
  for (const line of text.split("\n")) {
    if (REPORTED.test(line)) reported += 1;
    const located = LOCATED.exec(line);
    if (located !== null) {
      const [, file = "", row = "", column = "", code = "", message = ""] = located;
      diagnostics.push({
        file,
        line: Number(row),
        column: Number(column),
        code,
        message: message.slice(0, MAX_MESSAGE),
      });
      continue;
    }
    const unlocated = UNLOCATED.exec(line);
    if (unlocated !== null) {
      const [, code = "", message = ""] = unlocated;
      diagnostics.push({ code, message: message.slice(0, MAX_MESSAGE) });
      continue;
    }
    const last = diagnostics.at(-1);
    if (last !== undefined && /^\s+\S/.test(line))
      diagnostics[diagnostics.length - 1] = {
        ...last,
        message: `${last.message}\n${line.trim()}`.slice(0, MAX_MESSAGE),
      };
  }
  return { diagnostics, reported };
};

/** A diagnostic as a verdict cites it: `src/a.ts:12:5 TS2322 Type 'string' is not…`. */
export const citeDiagnostic = (d: TscDiagnostic): string => {
  const where = d.file === undefined ? "" : `${d.file}:${d.line ?? 0}:${d.column ?? 0} `;
  const first = d.message.split("\n")[0] ?? "";
  return `${where}${d.code} ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`;
};

/** What a typecheck step stores as its evidence: the errors tsc named, and the end of its output. Redacted before it is stored. */
export interface TypecheckEvidence extends RunnerEvidence {
  /** The first MAX_FAILING errors, in tsc's order. */
  readonly errors: readonly TscDiagnostic[];
  /** How many errors the kept output names. */
  readonly errorCount?: number;
  /** tsc printed more than the runner kept, so there may be more errors than `errorCount`. */
  readonly truncated?: boolean;
  /** The configuration the step needs and the candidate does not have, with what to do about it. */
  readonly config?: { readonly missing: string; readonly remedy: string };
}

/** What a worker app with no tsconfig.json at its root is told to do: the bounce cites it. */
export const TSCONFIG_REMEDY =
  "the typecheck step runs the project's own tsc --noEmit with the tsconfig.json at the repository's root, and there is none: add one that includes the Worker's sources, and commit it";

export type TypecheckJudgement = RunnerJudgement<TypecheckEvidence>;

/**
 * Judges one typecheck run. Only a run that hydrated, found a tsconfig and
 * agrees with itself decides:
 * - `pass` needs exit 0 and no line of output that reports an error;
 * - `fail` needs a non-zero exit and at least one error read, each cited, or
 *   a candidate with no tsconfig.json at its root: that fails as missing
 *   configuration (`config`, with what to add), never as an infra failure, so
 *   the change bounces at once rather than parking on every round;
 * - everything else abstains: an infra failure, output that did not decode,
 *   or an exit code the output contradicts (a crash, a usage error, errors in
 *   a shape tsc does not print with `--pretty false`).
 *
 * The doorway decodes what the runner encoded: `output` is tsc's output as
 * text (undefined when it printed none, or it would not decode), `diagnosis`
 * a failed hydration's diagnosis. `credentialScan` is its scan of all of that,
 * raw, as for a suite. `resultRef` is set once the evidence is stored.
 */
export const judgeTypecheck = (
  step: PlanStep,
  output: TypecheckOutput,
  decoded: {
    readonly output: string | undefined;
    readonly diagnosis?: string;
    readonly credentialScan?: CredentialScan;
  },
  resultRef?: ContentHash,
): TypecheckJudgement =>
  finishJudgement(
    judgeRun(step, output, decoded.output, resultRef),
    output._tag === "ran" ? output : {},
    decoded,
  );

const judgeRun = (
  step: PlanStep,
  output: TypecheckOutput,
  text: string | undefined,
  resultRef?: ContentHash,
): TypecheckJudgement => {
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
  ): TypecheckJudgement => ({
    report: { ...base, outcome: "abstain", failure, durationMs },
    evidence: { stepId: step.id, outcome: "abstain", why, errors: [], tail },
  });
  if (output._tag === "no-tsconfig")
    return {
      report: { ...base, outcome: "fail", durationMs: 0 },
      evidence: {
        stepId: step.id,
        outcome: "fail",
        why: "no tsconfig.json at the candidate's root",
        errors: [],
        tail: "",
        config: { missing: "tsconfig.json", remedy: TSCONFIG_REMEDY },
      },
    };
  if (output._tag !== "ran") {
    const { failure, why } = stopped(output);
    return abstain(failure, why);
  }
  if (output.output !== undefined && text === undefined)
    return abstain("schema", "tsc's output did not decode", output.durationMs);
  const printed = text ?? "";
  const tail = printed.slice(-4096);
  const { diagnostics, reported } = readDiagnostics(printed);
  const truncated = output.outputBytes > TYPECHECK_OUTPUT_LIMIT;
  const decide = (outcome: "pass" | "fail", why: string): TypecheckJudgement => ({
    report: { ...base, outcome, durationMs: output.durationMs },
    evidence: {
      stepId: step.id,
      outcome,
      why,
      errors: diagnostics.slice(0, MAX_FAILING),
      errorCount: diagnostics.length,
      ...(truncated ? { truncated } : {}),
      tail,
    },
  });
  if (output.exit === 0 && reported === 0) return decide("pass", "tsc reported no errors");
  if (output.exit !== 0 && diagnostics.length > 0)
    return decide(
      "fail",
      `${diagnostics.length}${truncated ? "+" : ""} type error${diagnostics.length === 1 ? "" : "s"}`,
    );
  return abstain(
    "schema",
    `exit ${output.exit} contradicts tsc's output (${diagnostics.length} errors read, ${reported} reported)`,
    output.durationMs,
    tail,
  );
};
