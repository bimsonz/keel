import { Context, type Effect } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { BundleMissing } from "../../domain/verification/index.ts";
import type { ProbeFile } from "../verification/index.ts";

/**
 * Where a drafted probe is kept for the VerifierDOs to run: its files as one
 * content-addressed bundle, at the hash a ProbeRunRequest names. The same
 * files, in any order, answer the same hash.
 */
export class ProbeStore extends Context.Service<
  ProbeStore,
  {
    readonly put: (files: readonly ProbeFile[]) => Effect.Effect<ContentHash>;
    /** The files kept under a hash, by path, for a reader of the probe's source. BundleMissing when nothing is kept there. */
    readonly get: (hash: ContentHash) => Effect.Effect<readonly ProbeFile[], BundleMissing>;
  }
>()("keel/ProbeStore") {}
