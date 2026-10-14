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
 * A step command of the project's own (`PlanStep.run`) run in Tier 2, as its
 * runner reports it on stdout, per the shared runner protocol
 * (`runner-output.ts`): after the hydration and deps markers, between
 * `KEEL_COMMAND/1` and `KEEL_END`:
 *
 *   KEEL_EXIT <n>                    the command's exit status
 *   KEEL_DURATION_MS <n>
 *   KEEL_TAIL <base64> | none        the last COMMAND_TAIL_LIMIT bytes of its output
 */
export const COMMAND_PROTOCOL = "KEEL_COMMAND/1";

/** How much of the end of a command's output the runner keeps, in bytes. */
export const COMMAND_TAIL_LIMIT = 4096;

export type CommandOutput =
  | RunnerStop
  | ({
      readonly _tag: "ran";
      readonly exit: number;
      readonly durationMs: number;
      /** The end of the command's output as base64, still encoded; absent when it printed nothing. */
      readonly tail?: string;
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
  return { _tag: "ran", ...ran, ...(tail === "none" ? {} : { tail }), ...hydrated };
};

/** What a command step stores as its evidence: its exit status and the end of its output. Redacted before it is stored. */
export interface CommandEvidence extends RunnerEvidence {
  /** The command's exit status, when it ran to one. */
  readonly exit?: number;
}

export type CommandJudgement = RunnerJudgement<CommandEvidence>;

/**
 * Judges one run of a project's own command by its exit status alone:
 * - `pass` is exit 0;
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
    readonly diagnosis?: string;
    readonly credentialScan?: CredentialScan;
  },
  resultRef?: ContentHash,
): CommandJudgement =>
  finishJudgement(
    judgeRun(step, output, decoded.tail, resultRef),
    output._tag === "ran" ? output : {},
    decoded,
  );

const judgeRun = (
  step: PlanStep,
  output: CommandOutput,
  text: string | undefined,
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
  const decide = (outcome: "pass" | "fail", why: string): CommandJudgement => ({
    report: { ...base, outcome, durationMs: output.durationMs },
    evidence: { stepId: step.id, outcome, why, exit: output.exit, tail },
  });
  if (output.exit === 0) return decide("pass", "the command exited 0");
  if (output.exit < 128) return decide("fail", `the command exited ${output.exit}`);
  return abstain(
    "timeout",
    `the command was killed by signal ${output.exit - 128} (exit ${output.exit})`,
    output.durationMs,
    { exit: output.exit, tail },
  );
};
