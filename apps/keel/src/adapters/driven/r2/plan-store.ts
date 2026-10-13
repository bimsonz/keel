import {
  namespaceKey,
  readStoredPlan,
  storedPlanText,
} from "@keeltown/core/application/verification";
import type { FlowPlan } from "@keeltown/core/domain/verification";
import type { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import { PlanCorrupt, PlanMissing, PlanStore } from "@keeltown/core/ports";
import { Effect, Layer, Result } from "effect";

/** Where a namespace's plan lives in the bucket, by its planHash. */
export const planKey = (namespace: NamespaceId, hash: ContentHash): string =>
  namespaceKey(namespace, "plans", hash.slice("sha256:".length));

/**
 * Compiled plans in the ARCHIVE bucket, which keel-verify has no binding to,
 * as JSON under their namespace's key, by planHash. Every read is verified
 * (`readStoredPlan`): a plan edited at rest, or filed under another plan's
 * key, is `PlanCorrupt`, never run. A plan whose own hash lies is never
 * written. Only the namespace's own key is read: a plan kept anywhere else,
 * the un-namespaced key of an earlier deploy included, is `PlanMissing`.
 */
export const PlanStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    PlanStore,
    PlanStore.of({
      put: (namespace, plan) => {
        const text = storedPlanText(plan);
        if (Result.isFailure(text)) return Effect.die(new Error(text.failure));
        return Effect.promise(async () => {
          await bucket.put(planKey(namespace, plan.planHash), text.success, {
            httpMetadata: { contentType: "application/json" },
          });
          return plan.planHash;
        });
      },
      get: (namespace, hash) =>
        Effect.promise(async () => {
          const object = await bucket.get(planKey(namespace, hash));
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
