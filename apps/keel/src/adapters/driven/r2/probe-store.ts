import { ContentHash } from "@keeltown/core/kernel";
import { ProbeStore } from "@keeltown/core/ports";
import { BundleMissing } from "@keeltown/core/domain/verification";
import { readBundle, sha256Hex, writeBundle } from "@keeltown/runner-protocol";
import { Effect, Layer } from "effect";
import { bundleKey } from "./bundle-store.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Drafted probes in the bundle bucket, as ordinary content-addressed bundles
 * at `bundles/<hex>`: the key keel-verify's VerifierDO reads a probe from,
 * checking it against the hash a ProbeRunRequest names. writeBundle sorts the
 * files, so the same files in any order are the same bundle. `get` reads one
 * back as text, for whoever shows a probe's source.
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
      get: (hash) =>
        Effect.promise(() => bucket.get(bundleKey(hash))).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.fail(new BundleMissing({ hash }))
              : Effect.promise(async () => {
                  const files = await readBundle(new Uint8Array(await object.arrayBuffer()));
                  return files.map((f) => ({ path: f.path, text: dec.decode(f.bytes) }));
                }),
          ),
        ),
    }),
  );
