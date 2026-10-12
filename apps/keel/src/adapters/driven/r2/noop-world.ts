import {
  type NoNoop,
  type NoopRecipe,
  noopTree,
  type TextCodec,
} from "@keeltown/core/application/verification";
import type { ContentHash } from "@keeltown/core/kernel";
import { BundleStore } from "@keeltown/core/ports";
import { type BundleFile, writeBundle } from "@keeltown/runner-protocol";
import { Effect, Result } from "effect";

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
 * stored by its hash where the VerifierDO reads world bundles. A recipe that
 * cannot apply is NoNoop, for the draft to repair; A's own files always bundle,
 * so a refusal of them is a defect.
 */
export const noopWorld =
  (a: readonly BundleFile[]) =>
  (recipe: NoopRecipe): Effect.Effect<ContentHash, NoNoop, BundleStore> =>
    Effect.gen(function* () {
      const tree = noopTree(a, recipe, BUNDLE_TEXT);
      if (Result.isFailure(tree)) return yield* Effect.fail(tree.failure);
      const bytes = yield* Effect.promise(() => writeBundle(tree.success));
      return yield* (yield* BundleStore).put(bytes);
    });
