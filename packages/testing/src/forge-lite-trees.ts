/**
 * forge-lite's real `src` trees for the eight S-1 changes, built by
 * `scripts/gen.ts` from the fixture and its patches, and the paths a
 * `SyntaxSource` contract reads them through.
 */
import { CONTENTS, TREES } from "./generated/forge-lite-trees.ts";
import { FORGE_LITE_SUBJECTS, type ForgeLiteItem } from "./forge-lite-facts.ts";

/** A commit's `src` tree: each file's text by its repo-relative path. */
export type ForgeLiteTree = Readonly<Record<string, string>>;

const treeOf = (index: Readonly<Record<string, number>>): ForgeLiteTree =>
  Object.fromEntries(Object.entries(index).map(([path, at]) => [path, CONTENTS[at] ?? ""]));

/** The tree before one of the eight changes, and the tree after it. */
export const forgeLiteTrees = (
  id: ForgeLiteItem["id"],
): { readonly base: ForgeLiteTree; readonly head: ForgeLiteTree } => {
  const trees = TREES[id];
  if (trees === undefined) throw new Error(`forge-lite has no item ${id}`);
  return { base: treeOf(trees.base), head: treeOf(trees.head) };
};

/**
 * The seeds Precheck's derive step gives for the change: the files it touches
 * and the files the live anchors name. A file the change adds or removes is
 * a seed on both sides, and absent on one.
 */
export const forgeLiteSeeds = (id: ForgeLiteItem["id"]): readonly string[] => {
  const { base, head } = forgeLiteTrees(id);
  const touched = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter(
    (path) => base[path] !== head[path],
  );
  const anchored = FORGE_LITE_SUBJECTS.flatMap((row) => row.anchors.map((anchor) => anchor.path));
  return [...new Set([...touched, ...anchored])].toSorted();
};

/** The files the fixture's facts were transcribed from: the cache and the guard, and for F08 the repo routes. */
export const forgeLiteFactFiles = (id: ForgeLiteItem["id"]): readonly string[] => [
  "src/authz/cache.ts",
  "src/authz/require-permission.ts",
  ...(id === "F08" ? ["src/routes/repos.ts"] : []),
];
