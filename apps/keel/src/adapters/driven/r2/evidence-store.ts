import { canonicalJson, type ContentHash, contentHashOf, type Json } from "@keeltown/core/kernel";
import { EvidenceMissing, EvidenceStore } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

const evidenceKey = (hash: ContentHash): string => `evidence/${hash.slice("sha256:".length)}`;

/**
 * Evidence documents in the ARCHIVE bucket, which keel-verify has no binding
 * to: no sandbox can reach one candidate's evidence from another (ADR 0007).
 * Stored as canonical JSON under the hash of that JSON.
 */
export const EvidenceStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    EvidenceStore,
    EvidenceStore.of({
      put: (document) =>
        Effect.promise(async () => {
          const hash = contentHashOf(document);
          await bucket.put(evidenceKey(hash), canonicalJson(document), {
            httpMetadata: { contentType: "application/json" },
          });
          return hash;
        }),
      get: (hash) =>
        Effect.promise(() => bucket.get(evidenceKey(hash))).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.fail(new EvidenceMissing({ hash }))
              : Effect.promise(async (): Promise<Json> => JSON.parse(await object.text())),
          ),
        ),
    }),
  );
