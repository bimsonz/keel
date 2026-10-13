import { namespaceKey } from "@keeltown/core/application/verification";
import {
  canonicalJson,
  type ContentHash,
  contentHashOf,
  type Json,
  type OrgId,
} from "@keeltown/core/kernel";
import { EvidenceMissing, EvidenceStore } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

/** Where a namespace's evidence document lives in the bucket. */
export const evidenceKey = (namespace: OrgId, hash: ContentHash): string =>
  namespaceKey(namespace, "evidence", hash.slice("sha256:".length));

/**
 * Evidence documents in the ARCHIVE bucket, which keel-verify has no binding
 * to: no sandbox can reach one candidate's evidence from another (ADR 0007).
 * Stored as canonical JSON under its namespace's key, by the hash of that
 * JSON.
 */
export const EvidenceStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    EvidenceStore,
    EvidenceStore.of({
      put: (namespace, document) =>
        Effect.promise(async () => {
          const hash = contentHashOf(document);
          await bucket.put(evidenceKey(namespace, hash), canonicalJson(document), {
            httpMetadata: { contentType: "application/json" },
          });
          return hash;
        }),
      get: (namespace, hash) =>
        Effect.promise(() => bucket.get(evidenceKey(namespace, hash))).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.fail(new EvidenceMissing({ hash }))
              : Effect.promise(async (): Promise<Json> => JSON.parse(await object.text())),
          ),
        ),
    }),
  );
