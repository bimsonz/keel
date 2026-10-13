import {
  type NoNoop,
  type NoopRecipe,
  noopTree,
  type TextCodec,
} from "@keeltown/core/application/verification";
import type { ContentHash, OrgId } from "@keeltown/core/kernel";
import { BundleStore, NoopWorlds } from "@keeltown/core/ports";
import { type BundleFile, readBundle, writeBundle } from "@keeltown/runner-protocol";
import { Effect, Layer, Result } from "effect";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/** A bundle file as text: undefined when it is not UTF-8, so a recipe never rewrites a binary. */
export const BUNDLE_TEXT: TextCodec<BundleFile> = {
  path: (f) => f.path,
  text: (f) => {
    try {
      return utf8.decode(f.bytes);
    } catch {
      return undefined;
    }
  },
  withText: (f, text) => ({ ...f, bytes: encoder.encode(text) }),
};

/**
 * A-noop's world from A's files: the recipe applied to the one file it names
 * (its anchor exactly once), bundled with the runner protocol's one writer and
 * stored by its hash where the VerifierDO reads the namespace's world
 * bundles. A recipe that
 * cannot apply is NoNoop, for the draft to repair; A's own files always bundle,
 * so a refusal of them is a defect.
 */
export const noopWorld =
  (namespace: OrgId, a: readonly BundleFile[]) =>
  (recipe: NoopRecipe): Effect.Effect<ContentHash, NoNoop, BundleStore> =>
    Effect.gen(function* () {
      const tree = noopTree(a, recipe, BUNDLE_TEXT);
      if (Result.isFailure(tree)) return yield* Effect.fail(tree.failure);
      const bytes = yield* Effect.promise(() => writeBundle(tree.success));
      return yield* (yield* BundleStore).put(namespace, bytes);
    });

/**
 * NoopWorlds over BundleStore: A's world bundle, as the Probe's worlds step
 * built it for the namespace, read back whole, then noopWorld applies the recipe, bundles it
 * and stores it. It never reads A's workspace, which landing collects while
 * a draft may still be repairing. A world bundle not in the store is a
 * defect: it was built for this draft.
 */
export const NoopWorldsBundles = Layer.effect(
  NoopWorlds,
  Effect.gen(function* () {
    const store = yield* BundleStore;
    return NoopWorlds.of({
      build: (namespace, world, recipe) =>
        store.get(namespace, world).pipe(
          Effect.orDie,
          Effect.flatMap((bytes) => Effect.promise(() => readBundle(bytes))),
          Effect.flatMap((files) => noopWorld(namespace, files)(recipe)),
          Effect.provideService(BundleStore, store),
        ),
    });
  }),
);
