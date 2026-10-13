import { Context, type Effect } from "effect";
import type { ContentHash, OrgId } from "../../domain/kernel/index.ts";
import type { BundleMissing } from "../../domain/verification/index.ts";
import type { ProbeFile } from "../verification/index.ts";

/**
 * Where a drafted probe is kept for the VerifierDOs to run: its files as one
 * content-addressed bundle, at the hash a ProbeRunRequest names. The same
 * files, in any order, answer the same hash. A probe is kept for the namespace
 * its conflict's project belongs to, and is missing for every other.
 */
export class ProbeStore extends Context.Service<
  ProbeStore,
  {
    readonly put: (namespace: OrgId, files: readonly ProbeFile[]) => Effect.Effect<ContentHash>;
    /** The files kept under a hash, by path, for a reader of the probe's source. BundleMissing when nothing is kept there. */
    readonly get: (
      namespace: OrgId,
      hash: ContentHash,
    ) => Effect.Effect<readonly ProbeFile[], BundleMissing>;
  }
>()("keel/ProbeStore") {}
