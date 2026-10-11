/** The read an ancestry walk needs: a commit's parents. Throws `MissingObject` for an id the store lacks. */
export interface CommitReader {
  readCommit(oid: string): Promise<{ readonly parents: readonly string[] }>;
}

/** The most commits one walk reads before it gives up. */
export const MAX_ANCESTRY_WALK = 10_000;

/** How many commits a generation reads at once. */
const READS_AT_ONCE = 32;

export interface AncestryOptions {
  /**
   * Commits the walk does not go past: one is still found if it is the
   * ancestor, but its own parents are never read. A caller names commits it
   * knows cannot lead to the ancestor (a change's grant base, when the
   * ancestor is a later trunk head), so a walk never wanders down trunk's
   * history.
   */
  readonly stopAt?: readonly string[];
  /** The most commits read before the walk answers false; `MAX_ANCESTRY_WALK` when absent. */
  readonly limit?: number;
}

/**
 * Whether `ancestor` is `descendant` or reachable from it through any of its
 * parents, as `git merge-base --is-ancestor` answers. A merge reaches both
 * sides: the second parent of an agent's merge is the trunk head it took. The
 * walk goes breadth first, a generation's reads in parallel, and every commit
 * is read before it can be the answer, so a commit the store lacks fails with
 * `MissingObject` rather than answering. It fails closed: a walk that would
 * read more than `limit` commits answers false, so an ancestry it could not
 * prove is refused, never assumed.
 */
export async function isAncestor(
  r: CommitReader,
  ancestor: string,
  descendant: string,
  options: AncestryOptions = {},
): Promise<boolean> {
  const stop = new Set(options.stopAt ?? []);
  const limit = options.limit ?? MAX_ANCESTRY_WALK;
  const seen = new Set([descendant]);
  let frontier = [descendant];
  let read = 0;
  while (frontier.length > 0) {
    if (read + frontier.length > limit) return false;
    read += frontier.length;
    const next: string[] = [];
    for (let at = 0; at < frontier.length; at += READS_AT_ONCE) {
      const chunk = frontier.slice(at, at + READS_AT_ONCE);
      const commits = await Promise.all(chunk.map((oid) => r.readCommit(oid)));
      for (const [i, commit] of commits.entries()) {
        const oid = chunk[i];
        if (oid === ancestor) return true;
        if (oid === undefined || stop.has(oid)) continue;
        for (const parent of commit.parents)
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
      }
    }
    frontier = next;
  }
  return false;
}
