import { Context, type Effect, Schema } from "effect";
import { ContentHash, type NamespaceId } from "../../domain/kernel/index.ts";
import type { BundleMissing } from "../../domain/verification/index.ts";
import type { DepsAnswer, DepsNeed, Locked } from "../verification/index.ts";

/** A bundle is kept, but it is not one Keel wrote: its manifest cannot be read from it. */
export class ManifestUnreadable extends Schema.TaggedError<ManifestUnreadable>()(
  "ManifestUnreadable",
  { hash: ContentHash, reason: Schema.String },
) {}

/**
 * Builds a candidate's dependencies once for a namespace and an install
 * digest, and answers them to every step that needs them after. Both the
 * bundle and what is built from it are the namespace's.
 *
 * `need` is what the candidate in `bundle` needs: `depsNeedFrom` over the
 * bundle's own manifest and files, read from the bundle and checked against
 * each other, with the adapter's sha256. It is `Locked` with the candidate's
 * install digest, or `Unlocked` when it has no lockfile or its install inputs
 * are longer than a deps box is handed (`INSTALL_INPUTS_MAX`).
 *
 * `build` answers the parts of the deps bundle for `need`: the ones the
 * namespace's pointer for that digest names, when it serves the need
 * (`pointerServes`), and otherwise a fresh build's, from `bundle`. Each
 * digest has its own pointer, so a build writes over none but its own
 * digest's, and that only when it was built with another toolchain. Callers
 * that ask while a build is in flight join it. A build that cannot be made is
 * `DepsUnavailable` with its reason, as data: the steps that needed it
 * abstain, and nothing fails.
 */
export class DepsBuilder extends Context.Service<
  DepsBuilder,
  {
    readonly need: (
      namespace: NamespaceId,
      bundle: ContentHash,
    ) => Effect.Effect<DepsNeed, BundleMissing | ManifestUnreadable>;
    readonly build: (
      namespace: NamespaceId,
      need: Locked,
      bundle: ContentHash,
    ) => Effect.Effect<DepsAnswer>;
  }
>()("keel/DepsBuilder") {}
