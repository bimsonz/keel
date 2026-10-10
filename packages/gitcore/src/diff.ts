// Tree diff: the leaves (files, symlinks, submodules) that differ between two
// trees, row for row as `git diff-tree -r --no-renames` reports them.
//
// Both trees are walked together in git's canonical entry order, where a tree
// sorts as if its name ended in "/", so rows come out in bytewise path order.
// A subtree whose id is the same on both sides is skipped without being read.

import { MODE_GITLINK, MODE_SYMLINK, MODE_TREE, compareTreeEntries, normaliseMode, type TreeEntry } from "./objects.ts";

/** Reads one tree's immediate children. The only I/O the diff needs. */
export interface TreeReader {
  /** Throws `MissingObject` when the store has no tree with this id. */
  readTree(oid: string): Promise<readonly TreeEntry[]>;
}

/** The store has no object with this id. Readers throw it so callers can tell a missing object from a failed read. */
export class MissingObject extends Error {
  constructor(readonly oid: string) {
    super(`object ${oid} is missing`);
  }
}

export type ChangeKind = "added" | "deleted" | "modified" | "type-changed";

/**
 * One changed leaf. `path` is repo-relative and `/`-separated, with no leading
 * slash. `old*` is present unless the leaf was added, `new*` unless it was
 * deleted. Modes are canonical ("100644", "100755", "120000", "160000").
 */
export interface TreeChange {
  readonly path: string;
  readonly change: ChangeKind;
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
}

type LeafKind = "file" | "symlink" | "gitlink";

/** Git reports a change between these kinds as a type change, and a change within one as a modification. */
function leafKind(mode: string): LeafKind {
  if (mode === MODE_SYMLINK) return "symlink";
  if (mode === MODE_GITLINK) return "gitlink";
  return "file";
}

const join = (prefix: string, name: string) => (prefix === "" ? name : `${prefix}/${name}`);

async function children(reader: TreeReader, oid: string | null): Promise<TreeEntry[]> {
  if (oid === null) return [];
  const entries = await reader.readTree(oid);
  return entries.map((e) => ({ name: e.name, mode: normaliseMode(e.mode), oid: e.oid })).toSorted(compareTreeEntries);
}

/** Every leaf under `entry`, as rows of one kind: the side that has it added it, or deleted it. */
async function leaves(reader: TreeReader, entry: TreeEntry, prefix: string, change: "added" | "deleted"): Promise<TreeChange[]> {
  const path = join(prefix, entry.name);
  if (entry.mode !== MODE_TREE) {
    return [change === "added" ? { path, change, newOid: entry.oid, newMode: entry.mode } : { path, change, oldOid: entry.oid, oldMode: entry.mode }];
  }
  const below = await children(reader, entry.oid);
  return (await Promise.all(below.map((child) => leaves(reader, child, path, change)))).flat();
}

/** Two entries with the same name and the same sort key: both trees, or both leaves. */
async function changed(reader: TreeReader, before: TreeEntry, after: TreeEntry, prefix: string): Promise<TreeChange[]> {
  const path = join(prefix, before.name);
  if (before.mode === MODE_TREE) return walk(reader, before.oid, after.oid, path);
  if (before.mode === after.mode && before.oid === after.oid) return [];
  return [
    {
      path,
      change: leafKind(before.mode) === leafKind(after.mode) ? "modified" : "type-changed",
      oldOid: before.oid,
      newOid: after.oid,
      oldMode: before.mode,
      newMode: after.mode,
    },
  ];
}

async function walk(reader: TreeReader, before: string | null, after: string | null, prefix: string): Promise<TreeChange[]> {
  if (before === after) return [];
  const [left, right] = await Promise.all([children(reader, before), children(reader, after)]);
  const parts: Promise<TreeChange[]>[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const x = left[i];
    const y = right[j];
    if (x !== undefined && (y === undefined || compareTreeEntries(x, y) < 0)) {
      parts.push(leaves(reader, x, prefix, "deleted"));
      i++;
    } else if (y !== undefined && (x === undefined || compareTreeEntries(x, y) > 0)) {
      parts.push(leaves(reader, y, prefix, "added"));
      j++;
    } else if (x !== undefined && y !== undefined) {
      parts.push(changed(reader, x, y, prefix));
      i++;
      j++;
    }
  }
  return (await Promise.all(parts)).flat();
}

/**
 * Diffs two trees by id; `null` is the empty tree. Rows are leaves only (a
 * tree is never a row) in bytewise path order:
 * - a leaf on one side only is `added` or `deleted`;
 * - a leaf whose id or mode changed within one kind (regular file, symlink,
 *   submodule) is `modified`; one that changed kind is `type-changed`;
 * - a directory replaced by a file, or the reverse, is a `deleted` row for
 *   each leaf under the directory plus an `added` row for the file.
 */
export function diffTrees(reader: TreeReader, oldTree: string | null, newTree: string | null): Promise<TreeChange[]> {
  return walk(reader, oldTree, newTree, "");
}
