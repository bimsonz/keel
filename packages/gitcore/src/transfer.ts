// What a push must carry: the objects a repo holding one tree lacks for
// another. Keel pushes candidates and trunk commits into repos that already
// hold the base, so a pack needs only the trees and blobs that changed.

import type { ObjectReader } from "./merge.ts";
import {
  encodeTree,
  type GitObject,
  hashObject,
  MODE_GITLINK,
  MODE_TREE,
  type TreeEntry,
} from "./objects.ts";

/** A tree the reader decoded that does not encode back to its own id: GitCore cannot carry it faithfully. */
export class TreeNotCanonical extends Error {
  constructor(readonly oid: string) {
    super(`tree ${oid} does not re-encode to its own id`);
  }
}

/**
 * The trees and blobs reachable from tree `to` that a repo holding tree
 * `from` (null: nothing) lacks, walking only where the two differ: a subtree
 * whose id matches is skipped unread, and a blob at an unchanged path is
 * never read. Gitlinks name commits in other repos and are never carried.
 *
 * It may carry an object the repo already holds elsewhere (a file moved from
 * another path), which a push tolerates; it never leaves out one it needs.
 * Each tree is re-encoded from its entries and checked against its id.
 */
export async function objectsBetween(
  reader: Pick<ObjectReader, "readTree" | "readBlob">,
  from: string | null,
  to: string,
): Promise<GitObject[]> {
  const out = new Map<string, GitObject>();
  const walk = async (before: string | null, after: string): Promise<void> => {
    if (before === after || out.has(after)) return;
    const entries = await reader.readTree(after);
    const body = encodeTree(entries);
    if ((await hashObject("tree", body)) !== after) throw new TreeNotCanonical(after);
    out.set(after, { type: "tree", body });
    const old = new Map<string, TreeEntry>();
    if (before !== null) for (const e of await reader.readTree(before)) old.set(e.name, e);
    for (const e of entries) {
      const was = old.get(e.name);
      if (was?.oid === e.oid) continue;
      if (e.mode === MODE_TREE) await walk(was?.mode === MODE_TREE ? was.oid : null, e.oid);
      else if (e.mode !== MODE_GITLINK && !out.has(e.oid))
        out.set(e.oid, { type: "blob", body: await reader.readBlob(e.oid) });
    }
  };
  await walk(from, to);
  return [...out.values()];
}
