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

/** A NoNoop as a repair is told it: deterministic text naming the file. */
export const describeNoNoop = (n: NoNoop): string =>
  n.reason === "no-recipe"
    ? "the template gives no A-noop recipe"
    : n.reason === "file-absent"
      ? `${n.path} is not a text file in A's tree`
      : n.reason === "anchor-absent"
        ? `the call does not occur in ${n.path} in A's tree`
        : `the call occurs ${n.count} times in ${n.path} in A's tree, not once`;

/**
 * The lines a unified diff (as `git diff` writes it) adds to `path`, in
 * order, without their `+`; undefined when the diff does not touch the path.
 */
export const addedLines = (diff: string, path: string): readonly string[] | undefined => {
  let inHunk = false;
  let current: string | undefined;
  let touched = false;
  const added: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      current = undefined;
    } else if (!inHunk && line.startsWith("+++ ")) {
      current = line.slice(4).replace(/^b\//, "").trimEnd();
      if (current === path) touched = true;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && current === path && line.startsWith("+")) added.push(line.slice(1));
  }
  return touched ? added : undefined;
};

/**
 * Whether a recipe neutralises A's own work: its file is in A's diff and its
 * anchor is on a line A adds. A recipe anywhere else would make A-noop break
 * something A did not write, which proves nothing about A's premise.
 */
export const noopPlaced = (diffA: string, recipe: NoopRecipe): Result.Result<void, string> => {
  const added = addedLines(diffA, recipe.path);
  if (added === undefined) return Result.fail(`${recipe.path} is not in A's diff`);
  return added.some((line) => line.includes(recipe.anchor))
    ? Result.void
    : Result.fail(`the call is not on a line A adds to ${recipe.path}`);
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
  return Result.map(noopTree(trees.A, recipe, codec), (noop) => ({ ...trees, "A-noop": noop }));
};

/** A-noop's tree: A's, with the recipe applied to the one file it names, every other file as it was. */
export const noopTree = <F>(
  a: readonly F[],
  recipe: NoopRecipe,
  codec: TextCodec<F>,
): Result.Result<readonly F[], NoNoop> => {
  const target = a.find((f) => codec.path(f) === recipe.path);
  const text = target === undefined ? undefined : codec.text(target);
  if (target === undefined || text === undefined)
    return Result.fail({ reason: "file-absent", path: recipe.path });
  return Result.map(applyNoop(text, recipe), (changed) =>
    a.map((f) => (f === target ? codec.withText(f, changed) : f)),
  );
};
