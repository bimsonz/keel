import { Result } from "effect";
import type { FlowWorld, World } from "../../domain/verification/index.ts";

/**
 * The world matrix a probe is calibrated across: trunk, A, B and AB, plus
 * A-noop, A's tree with the call A's premise anchors on made a no-op. A probe
 * is admitted only if it fails in A-noop (core's `admit`), which proves it
 * exercises A's change rather than passing whatever A does.
 */
export const MATRIX_WORLDS: readonly World[] = ["trunk", "A", "B", "AB", "A-noop"];

/**
 * How a probe template builds A-noop from A's tree: in the file at `path`,
 * the one occurrence of `anchor` (the premise's call, as written) becomes
 * `replacement`.
 */
export interface NoopRecipe {
  readonly path: string;
  readonly anchor: string;
  readonly replacement: string;
}

/** Why there is no A-noop world, so the probe can never be admitted and its conflict escalates. */
export type NoNoop =
  | { readonly reason: "no-recipe" }
  | { readonly reason: "file-absent"; readonly path: string }
  | { readonly reason: "anchor-absent"; readonly path: string }
  | { readonly reason: "anchor-ambiguous"; readonly path: string; readonly count: number };

/** Applies a recipe to the anchored file's text: the anchor must occur exactly once. */
export const applyNoop = (text: string, recipe: NoopRecipe): Result.Result<string, NoNoop> => {
  const count = recipe.anchor.length === 0 ? 0 : text.split(recipe.anchor).length - 1;
  if (count === 0) return Result.fail({ reason: "anchor-absent", path: recipe.path });
  if (count > 1) return Result.fail({ reason: "anchor-ambiguous", path: recipe.path, count });
  return Result.succeed(text.replace(recipe.anchor, () => recipe.replacement));
};

/**
 * How the caller's files carry text. Core decodes nothing itself: the
 * adapter says how to read a file as text (undefined when it is not UTF-8)
 * and how to write text back.
 */
export interface TextCodec<F> {
  readonly path: (file: F) => string;
  readonly text: (file: F) => string | undefined;
  readonly withText: (file: F, text: string) => F;
}

/**
 * The five worlds of the matrix from the four trees a conflict gives: A-noop
 * is A's tree with the recipe applied to the one file it names, every other
 * file as it was. No recipe, a missing or unreadable file, or an anchor that
 * is absent or ambiguous gives no A-noop, and so no matrix.
 */
export const buildWorlds = <F>(
  trees: Readonly<Record<FlowWorld, readonly F[]>>,
  recipe: NoopRecipe | undefined,
  codec: TextCodec<F>,
): Result.Result<Readonly<Record<World, readonly F[]>>, NoNoop> => {
  if (recipe === undefined) return Result.fail({ reason: "no-recipe" });
  const target = trees.A.find((f) => codec.path(f) === recipe.path);
  const text = target === undefined ? undefined : codec.text(target);
  if (target === undefined || text === undefined)
    return Result.fail({ reason: "file-absent", path: recipe.path });
  const changed = applyNoop(text, recipe);
  if (Result.isFailure(changed)) return Result.fail(changed.failure);
  const noop = trees.A.map((f) => (f === target ? codec.withText(f, changed.success) : f));
  return Result.succeed({ ...trees, "A-noop": noop });
};
