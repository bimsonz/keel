import { Context, type Effect, Schema } from "effect";
import { ContentHash } from "../../domain/kernel/index.ts";
import type { FlowPlan } from "../../domain/verification/index.ts";

/** Nothing is stored under this plan hash. */
export class PlanMissing extends Schema.TaggedError<PlanMissing>()("PlanMissing", {
  hash: ContentHash,
}) {}

/** What is stored under this plan hash is not the plan it names: unreadable, edited, or filed under another plan's hash. */
export class PlanCorrupt extends Schema.TaggedError<PlanCorrupt>()("PlanCorrupt", {
  hash: ContentHash,
  reason: Schema.String,
}) {}

/**
 * Compiled Verification Plans, addressed by their `planHash`. Precheck puts
 * the plan it compiled before PlanCompiled names its hash, and KeelVerify runs
 * the plan its job names, so the plan that runs is the plan that was
 * compiled, across deploys and compiler versions. A read is verified: the
 * plan must rehash to the hash asked for (`planHashOf`), or it is
 * `PlanCorrupt`. A plan whose own hash lies is never stored (a defect).
 */
export class PlanStore extends Context.Service<
  PlanStore,
  {
    readonly put: (plan: FlowPlan) => Effect.Effect<ContentHash>;
    readonly get: (hash: ContentHash) => Effect.Effect<FlowPlan, PlanMissing | PlanCorrupt>;
  }
>()("keel/PlanStore") {}
