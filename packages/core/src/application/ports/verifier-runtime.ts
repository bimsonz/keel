import { Context, type Effect } from "effect";
import type {
  StepResult,
  VerificationJob,
  VerifierUnavailable,
} from "../../domain/verification/index.ts";

/** Runs verification jobs on the cheapest tier that can, recording the tier and why. */
export class VerifierRuntime extends Context.Service<
  VerifierRuntime,
  {
    readonly run: (
      job: VerificationJob,
    ) => Effect.Effect<readonly StepResult[], VerifierUnavailable>;
  }
>()("keel/VerifierRuntime") {}
