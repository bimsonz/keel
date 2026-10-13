import "@typespec/http";
import "./common.tsp";

using Http;

namespace Keel;

/**
 * A path inside a repository: `/`-separated, with no leading or trailing
 * slash and no empty, `.` or `..` segment. The empty string is the root.
 */
@pattern("^(?:(?!\\.\\.?(?:/|$))[^/]+(?:/(?!\\.\\.?(?:/|$))[^/]+)*)?$")
@maxLength(4096)
scalar RepoPath extends string;

/**
 * What to read: a branch name (`main`), a full branch ref (`refs/heads/main`)
 * or a commit id. Absent means the project's `main`.
 */
@minLength(1)
@maxLength(255)
scalar RepoRefName extends string;

/** One entry of a directory. A symlink's target and a submodule's commit are not followed. */
model RepoEntry {
  /** The entry's own name. */
  name: string;

  /** Its path from the repository's root. */
  path: string;

  kind: "blob" | "tree" | "symlink" | "submodule";

  /** Its git mode, canonical with no leading zero: `100644`, `100755`, `120000`, `40000` or `160000`. */
  mode: string;

  /** The object id: a blob, a tree, or for a submodule its commit. */
  sha: string;
}

/** A directory at a commit, its entries in git order. */
model RepoTree {
  /** The commit the ref resolved to; every read of it answers the same. */
  commit: CommitSha;

  path: RepoPath;
  entries: RepoEntry[];
}

/** A file at a commit. `content` is its text, present only when the file is not binary and not truncated. */
model RepoBlob {
  commit: CommitSha;
  path: RepoPath;
  sha: string;
  mode: string;

  /** Its size in bytes. */
  size: int64;

  /** It holds a NUL byte in its first 8,000 bytes, as git decides. */
  binary: boolean;

  /** It is larger than the 1 MiB Keel serves inline. */
  truncated: boolean;

  content?: string;
}

/** Who a commit names, and when. */
model RepoIdentity {
  name: string;
  email: string;
  at: utcDateTime;
}

/**
 * A commit on trunk. Each change Keel lands is one commit, signed by Keel as
 * committer (so `committer.at` is when it landed; the keys are published at
 * `/.well-known/keel/allowed-signers`). Its author is the agent whose change
 * it is, under Keel's own `agents.` domain, at the date of the commit the
 * agent pushed. Its trailers name the change (`Change-Id`), the agent
 * (`Keel-Agent`), its run once it has one (`Keel-Run`), and what the pushed
 * commit said of its own author (`Declared-Author`).
 */
model RepoCommit {
  sha: CommitSha;

  /** In git order; empty for a root commit. */
  parents: CommitSha[];

  message: string;
  author: RepoIdentity;
  committer: RepoIdentity;

  /** The change this commit landed, from its `Change-Id` trailer; absent on a commit Keel did not land. */
  changeId?: ChangeId;
}

/**
 * One file a commit changed, as `git diff-tree -r --no-renames` reports it, so
 * a rename is a deletion and an addition. `before` and `after` are its text on
 * each side, null where that side has none: the file was added or deleted on
 * it, or it is binary, or it was not served inline (`truncated`).
 */
model RepoFileChange {
  path: string;
  status: "added" | "deleted" | "modified" | "type-changed";
  oldSha?: string;
  newSha?: string;
  oldMode?: string;
  newMode?: string;

  /** Either side holds a NUL byte in its first 8,000 bytes. */
  binary: boolean;

  /** A side is over 1 MiB, or the commit's files passed 300 or 8 MiB before this one. */
  truncated: boolean;

  before: string | null;
  after: string | null;
}

/** A commit and the files it changed against its first parent, with their text on each side. */
model RepoCommitDiff {
  commit: RepoCommit;

  /** The first parent the files are compared with; absent for a root commit, whose every file is added. */
  base?: CommitSha;

  files: RepoFileChange[];
}

model RepoCommitPage is Page<RepoCommit>;

/** Two trunk commits and the files that differ from `base` to `head`, with their text on each side. */
model RepoCompare {
  base: CommitSha;
  head: CommitSha;

  /** In diff order; at most 1,000. Text is served within the same caps as a commit's diff. */
  files: RepoFileChange[];

  /** More than 1,000 files differ, and only the first 1,000 are listed. */
  truncated: boolean;
}

/**
 * A project's code, read-only: its trunk, as a code host shows it. An agent
 * reads its own project; an observer or an operator reads any. Without a
 * token, only a project whose operator made it public. Every refusal is the
 * same 404, so a private project's existence does not leak.
 */
@tag("Repo")
@route("/projects/{projectId}/repo")
interface Repo {
  @summary("List a directory")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/tree")
  @get
  getTree(
    @path projectId: ProjectId,
    @query ref?: RepoRefName,
    @query path?: RepoPath,
  ): RepoTree | NotFound | StandardErrors;

  @summary("Read a file")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/blob")
  @get
  getBlob(
    @path projectId: ProjectId,
    @query ref?: RepoRefName,
    @query path: RepoPath,
  ): RepoBlob | NotFound | StandardErrors;

  /** Newest first along the first-parent chain. The cursor names a commit, so a page holds still while trunk moves. */
  @summary("List commits")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/commits")
  @get
  listCommits(
    @path projectId: ProjectId,
    @query ref?: RepoRefName,
    ...PageQuery,
  ): RepoCommitPage | NotFound | StandardErrors;

  @summary("Read a commit and the files it changed")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/commits/{sha}")
  @get
  getCommit(@path projectId: ProjectId, @path sha: CommitSha): RepoCommitDiff | NotFound | StandardErrors;

  /**
   * What changed on trunk from `base` to `head` (`main` when absent): for an agent whose change
   * bounced, what trunk did since its base, without a clone. Both are read from the project's
   * trunk alone; a commit it does not hold is 404 `repo.ref_not_found`.
   */
  @summary("Compare two commits")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/compare")
  @get
  compare(
    @path projectId: ProjectId,
    @query base: RepoRefName,
    @query head?: RepoRefName,
  ): RepoCompare | NotFound | StandardErrors;
}
