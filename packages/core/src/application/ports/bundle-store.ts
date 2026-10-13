import { Context, type Effect } from "effect";
import type { ContentHash, OrgId } from "../../domain/kernel/index.ts";
import type { BundleMissing } from "../../domain/verification/index.ts";

/**
 * Content-addressed bundles, each kept for one namespace: a bundle put for
 * one namespace is missing for every other, whatever its hash.
 */
export class BundleStore extends Context.Service<
  BundleStore,
  {
    readonly put: (namespace: OrgId, bytes: Uint8Array) => Effect.Effect<ContentHash>;
    readonly get: (namespace: OrgId, hash: ContentHash) => Effect.Effect<Uint8Array, BundleMissing>;
  }
>()("keel/BundleStore") {}
