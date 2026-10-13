import { Context, type Effect, type Redacted } from "effect";
import type { DeployTargetUnreachable } from "../../domain/delivery/index.ts";

/** What a target's account answered: the workers.dev subdomain its previews are served under. */
export interface TargetReach {
  readonly workersDev: string;
}

/**
 * Whether a credential reaches a deploy target's account, asked before the
 * target is set, so an owner learns at once that a token is wrong rather than
 * at a change's first preview.
 */
export class DeployTargetCheck extends Context.Service<
  DeployTargetCheck,
  {
    readonly reach: (
      accountId: string,
      secret: Redacted.Redacted,
    ) => Effect.Effect<TargetReach, DeployTargetUnreachable>;
  }
>()("keel/DeployTargetCheck") {}
