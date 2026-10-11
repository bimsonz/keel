// Restacking a batch onto trunk: one commit per member, chained in batch
// order, so a candidate is deterministic, can be bisected per change, and a
// revert targets one change.

import { MissingObject } from "./diff.ts";
import {
  CachingReader,
  type MergeOptions,
  mergeTrees,
  type ObjectReader,
  OverlayReader,
  Refusal,
} from "./merge.ts";
import { encodeCommit, type GitObject, hashObject, type Signature } from "./objects.ts";
import { objectsBetween } from "./transfer.ts";

/** One change in a batch: its own base and head, and the commit it becomes. */
export interface RestackMember {
  /** The commit the change was made on (its workspace's head when granted). */
  readonly base: string;
  /** The submitted commit, whose author the restacked commit keeps. */
  readonly head: string;
  readonly message: string;
  readonly trailers: ReadonlyArray<readonly [string, string]>;
}

export interface Restacked {
  /** One per member, in batch order; the first's parent is the base, each later one's the commit before. */
  readonly commits: readonly { readonly oid: string; readonly tree: string }[];
  /** Everything a repo holding the base lacks for the last commit: the changed trees and blobs, and the commits. */
  readonly objects: readonly GitObject[];
}

/** GitCore will not compose this batch: `member` (its index) is where the fold refused. */
export class MemberRefused extends Refusal {
  constructor(
    readonly member: number,
    refusal: Refusal,
  ) {
    super(refusal.reason, refusal.path);
  }
}

/** Reads from the first reader holding the object: a staging repo first, then each member's workspace. */
export class FallbackReader implements ObjectReader {
  constructor(private readonly readers: readonly ObjectReader[]) {}

  private async first<A>(oid: string, read: (r: ObjectReader) => Promise<A>): Promise<A> {
    for (const reader of this.readers) {
      try {
        return await read(reader);
      } catch (e) {
        if (!(e instanceof MissingObject)) throw e;
      }
    }
    throw new MissingObject(oid);
  }

  readTree(oid: string) {
    return this.first(oid, (r) => r.readTree(oid));
  }

  readBlob(oid: string) {
    return this.first(oid, (r) => r.readBlob(oid));
  }

  readCommit(oid: string) {
    return this.first(oid, (r) => r.readCommit(oid));
  }
}

/**
 * Folds each member onto `base` in order, merging its change against its own
 * base (`mergeTrees(tree(m.base), acc, tree(m.head))`), and commits each step
 * on top of the one before, by `committer` and with the submitted head's own
 * author (name, email, date and offset), as `git rebase` keeps it. Throws
 * `MemberRefused` at the first member GitCore will not merge, and
 * `MissingObject` for an object no reader holds.
 */
export async function restack(
  reader: ObjectReader,
  base: string,
  members: readonly RestackMember[],
  committer: Signature,
  options: MergeOptions = {},
): Promise<Restacked> {
  if (members.length === 0) throw new Error("a batch has at least one member");
  const written = new Map<string, GitObject>();
  const r = new OverlayReader(new CachingReader(reader), written);
  const commits: { oid: string; tree: string }[] = [];
  const objects = new Map<string, GitObject>();
  let parent = base;
  let acc = (await r.readCommit(base)).tree;
  for (const [i, m] of members.entries()) {
    const [from, to] = await Promise.all([r.readCommit(m.base), r.readCommit(m.head)]);
    const merged = await mergeTrees(r, from.tree, acc, to.tree, options).catch((e: unknown) => {
      throw e instanceof Refusal ? new MemberRefused(i, e) : e;
    });
    for (const [oid, o] of merged.newObjects) written.set(oid, o);
    for (const o of await objectsBetween(r, acc, merged.tree))
      objects.set(await hashObject(o.type, o.body), o);
    const body = encodeCommit({
      tree: merged.tree,
      parents: [parent],
      author: to.author,
      committer,
      message: m.message,
      trailers: m.trailers,
    });
    const oid = await hashObject("commit", body);
    objects.set(oid, { type: "commit", body });
    commits.push({ oid, tree: merged.tree });
    parent = oid;
    acc = merged.tree;
  }
  return { commits, objects: [...objects.values()] };
}
