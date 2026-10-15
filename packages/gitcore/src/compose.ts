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
import {
  type CommitSpec,
  encodeCommit,
  type GitObject,
  hashObject,
  type Signature,
} from "./objects.ts";
import { objectsBetween } from "./transfer.ts";

/** The trailer that holds what a submitted commit said of its own author, when the composer names another. */
export const DECLARED_AUTHOR = "Declared-Author";

/** One change in a batch: its own base and head, and the commit it becomes. */
export interface RestackMember {
  /** The commit the change was made on (its workspace's head when granted). */
  readonly base: string;
  /** The submitted commit: the restacked commit keeps its author date, and its author unless one is given. */
  readonly head: string;
  readonly message: string;
  readonly trailers: ReadonlyArray<readonly [string, string]>;
  /**
   * Who the restacked commit's author line names, in place of the submitted
   * commit's own author: a submitted commit says whatever its writer typed.
   * The date and offset stay the submitted commit's, and its own author text
   * is kept as the last trailer, `Declared-Author`, labelled as what it is.
   */
  readonly author?: { readonly name: string; readonly email: string } | undefined;
}

export interface Restacked {
  /** One per member, in batch order; the first's parent is the base, each later one's the commit before. */
  readonly commits: readonly { readonly oid: string; readonly tree: string }[];
  /** Everything a repo holding the base lacks for the last commit: the changed trees and blobs, and the commits. */
  readonly objects: readonly GitObject[];
}

export interface RestackOptions extends MergeOptions {
  /**
   * Signs every commit: handed the commit as it reads unsigned, it answers the
   * armored signature for its `gpgsig` header. A signer that answers the same
   * for the same bytes keeps a recompose on the same SHAs.
   */
  readonly sign?: ((unsigned: Uint8Array) => Promise<string>) | undefined;
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

/**
 * Reads from the first reader holding the object, trying first the readers
 * that answered most recently (move to front), then the rest in their order:
 * a staging repo, then each member's workspace. A restack reads each member's
 * objects in runs from its own workspace, between reads of trunk's from
 * staging, so an object costs about one miss. Trying the readers in a fixed
 * order cost one miss per workspace ahead of the member's, on every read, and
 * a batch of n about n²/2.
 */
export class FallbackReader implements ObjectReader {
  /** The readers' indices, the one that answered last first. */
  private readonly order: number[];

  constructor(private readonly readers: readonly ObjectReader[]) {
    this.order = readers.map((_, i) => i);
  }

  private async first<A>(oid: string, read: (r: ObjectReader) => Promise<A>): Promise<A> {
    for (const [at, i] of [...this.order].entries()) {
      const reader = this.readers[i];
      if (reader === undefined) continue;
      try {
        const answer = await read(reader);
        // Another read may have moved it meanwhile: it goes to the front from wherever it stands now.
        const now = at > 0 ? this.order.indexOf(i) : 0;
        if (now > 0) {
          this.order.splice(now, 1);
          this.order.unshift(i);
        }
        return answer;
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
 * author (name, email, date and offset), as `git rebase` keeps it, or with the
 * member's given author at the submitted date. With
 * `options.sign` each commit is signed and its id is that of the signed
 * commit. Throws `MemberRefused` at the first member GitCore will not merge,
 * and `MissingObject` for an object no reader holds.
 */
export async function restack(
  reader: ObjectReader,
  base: string,
  members: readonly RestackMember[],
  committer: Signature,
  options: RestackOptions = {},
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
    const { oid, body } = await commitOver(
      m,
      to.author,
      merged.tree,
      parent,
      committer,
      options.sign,
    );
    objects.set(oid, { type: "commit", body });
    commits.push({ oid, tree: merged.tree });
    parent = oid;
    acc = merged.tree;
  }
  return { commits, objects: [...objects.values()] };
}

/**
 * Commits each member over a tree composed elsewhere (by MergeBox), as
 * `restack` commits it over its own merge: the same author, committer,
 * message, trailers and signature, so a candidate's commits read the same
 * whichever tier composed its trees. `trees[i]` is the fold through member
 * `i`. Only the submitted heads are read, for their authors; the answer
 * holds the commits alone, since the trees and blobs are wherever they were
 * composed.
 */
export async function restackOnTrees(
  reader: ObjectReader,
  base: string,
  members: readonly RestackMember[],
  trees: readonly string[],
  committer: Signature,
  options: Pick<RestackOptions, "sign"> = {},
): Promise<Restacked> {
  if (members.length === 0) throw new Error("a batch has at least one member");
  if (trees.length !== members.length)
    throw new Error(`${members.length} members were composed into ${trees.length} trees`);
  const commits: { oid: string; tree: string }[] = [];
  const objects: GitObject[] = [];
  let parent = base;
  for (const [i, m] of members.entries()) {
    const tree = trees[i] ?? "";
    const { author } = await reader.readCommit(m.head);
    const { oid, body } = await commitOver(m, author, tree, parent, committer, options.sign);
    objects.push({ type: "commit", body });
    commits.push({ oid, tree });
    parent = oid;
  }
  return { commits, objects };
}

/**
 * Member `m`'s commit of `tree` on `parent`: by `committer`, with the
 * submitted author (`submitted`) or the member's given one at the submitted
 * date, which then keeps the submitted author as `Declared-Author`; signed
 * when `sign` is given, its id then the signed commit's.
 */
async function commitOver(
  m: RestackMember,
  submitted: Signature,
  tree: string,
  parent: string,
  committer: Signature,
  sign: RestackOptions["sign"],
): Promise<{ readonly oid: string; readonly body: Uint8Array }> {
  const spec: CommitSpec = {
    tree,
    parents: [parent],
    author: m.author === undefined ? submitted : { ...submitted, ...m.author },
    committer,
    message: m.message,
    trailers:
      m.author === undefined
        ? m.trailers
        : [...m.trailers, [DECLARED_AUTHOR, `${submitted.name} <${submitted.email}>`]],
  };
  const unsigned = encodeCommit(spec);
  const body =
    sign === undefined ? unsigned : encodeCommit({ ...spec, gpgsig: await sign(unsigned) });
  return { oid: await hashObject("commit", body), body };
}
