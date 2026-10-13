import { BundleMissing } from "@keeltown/core/domain/verification";
import { namespaceKey } from "@keeltown/core/application/verification";
import { ContentHash, type OrgId } from "@keeltown/core/kernel";
import { BundleStore } from "@keeltown/core/ports";
import { sha256Hex } from "@keeltown/runner-protocol";
import { Effect, Layer } from "effect";

/** Where a namespace's bundle lives: keel-verify's outbound handler and its VerifierDOs read exactly this key. */
export const bundleKey = (namespace: OrgId, hash: ContentHash): string =>
  namespaceKey(namespace, "bundles", hash.slice("sha256:".length));

/**
 * Candidate bundles in R2, each under its namespace's key, by the sha256 of
 * its bytes. keel writes them; keel-verify only reads them, from its
 * sandboxes' virtual bundle host.
 */
export const BundleStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    BundleStore,
    BundleStore.of({
      put: (namespace, bytes) =>
        Effect.promise(async () => {
          const hash = ContentHash.make(`sha256:${await sha256Hex(bytes)}`);
          await bucket.put(bundleKey(namespace, hash), bytes, {
            httpMetadata: { contentType: "application/gzip" },
          });
          return hash;
        }),
      get: (namespace, hash) =>
        Effect.promise(() => bucket.get(bundleKey(namespace, hash))).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.fail(new BundleMissing({ hash }))
              : Effect.promise(async () => new Uint8Array(await object.arrayBuffer())),
          ),
        ),
    }),
  );
