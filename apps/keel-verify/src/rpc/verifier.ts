import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** What a VerifierDO reports when a job ends: every step's result, as runner-protocol `StepFinished` messages. */
export const JobReport = Schema.Struct({
  jobId: Schema.NonEmptyString,
  outcome: Schema.Literals(["completed", "infra-failure", "budget-exhausted"]),
  steps: Schema.Array(Schema.Unknown),
});

export const VerifierCodecs = {
  run: exitCodec(JobReport, VerifierUnavailable),
};

/**
 * A VerifierDO in keel-verify: one per world, running throwaway isolates with
 * no outbound network. Its argument is a runner-protocol `JobSubmitted`,
 * encoded. keel-verify holds no credentials, so nothing it runs can reach any.
 */
export interface VerifierRpc {
  run(job: unknown): Promise<ExitJson>;
}
