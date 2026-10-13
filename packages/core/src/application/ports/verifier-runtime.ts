import { Context, type Effect } from "effect";
import type { NamespaceId } from "../../domain/kernel/index.ts";
import type {
  StepResult,
  VerificationJob,
  VerifierUnavailable,
} from "../../domain/verification/index.ts";

/**
 * Runs verification jobs on the cheapest tier that can, recording the tier
 * and why. The job's bundle is the namespace's, and so is the evidence its
 * steps store.
 */
export class VerifierRuntime extends Context.Service<
  VerifierRuntime,
  {
    readonly run: (
      namespace: NamespaceId,
      job: VerificationJob,
    ) => Effect.Effect<readonly StepResult[], VerifierUnavailable>;
  }
>()("keel/VerifierRuntime") {}
