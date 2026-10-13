import { enc } from "./bytes.ts";
import {
  encodeCommit,
  encodeTree,
  type GitObject,
  hashObject,
  MODE_FILE,
  type Signature,
} from "./objects.ts";

/** A history's first commit, with every object that makes it. */
export interface RootCommit {
  readonly oid: string;
  readonly tree: string;
  readonly objects: readonly GitObject[];
}

/** What a root commit holds and says. `path` names one regular file at the top of its tree. */
export interface RootSpec {
  readonly path: string;
  readonly content: string;
  readonly message: string;
  readonly author: Signature;
  readonly committer: Signature;
  /** Signs the commit: handed it unsigned, answers the armored signature for its `gpgsig` header. */
  readonly sign?: ((unsigned: Uint8Array) => Promise<string>) | undefined;
}

/**
 * A commit with no parent whose tree is one file. With `sign` it is signed
 * over its unsigned form and its id is that of the signed commit, as
 * `restack` signs. Everything in it comes from the spec, so the same spec
 * and a signer that answers the same give the same commit.
 */
export async function rootCommit(spec: RootSpec): Promise<RootCommit> {
  if (spec.path === "" || spec.path.includes("/"))
    throw new Error("a root commit's file sits at the top of its tree");
  const blob: GitObject = { type: "blob", body: enc.encode(spec.content) };
  const tree: GitObject = {
    type: "tree",
    body: encodeTree([
      { name: spec.path, mode: MODE_FILE, oid: await hashObject("blob", blob.body) },
    ]),
  };
  const commit = {
    tree: await hashObject("tree", tree.body),
    parents: [],
    author: spec.author,
    committer: spec.committer,
    message: spec.message,
  };
  const unsigned = encodeCommit(commit);
  const body =
    spec.sign === undefined
      ? unsigned
      : encodeCommit({ ...commit, gpgsig: await spec.sign(unsigned) });
  return {
    oid: await hashObject("commit", body),
    tree: commit.tree,
    objects: [blob, tree, { type: "commit", body }],
  };
}
