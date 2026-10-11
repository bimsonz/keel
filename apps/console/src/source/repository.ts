// The repository, as the console reads it: a project's tree, its files,
// trunk's history, a commit's diff, and the notes beside a file's lines.
//
// ASSUMED. Keel's contract has none of these operations yet. The shapes here
// are the ones the console asked for (QUESTIONS.md, R1 to R6), kept in this
// one file. When the operations are in Keel's generated contract these types
// are replaced by the generated ones, and this file goes.

/** R6: the project behind a public address. */
export interface RepoProject {
  id: string;
  name: string;
  visibility: "public" | "private";
  /** Where `git clone` is pointed. */
  cloneUrl: string;
  /** Trunk's head, as a commit. */
  head: string;
}

export interface RepoEntry {
  name: string;
  kind: "tree" | "blob" | "link" | "submodule";
  sha: string;
  /** Bytes, for a file. */
  size?: number;
}

/** R1: a directory at a ref. `ref` is the commit the request resolved to. */
export interface RepoTree {
  ref: string;
  path: string;
  entries: RepoEntry[];
}

/** R2: a file at a ref. A binary has no content; a large text is cut and says so. */
export interface RepoBlob {
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  content?: string;
  truncated: boolean;
}

/** R3: one commit on trunk, and what it landed. */
export interface RepoCommit {
  sha: string;
  parents: string[];
  at: string;
  message: string;
  /** The changes this commit landed, each by Keel's number for it. */
  changes: { changeId: string; label: string }[];
  /** Trunk's height once this commit was its head. */
  height?: number;
  /** False where the project had verification switched off. Absent means verified. */
  verified?: boolean;
}

export interface RepoCommitPage {
  items: RepoCommit[];
  nextCursor: string;
}

export interface RepoFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Where a renamed file was. */
  from?: string;
  before: string | null;
  after: string | null;
  binary: boolean;
}

/** R4: a commit and what it changed, each file before and after. */
export interface RepoCommitDiff {
  commit: RepoCommit;
  files: RepoFileDiff[];
}

/** R5: why a line is as it is: what relies on it, and what Keel holds about it. */
export interface RepoNote {
  /** The lines it is about, first and last, counted from 1. */
  from: number;
  to: number;
  /** The subject those lines anchor. */
  subject: string;
  kind: "premise" | "tenet" | "guard" | "decision";
  /** Keel's short name for the tenet, guard or decision. */
  label?: string;
  summary: string;
  /** For a premise: the change that holds it. */
  holder?: { changeId: string; label: string };
}

export interface RepoNotes {
  path: string;
  ref: string;
  notes: RepoNote[];
}

/** Where to read: a commit, or trunk's head when none is named. */
export interface RepoAt {
  ref?: string;
  path: string;
}

export interface KeelRepository {
  getProject(signal?: AbortSignal): Promise<RepoProject>;
  getTree(at: RepoAt, signal?: AbortSignal): Promise<RepoTree>;
  getBlob(at: RepoAt, signal?: AbortSignal): Promise<RepoBlob>;
  /** Newest first. */
  getCommits(
    request: { ref?: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<RepoCommitPage>;
  getCommitDiff(sha: string, signal?: AbortSignal): Promise<RepoCommitDiff>;
  getNotes(at: RepoAt, signal?: AbortSignal): Promise<RepoNotes>;
}
