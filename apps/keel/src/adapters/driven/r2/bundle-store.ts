import { BundleMissing } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { BundleStore } from "@keeltown/core/ports";
import { sha256Hex } from "@keeltown/runner-protocol";
import { Effect, Layer } from "effect";

/** Where a bundle lives: keel-verify's outbound handler reads exactly this key, and nothing else. */
export const bundleKey = (hash: ContentHash): string => `bundles/${hash.slice("sha256:".length)}`;

/**
 * Candidate bundles in R2, keyed by the sha256 of their bytes. keel writes
 * them; keel-verify only reads them, from its sandboxes' virtual bundle host.
 */
export const BundleStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    BundleStore,
    BundleStore.of({
      put: (bytes) =>
        Effect.promise(async () => {
          const hash = ContentHash.make(`sha256:${await sha256Hex(bytes)}`);
          await bucket.put(bundleKey(hash), bytes, {
            httpMetadata: { contentType: "application/gzip" },
          });
          return hash;
        }),
      get: (hash) =>
        Effect.promise(() => bucket.get(bundleKey(hash))).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.fail(new BundleMissing({ hash }))
              : Effect.promise(async () => new Uint8Array(await object.arrayBuffer())),
          ),
        ),
    }),
  );
