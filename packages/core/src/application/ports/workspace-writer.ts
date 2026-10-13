import { Context, type Effect, Schema } from "effect";
import type { CommitSha, Instant } from "../../domain/kernel/index.ts";
import type { ObjectNotFound, RepoNotFound, RepoRef } from "./code-host.ts";
import type { PackTooLarge } from "./trunk-writer.ts";

/** The branch an agent's work sits on in its workspace: what `submit` reads its commit from. */
export const WORKSPACE_BRANCH = "refs/heads/main";

/** One file's new content, or its deletion, at a repository-relative path. */
export type WorkspaceEdit =
  | {
      readonly path: string;
      readonly content: Uint8Array;
      /** Absent keeps an existing file's mode, and makes a new file plain. */
      readonly executable?: boolean | undefined;
    }
  | { readonly path: string; readonly delete: true };

/** A commit Keel makes in a workspace for its agent: the edits on `parent`, replacing `expectedHead`. */
export interface WorkspaceCommit {
  /** The workspace branch's head the agent read: the push's compare-and-swap. */
  readonly expectedHead: CommitSha;
  /** The commit the edits apply to and the new commit's one parent: `expectedHead`, or after a rebase the change's new base. */
  readonly parent: CommitSha;
  readonly edits: readonly WorkspaceEdit[];
  readonly message: string;
  /** The agent the commit is authored by; Keel is its committer. */
  readonly author: { readonly agentId: string; readonly handle?: string };
  readonly at: Instant;
}

export interface CommittedEdits {
  readonly commitSha: CommitSha;
  readonly tree: string;
  /** Paths whose file or mode the commit changed. */
  readonly changed: number;
}

/** The workspace branch is not at the head the agent read: someone pushed meanwhile. `head` is where it is now. */
export class WorkspaceHeadMoved extends Schema.TaggedError<WorkspaceHeadMoved>()(
  "WorkspaceHeadMoved",
  {
    expected: Schema.String,
    head: Schema.NullOr(Schema.String),
  },
) {}

/** The edits cannot apply to the parent's tree; `path` is the first edit, in path order, that fails. */
export class EditsRefused extends Schema.TaggedError<EditsRefused>()("EditsRefused", {
  reason: Schema.Literals([
    "bad-path",
    "duplicate-path",
    "nested-paths",
    "through-file",
    "is-directory",
    "missing",
    "not-a-file",
    "nothing-changed",
  ]),
  path: Schema.String,
}) {}

/**
 * Commits an agent's edits in its workspace without a clone: the parent's
 * tree with the edits applied, one commit, pushed to the workspace branch
 * with `expectedHead` as the explicit old value. Only that workspace is ever
 * written, never trunk. A retry whose commit already sits at the head (same
 * parent, same tree) answers that commit rather than a moved head.
 * RepoNotFound: the workspace is gone. ObjectNotFound: the workspace lacks
 * the parent. PackTooLarge: the edits outweigh one push.
 */
export class WorkspaceWriter extends Context.Service<
  WorkspaceWriter,
  {
    readonly commit: (
      workspace: RepoRef,
      commit: WorkspaceCommit,
    ) => Effect.Effect<
      CommittedEdits,
      WorkspaceHeadMoved | EditsRefused | ObjectNotFound | RepoNotFound | PackTooLarge
    >;
  }
>()("keel/WorkspaceWriter") {}
