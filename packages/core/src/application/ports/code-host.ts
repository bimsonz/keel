import { Context, type Effect, Schema } from "effect";
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

/** No repository by this name in this namespace (never created, or deleted). */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()("RepoNotFound", { repo: RepoRefSchema }) {}

/** The repository exists but has no such ref. */
export class RefNotFound extends Schema.TaggedError<RefNotFound>()("RefNotFound", { repo: RepoRefSchema, ref: Schema.String }) {}

/** The repository exists but holds no object with this id, e.g. a workspace that lacks the base commit. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", { repo: RepoRefSchema, oid: Schema.String }) {}

/**
 * Repositories on the code host: create, fork, mint scoped tokens, read, diff
 * and delete. **Never writes git content**: every write is a git push.
 * Missing repos, refs and objects are typed errors; transport failures are defects.
 */
export class CodeHost extends Context.Service<CodeHost, {
  readonly create: (repo: RepoRef) => Effect.Effect<RepoRef>;
  readonly fork: (source: RepoRef, target: RepoRef) => Effect.Effect<RepoRef, RepoNotFound>;
  readonly mintToken: (repo: RepoRef, access: "read" | "write", ttlSeconds: number) => Effect.Effect<RepoToken, RepoNotFound>;
  /** The commit a full ref name (`refs/heads/main`) points at. */
  readonly head: (repo: RepoRef, ref: string) => Effect.Effect<CommitSha, RepoNotFound | RefNotFound>;
  /** The commit's whole tree, recursively, in git order (a tree before what it holds). */
  readonly readTree: (repo: RepoRef, commit: CommitSha) => Effect.Effect<readonly TreeEntry[], RepoNotFound | ObjectNotFound>;
  readonly readBlob: (repo: RepoRef, oid: string) => Effect.Effect<Uint8Array, RepoNotFound | ObjectNotFound>;
  /** The leaves that differ from `base` to `head`; unchanged subtrees are skipped by id. */
  readonly diffTrees: (repo: RepoRef, base: CommitSha, head: CommitSha) => Effect.Effect<readonly TreeChange[], RepoNotFound | ObjectNotFound>;
  /** Deletes the repo and everything in it. Idempotent: deleting a missing repo succeeds. */
  readonly delete: (repo: RepoRef) => Effect.Effect<void>;
}>()("keel/CodeHost") {}
