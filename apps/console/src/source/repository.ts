// The repository, as the console reads it from Keel: a project's tree, a file,
// trunk's history, and a commit with what it changed. Every shape is Keel's
// own, generated from its spec. A read names a project by Keel's id for it,
// and Keel answers an anonymous reader for a public project and for no other.
//
// Two things the code's page can show are not Keel's to give yet, and only a
// test fixture answers them: what a project is beyond its name (QUESTIONS.md,
// R6) and the reasons beside a file's lines (R5). Their shapes are in
// contract/provisional.ts, and Keel's source has neither method.

import type { RepoBlob, RepoCommitDiff, RepoCommitPage, RepoTree } from "../contract/keel/index.ts";
import type { RepoNotes, RepoProject } from "../contract/provisional.ts";

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
  /** R6, not Keel's yet: where to clone the project from. */
  getProject?(signal?: AbortSignal): Promise<RepoProject>;
  /** R5, not Keel's yet: the reasons beside a file's lines. */
  getNotes?(at: RepoAt, signal?: AbortSignal): Promise<RepoNotes>;
}
