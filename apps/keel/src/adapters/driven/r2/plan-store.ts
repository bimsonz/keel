import { readStoredPlan, storedPlanText } from "@keeltown/core/application/verification";
import type { FlowPlan } from "@keeltown/core/domain/verification";
import type { ContentHash } from "@keeltown/core/kernel";
import { PlanCorrupt, PlanMissing, PlanStore } from "@keeltown/core/ports";
import { Effect, Layer, Result } from "effect";

/** Where a plan lives in the bucket: `plans/<hex>` of its planHash. */
export const planKey = (hash: ContentHash): string => `plans/${hash.slice("sha256:".length)}`;

/**
 * Compiled plans in the ARCHIVE bucket, which keel-verify has no binding to,
 * as JSON under their planHash. Every read is verified (`readStoredPlan`): a
 * plan edited at rest, or filed under another plan's key, is `PlanCorrupt`,
 * never run. A plan whose own hash lies is never written.
 */
export const PlanStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    PlanStore,
    PlanStore.of({
      put: (plan) => {
        const text = storedPlanText(plan);
        if (Result.isFailure(text)) return Effect.die(new Error(text.failure));
        return Effect.promise(async () => {
          await bucket.put(planKey(plan.planHash), text.success, {
            httpMetadata: { contentType: "application/json" },
          });
          return plan.planHash;
        });
      },
      get: (hash) =>
        Effect.promise(async () => {
          const object = await bucket.get(planKey(hash));
          return object === null ? undefined : await object.text();
        }).pipe(
          Effect.flatMap((text): Effect.Effect<FlowPlan, PlanMissing | PlanCorrupt> => {
            if (text === undefined) return Effect.fail(new PlanMissing({ hash }));
            const read = readStoredPlan(hash, text);
            return Result.isFailure(read)
              ? Effect.fail(new PlanCorrupt({ hash, reason: read.failure }))
              : Effect.succeed(read.success);
          }),
        ),
    }),
  );
