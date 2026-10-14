// The repository, as the console reads it from Keel: a project's tree, a file,
// trunk's history, and a commit with what it changed. Every shape is Keel's
// own, generated from its spec. A read names a project by Keel's id for it,
// and Keel answers whoever it shows the project to: its namespace's members, and
// anyone where it is public.
//
// One thing the code's page can show is not Keel's to give yet, and only a
// test fixture answers it: the reasons beside a file's lines. Its shape
// is in contract/provisional.ts, and Keel's source has no such method.

import type { RepoBlob, RepoCommitDiff, RepoCommitPage, RepoTree } from "../contract/keel/index.ts";
import type { RepoNotes } from "../contract/provisional.ts";

/** Where to read: a branch, a ref or a commit, or trunk's head when none is named; and a path from the root. */
export interface RepoAt {
  ref?: string;
  path: string;
}

/** Keel's codes for a repository read it refuses. A private project and a missing one are the same answer. */
export const NO_SUCH_PROJECT = "resource.not_found";

/** Keel refused a read of the repository, and said why by its own code. */
export class RepoRefused extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`Keel refused the read: ${code}`);
    this.code = code;
    this.status = status;
  }
}

export interface KeelRepository {
  getTree(projectId: string, at: RepoAt, signal?: AbortSignal): Promise<RepoTree>;
  getBlob(projectId: string, at: RepoAt, signal?: AbortSignal): Promise<RepoBlob>;
  /** Newest first. */
  getCommits(
    projectId: string,
    request: { ref?: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<RepoCommitPage>;
  /** A commit, and each file it changed, before and after. */
  getCommit(projectId: string, sha: string, signal?: AbortSignal): Promise<RepoCommitDiff>;
  /** Not Keel's yet: the reasons beside a file's lines. */
  getNotes?(at: RepoAt, signal?: AbortSignal): Promise<RepoNotes>;
}
