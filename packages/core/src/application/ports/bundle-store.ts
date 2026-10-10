import { Context, type Effect } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { BundleMissing } from "../../domain/verification/index.ts";

/** Content-addressed bundles, logs and evidence. */
export class BundleStore extends Context.Service<
  BundleStore,
  {
    readonly put: (bytes: Uint8Array) => Effect.Effect<ContentHash>;
    readonly get: (hash: ContentHash) => Effect.Effect<Uint8Array, BundleMissing>;
  }
>()("keel/BundleStore") {}
