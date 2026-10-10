import { Context, type Effect } from "effect";
import type {
  DeployEvidence,
  DeploymentFailed,
  DeployTarget,
} from "../../domain/delivery/index.ts";
import type { ContentHash, DeploymentId } from "../../domain/kernel/index.ts";

export interface DeployPlan {
  readonly deploymentId: DeploymentId;
  readonly target: DeployTarget;
  readonly bundle: ContentHash;
  readonly world: string;
}

/** Every deployment target behind one lifecycle. Each step returns evidence (ADR 0008). */
export class Deployer extends Context.Service<
  Deployer,
  {
    readonly plan: (
      target: DeployTarget,
      bundle: ContentHash,
      world: string,
    ) => Effect.Effect<DeployPlan, DeploymentFailed>;
    readonly preview: (plan: DeployPlan) => Effect.Effect<DeployEvidence, DeploymentFailed>;
    readonly verify: (plan: DeployPlan) => Effect.Effect<DeployEvidence, DeploymentFailed>;
    readonly promote: (
      plan: DeployPlan,
      stage: string,
    ) => Effect.Effect<DeployEvidence, DeploymentFailed>;
    readonly rollback: (plan: DeployPlan) => Effect.Effect<DeployEvidence, DeploymentFailed>;
    readonly teardown: (plan: DeployPlan) => Effect.Effect<DeployEvidence, DeploymentFailed>;
  }
>()("keel/Deployer") {}
