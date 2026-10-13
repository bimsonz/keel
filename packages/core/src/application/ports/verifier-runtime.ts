import { Context, type Effect } from "effect";
import type { NamespaceId } from "../../domain/kernel/index.ts";
import type {
  StepResult,
  VerificationJob,
  VerifierUnavailable,
} from "../../domain/verification/index.ts";
import type { DepsAnswer } from "../verification/index.ts";

/**
 * Runs verification jobs on the cheapest tier that can, recording the tier
 * and why. The job's bundle is the namespace's, and so is the evidence its
 * steps store. `deps` is what the job's Workflow ensured for the candidate
 * before its first step that runs in a container: such a step is handed the
 * parts, and with none to hand it no runner is asked.
 */
export class VerifierRuntime extends Context.Service<
  VerifierRuntime,
  {
    readonly run: (
      namespace: NamespaceId,
      job: VerificationJob,
      deps: DepsAnswer,
    ) => Effect.Effect<readonly StepResult[], VerifierUnavailable>;
  }
>()("keel/VerifierRuntime") {}
