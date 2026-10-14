import { Context, type Effect, type Result, Schema } from "effect";
import type { CommitSha, Instant } from "../../domain/kernel/index.ts";

export interface RepoRef {
  readonly namespace: string;
  readonly name: string;
}

const RepoRefSchema = Schema.Struct({ namespace: Schema.String, name: Schema.String });

export interface RepoToken {
  readonly token: string;
  readonly access: "read" | "write";
  readonly expiresAt: Instant;
}

/** What the host says about a repo. `remote` is its HTTPS git URL; its host carries the account id, so it is never logged. */
export interface RepoInfo {
  readonly remote: string;
  readonly defaultBranch: string;
}

/**
 * One entry of a commit's tree, as `git ls-tree -r -t` lists it: `path` is
 * repo-relative and `/`-separated; a symlink is a `blob` (mode `120000`) and a
 * submodule a `commit` (mode `160000`). Modes are canonical, with no leading zero.
 */
export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly type: "blob" | "tree" | "commit";
}

/**
 * One changed leaf (file, symlink or submodule) between two commits, as
 * `git diff-tree -r --no-renames` reports it. A tree is never a row.
 *
 * `path` is repo-relative and `/`-separated with no leading slash, and rows
 * come in bytewise (git) path order; Precheck's globs match against exactly
 * this. `old*` is present unless the leaf was added, `new*` unless it was
 * deleted. A change of kind (file, symlink, submodule) is `type-changed`; a
 * directory replaced by a file is a `deleted` row per leaf under it plus an
 * `added` row for the file.
 */
export interface TreeChange {
  readonly path: string;
  readonly change: "added" | "deleted" | "modified" | "type-changed";
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
}

/** Who a commit names, and when (the commit's own timestamp). */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly at: Instant;
}

/** A commit as the host decodes it. `parents` are in git order; a root commit has none. */
export interface CommitInfo {
  readonly sha: CommitSha;
  /** The root tree's id. */
  readonly tree: string;
  readonly parents: readonly CommitSha[];
  /** The message with one trailing newline removed, as git log shows it. */
  readonly message: string;
  readonly author: CommitIdentity;
  readonly committer: CommitIdentity;
}

/** No repository by this name in this namespace (never created, or deleted). */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()("RepoNotFound", {
  repo: RepoRefSchema,
}) {}

/** A repository by this name already exists in this namespace (create, or fork onto it). */
export class RepoAlreadyExists extends Schema.TaggedError<RepoAlreadyExists>()(
  "RepoAlreadyExists",
  {
    repo: RepoRefSchema,
  },
) {}

/** The repository exists but has no such ref. */
export class RefNotFound extends Schema.TaggedError<RefNotFound>()("RefNotFound", {
  repo: RepoRefSchema,
  ref: Schema.String,
}) {}

/** The repository exists but holds no object with this id, e.g. a workspace that lacks the base commit. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  repo: RepoRefSchema,
  oid: Schema.String,
}) {}

/** The commit holds nothing at this path, or nothing of the kind asked for (a directory where a file was wanted, or the reverse). */
export class PathNotFound extends Schema.TaggedError<PathNotFound>()("PathNotFound", {
  repo: RepoRefSchema,
  commit: Schema.String,
  path: Schema.String,
}) {}

/** A branch by its full ref name, and its head. An import answers the one branch that came. */
export interface Imported {
  readonly ref: string;
  readonly commit: CommitSha;
}

/**
 * The host imported nothing from the URL, and made no repository.
 * `not-found`: no repository there that anyone may read (a private one reads
 * the same). `not-git`: what answers there is not a git repository.
 * `unreachable`: the upstream did not answer. `too-large`: its history is
 * more than the host imports. `no-branch`: it lacks the branch named, or
 * holds no branch at all.
 */
export class ImportRefused extends Schema.TaggedError<ImportRefused>()("ImportRefused", {
  reason: Schema.Literals(["not-found", "not-git", "unreachable", "too-large", "no-branch"]),
}) {}

/**
 * Repositories on the code host: create, fork, import, mint scoped tokens, read
 * (trees, files, commits and first-parent history), diff and delete. **Never writes git content**: every write is a git push.
 * Missing repos, refs and objects are typed errors; transport failures are defects.
 */
export class CodeHost extends Context.Service<
  CodeHost,
  {
    /** Fails RepoAlreadyExists when the name is taken; the existing repo is left as it was. */
    readonly create: (repo: RepoRef) => Effect.Effect<RepoRef, RepoAlreadyExists>;
    /** Fails RepoAlreadyExists when the target's name is taken; the existing repo is left as it was. */
    readonly fork: (
      source: RepoRef,
      target: RepoRef,
    ) => Effect.Effect<RepoRef, RepoNotFound | RepoAlreadyExists>;
    /**
     * Makes `target` from a public Git repository's history: one branch of
     * it, the one named by `source.ref` (a branch's short name) or else the
     * upstream's default, under its own name. Answers that branch and its
     * head as the new repo itself advertises them, never as `info` reports a
     * default branch. `source.url` is an https URL with no credential in it:
     * the caller has read it with `importUrl`. A refusal leaves no repo
     * behind; RepoAlreadyExists leaves the existing one as it was.
     */
    readonly import: (
      source: { readonly url: string; readonly ref?: string | undefined },
      target: RepoRef,
    ) => Effect.Effect<Imported, RepoAlreadyExists | ImportRefused>;
    readonly mintToken: (
      repo: RepoRef,
      access: "read" | "write",
      ttlSeconds: number,
    ) => Effect.Effect<RepoToken, RepoNotFound>;
    readonly info: (repo: RepoRef) => Effect.Effect<RepoInfo, RepoNotFound>;
    /**
     * Every branch the repo holds, by full ref name, with its head, as the
     * repo itself advertises them: the only way to learn which branch an
     * import brought once its answer is lost. A repo with no commit holds none.
     */
    readonly branches: (repo: RepoRef) => Effect.Effect<readonly Imported[], RepoNotFound>;
    /** The commit a full ref name (`refs/heads/main`) points at. */
    readonly head: (
      repo: RepoRef,
      ref: string,
    ) => Effect.Effect<CommitSha, RepoNotFound | RefNotFound>;
    /** Whether the repo holds this commit: one object read, for the commit-in-workspace check. */
    readonly hasCommit: (repo: RepoRef, sha: CommitSha) => Effect.Effect<boolean, RepoNotFound>;
    /**
     * Whether `ancestor` is `descendant` or reachable from it through any
     * parent (`git merge-base --is-ancestor`): a merge reaches its second
     * parent, where an agent's merge puts the trunk head it took. The walk
     * never reads past a commit in `stopAt` (one that cannot lead to the
     * ancestor, such as a change's grant base when the ancestor is a later
     * trunk head), though it still finds one that is the ancestor. It fails
     * closed: a walk past 10,000 commits answers false.
     */
    readonly isAncestor: (
      repo: RepoRef,
      ancestor: CommitSha,
      descendant: CommitSha,
      stopAt: readonly CommitSha[],
    ) => Effect.Effect<boolean, RepoNotFound | ObjectNotFound>;
    /** The commit's whole tree, recursively, in git order (a tree before what it holds). */
    readonly readTree: (
      repo: RepoRef,
      commit: CommitSha,
    ) => Effect.Effect<readonly TreeEntry[], RepoNotFound | ObjectNotFound>;
    readonly readBlob: (
      repo: RepoRef,
      oid: string,
    ) => Effect.Effect<Uint8Array, RepoNotFound | ObjectNotFound>;
    /**
     * Each blob as `readBlob` answers it, in the order asked, read together:
     * a host that opens a repo for a read opens it once for all of them. A
     * blob the repo lacks is that blob's ObjectNotFound, and the others are
     * still read; a missing repo fails the whole call.
     */
    readonly readBlobs: (
      repo: RepoRef,
      oids: readonly string[],
    ) => Effect.Effect<readonly Result.Result<Uint8Array, ObjectNotFound>[], RepoNotFound>;
    /**
     * The immediate entries of the directory at `path` in the commit (`""` is
     * the root), in git order, each `path` repo-relative. Only the trees on the
     * way are read. Fails PathNotFound when the path is absent or not a directory.
     */
    readonly listDir: (
      repo: RepoRef,
      commit: CommitSha,
      path: string,
    ) => Effect.Effect<readonly TreeEntry[], RepoNotFound | ObjectNotFound | PathNotFound>;
    readonly readCommit: (
      repo: RepoRef,
      sha: CommitSha,
    ) => Effect.Effect<CommitInfo, RepoNotFound | ObjectNotFound>;
    /**
     * Up to `limit` commits along the first-parent chain, newest first, starting
     * with `from` itself. Fewer means the chain ended at a root commit.
     */
    readonly log: (
      repo: RepoRef,
      from: CommitSha,
      limit: number,
    ) => Effect.Effect<readonly CommitInfo[], RepoNotFound | ObjectNotFound>;
    /** The leaves that differ from `base` to `head`; unchanged subtrees are skipped by id. */
    readonly diffTrees: (
      repo: RepoRef,
      base: CommitSha,
      head: CommitSha,
    ) => Effect.Effect<readonly TreeChange[], RepoNotFound | ObjectNotFound>;
    /** Deletes the repo and everything in it. Idempotent: deleting a missing repo succeeds. */
    readonly delete: (repo: RepoRef) => Effect.Effect<void>;
  }
>()("keel/CodeHost") {}
