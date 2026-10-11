import { ContentHash } from "@keeltown/core/kernel";
import { ProbeStore } from "@keeltown/core/ports";
import { sha256Hex, writeBundle } from "@keeltown/runner-protocol";
import { Effect, Layer } from "effect";
import { bundleKey } from "./bundle-store.ts";

const enc = new TextEncoder();

/**
 * Drafted probes in the bundle bucket, as ordinary content-addressed bundles
 * at `bundles/<hex>`: the key keel-verify's VerifierDO reads a probe from,
 * checking it against the hash a ProbeRunRequest names. writeBundle sorts the
 * files, so the same files in any order are the same bundle.
 */
export const ProbeStoreR2 = (bucket: R2Bucket) =>
  Layer.succeed(
    ProbeStore,
    ProbeStore.of({
      put: (files) =>
        Effect.promise(async () => {
          const bytes = await writeBundle(
            files.map((f) => ({ path: f.path, bytes: enc.encode(f.text) })),
          );
          const hash = ContentHash.make(`sha256:${await sha256Hex(bytes)}`);
          await bucket.put(bundleKey(hash), bytes, {
            httpMetadata: { contentType: "application/gzip" },
          });
          return hash;
        }),
    }),
  );
