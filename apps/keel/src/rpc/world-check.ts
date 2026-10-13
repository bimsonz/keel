import { SubjectKey } from "@keeltown/core/domain/coordination";
import { FlowWorld, WorldCheck } from "@keeltown/core/domain/verification";
import { ChangeId, ConflictId, ContentHash, NamespaceId, ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { KEEL_BUNDLE_PROVIDER } from "./keel-verify.ts";

/** Where a check's plan comes from (core's `CheckPlan`): its stored hash, the change whose plan the check reads when it runs, or why there is none. */
export const CheckPlan = Schema.Union([
  Schema.TaggedStruct("Planned", { planHash: ContentHash }),
  Schema.TaggedStruct("OfChange", { changeId: ChangeId }),
  Schema.TaggedStruct("Unplanned", { reason: Schema.String }),
]);

/**
 * One KeelWorldCheck run (core's `WorldCheckJob`): the checks of one world of
 * a conflict's matrix, on that world's bundle, recorded to the conflict's
 * Subject DO. Workflow payload, so Effect Schema; the instance id is
 * `world-<conflictId>-<world>`.
 */
export const WorldCheckJob = Schema.Struct({
  namespace: NamespaceId,
  projectId: ProjectId,
  key: SubjectKey,
  conflictId: ConflictId,
  world: FlowWorld,
  bundle: ContentHash,
  checks: Schema.Array(Schema.Struct({ check: WorldCheck, plan: CheckPlan })),
});
export type WorldCheckJob = typeof WorldCheckJob.Type;

/**
 * The full payload to create a KeelWorldCheck instance with: the job, plus
 * the fields @cloudflare/ci's engine reads before `pipeline()`, the namespace
 * its runners fetch the world's bundle from among them (the instance's
 * `namespace` step refuses a project of another). `ref` is the engine's cache
 * scope, so it names the conflict's world.
 */
export const worldCheckParams = (job: WorldCheckJob) => ({
  ...Schema.encodeSync(WorldCheckJob)(job),
  provider: KEEL_BUNDLE_PROVIDER,
  providerData: { namespace: job.namespace, bundle: job.bundle },
  event: { type: "world-check" },
  owner: "keel",
  repo: job.conflictId,
  sha: job.bundle.slice("sha256:".length),
  trigger: "push" as const,
  ref: `refs/keel/worlds/${job.conflictId}/${job.world}`,
});
