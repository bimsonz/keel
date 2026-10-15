import { Effect, Option, Schema } from "effect";
import type { ChangeNotFound } from "../../domain/coordination/index.ts";
import { ProjectNotFound } from "../../domain/integration/index.ts";
import { ChangeId, CommitSha, type ProjectId } from "../../domain/kernel/index.ts";
import {
  Changes,
  CodeHost,
  type CommitInfo,
  PathNotFound,
  RefNotFound,
  type RepoRef,
  type TreeChange,
  type TreeEntry,
} from "../ports/index.ts";
import { projectRepos } from "./project-repos.ts";

/**
 * A project's code, read-only, as a code host shows it. The doorway has already
 * authorised the read on the project. Every read is of the project's trunk:
 * never its staging repo, its mirror or a workspace, so no read reaches a
 * token, a candidate or another project's code. The one exception is a change
 * not yet landed, whose diff reads its own base and submitted commit, by their
 * ids, from its own workspace.
 */

/** The largest file served inline; a larger one answers its size and no content. */
export const MAX_INLINE_BYTES = 1024 * 1024;
/** How far git looks for a NUL byte before calling a file binary. */
const BINARY_PROBE_BYTES = 8000;
/** A commit's diff serves the text of at most this many files, and at most this many bytes in all. */
export const MAX_DIFF_FILES = 300;
export const MAX_DIFF_BYTES = 8 * 1024 * 1024;
/** A compare lists at most this many changed files; past it, the answer says it is truncated. */
export const MAX_COMPARE_FILES = 1000;
export const DEFAULT_COMMIT_PAGE = 30;
export const MAX_COMMIT_PAGE = 100;

const BRANCH = "refs/heads/";
const MODE_GITLINK = "160000";

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
const asSha = Schema.decodeUnknownOption(CommitSha);

/** The repo a project's code is read from: its trunk, and nothing else. */
const trunkOf = (projectId: ProjectId): RepoRef => projectRepos(projectId).trunk;

/** A trunk the code host does not hold is a project that does not exist. */
const projectMissing = (projectId: ProjectId) => () =>
  Effect.fail(new ProjectNotFound({ projectId }));

/** A branch name, a full branch ref or a commit id, as the commit it names. Absent is `main`. */
const resolve = (repo: RepoRef, ref: string | undefined) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const wanted = ref ?? "main";
    const sha = asSha(wanted);
    if (Option.isSome(sha))
      return (yield* host.hasCommit(repo, sha.value))
        ? sha.value
        : yield* Effect.fail(new RefNotFound({ repo, ref: wanted }));
    return yield* host.head(repo, wanted.startsWith("refs/") ? wanted : `${BRANCH}${wanted}`);
  });

/** An object the trunk lacks, asked for by its id, is a ref that names nothing. */
const refMissing = (repo: RepoRef, ref: string) => () =>
  Effect.fail(new RefNotFound({ repo, ref }));

export interface RepoTreeView {
  readonly commit: CommitSha;
  readonly path: string;
  readonly entries: readonly TreeEntry[];
}

export const readRepoTree = (
  projectId: ProjectId,
  input: { readonly ref?: string; readonly path: string },
): Effect.Effect<RepoTreeView, ProjectNotFound | RefNotFound | PathNotFound, CodeHost> =>
  Effect.gen(function* () {
    const repo = trunkOf(projectId);
    const host = yield* CodeHost;
    const commit = yield* resolve(repo, input.ref);
    const entries = yield* host
      .listDir(repo, commit, input.path)
      .pipe(Effect.catchTag("ObjectNotFound", Effect.die));
    return { commit, path: input.path, entries };
  }).pipe(Effect.catchTag("RepoNotFound", projectMissing(projectId)));

export interface RepoBlobView {
  readonly commit: CommitSha;
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
  readonly size: number;
  readonly binary: boolean;
  readonly truncated: boolean;
  /** The file's bytes, for the doorway to serve as text; absent when it is binary or truncated. */
  readonly content?: Uint8Array;
}

export const readRepoBlob = (
  projectId: ProjectId,
  input: { readonly ref?: string; readonly path: string },
): Effect.Effect<RepoBlobView, ProjectNotFound | RefNotFound | PathNotFound, CodeHost> =>
  Effect.gen(function* () {
    const repo = trunkOf(projectId);
    const host = yield* CodeHost;
    const commit = yield* resolve(repo, input.ref);
    const slash = input.path.lastIndexOf("/");
    const missing = new PathNotFound({ repo, commit, path: input.path });
    const listing = yield* host
      .listDir(repo, commit, slash < 0 ? "" : input.path.slice(0, slash))
      .pipe(
        Effect.catchTag("PathNotFound", () => Effect.fail(missing)),
        Effect.catchTag("ObjectNotFound", Effect.die),
      );
    const entry = listing.find((e) => e.path === input.path);
    if (entry?.type !== "blob") return yield* Effect.fail(missing);
    const bytes = yield* host
      .readBlob(repo, entry.oid)
      .pipe(Effect.catchTag("ObjectNotFound", Effect.die));
    const binary = isBinary(bytes);
    const truncated = bytes.byteLength > MAX_INLINE_BYTES;
    return {
      commit,
      path: input.path,
      oid: entry.oid,
      mode: entry.mode,
      size: bytes.byteLength,
      binary,
      truncated,
      ...(binary || truncated ? {} : { content: bytes }),
    };
  }).pipe(Effect.catchTag("RepoNotFound", projectMissing(projectId)));

export interface RepoCommitPage {
  readonly commits: readonly CommitInfo[];
  /** The commit the next page starts at; absent on the last page. */
  readonly next?: CommitSha;
}

/**
 * The first-parent history from `ref` (or from `from`, a page's `next`), newest
 * first. A page starts at a commit, never an offset, so it holds still while
 * trunk moves.
 */
export const listRepoCommits = (
  projectId: ProjectId,
  input: { readonly ref?: string; readonly from?: CommitSha; readonly limit?: number },
): Effect.Effect<RepoCommitPage, ProjectNotFound | RefNotFound, CodeHost> =>
  Effect.gen(function* () {
    const repo = trunkOf(projectId);
    const host = yield* CodeHost;
    const limit = Math.min(MAX_COMMIT_PAGE, Math.max(1, input.limit ?? DEFAULT_COMMIT_PAGE));
    const from = input.from ?? (yield* resolve(repo, input.ref));
    const chain = yield* host
      .log(repo, from, limit + 1)
      .pipe(Effect.catchTag("ObjectNotFound", refMissing(repo, from)));
    const next = chain[limit]?.sha;
    return { commits: chain.slice(0, limit), ...(next === undefined ? {} : { next }) };
  }).pipe(Effect.catchTag("RepoNotFound", projectMissing(projectId)));

/** A changed file with its bytes on each side, for the doorway to serve as text. */
export interface RepoFileView extends TreeChange {
  readonly binary: boolean;
  readonly truncated: boolean;
  /** Absent where that side has no file, or the file is binary or truncated. */
  readonly before?: Uint8Array;
  readonly after?: Uint8Array;
}

export interface RepoCommitDiffView {
  readonly commit: CommitInfo;
  /** The first parent; absent for a root commit. */
  readonly base?: CommitSha;
  readonly files: readonly RepoFileView[];
}

/**
 * Each changed file with its text on each side, in diff order, within the caps:
 * a side over MAX_INLINE_BYTES, or a file past MAX_DIFF_FILES or past
 * MAX_DIFF_BYTES in all, is `truncated` and carries no bytes. A submodule side
 * has no text.
 */
const withSides = (repo: RepoRef, files: readonly TreeChange[]) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const side = (oid: string | undefined, mode: string | undefined) =>
      oid === undefined || mode === MODE_GITLINK
        ? Effect.succeed(undefined)
        : host.readBlob(repo, oid).pipe(Effect.catchTag("ObjectNotFound", Effect.die));
    const read = yield* Effect.forEach(
      files.slice(0, MAX_DIFF_FILES),
      (f) => Effect.all([side(f.oldOid, f.oldMode), side(f.newOid, f.newMode)]),
      { concurrency: 8 },
    );
    let budget = MAX_DIFF_BYTES;
    return files.map((file, i): RepoFileView => {
      const [before, after] = read[i] ?? [undefined, undefined];
      const sides = [before, after].filter((b): b is Uint8Array => b !== undefined);
      const binary = sides.some(isBinary);
      const size = sides.reduce((n, b) => n + b.byteLength, 0);
      const truncated =
        i >= MAX_DIFF_FILES || sides.some((b) => b.byteLength > MAX_INLINE_BYTES) || size > budget;
      if (binary || truncated) return { ...file, binary, truncated };
      budget -= size;
      return {
        ...file,
        binary,
        truncated,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      };
    });
  });

/** A commit and the files it changed against its first parent, with their text; a root commit adds every file. */
export const readRepoCommit = (
  projectId: ProjectId,
  sha: CommitSha,
): Effect.Effect<RepoCommitDiffView, ProjectNotFound | RefNotFound, CodeHost> =>
  Effect.gen(function* () {
    const repo = trunkOf(projectId);
    const host = yield* CodeHost;
    const commit = yield* host
      .readCommit(repo, sha)
      .pipe(Effect.catchTag("ObjectNotFound", refMissing(repo, sha)));
    const base = commit.parents[0];
    const changes =
      base === undefined
        ? (yield* host.readTree(repo, sha).pipe(Effect.catchTag("ObjectNotFound", Effect.die)))
            .filter((e) => e.type !== "tree")
            .map((e): TreeChange => ({
              path: e.path,
              change: "added",
              newOid: e.oid,
              newMode: e.mode,
            }))
        : yield* host
            .diffTrees(repo, base, sha)
            .pipe(Effect.catchTag("ObjectNotFound", Effect.die));
    const files = yield* withSides(repo, changes);
    return { commit, ...(base === undefined ? {} : { base }), files };
  }).pipe(Effect.catchTag("RepoNotFound", projectMissing(projectId)));

export interface RepoCompareView {
  readonly base: CommitSha;
  readonly head: CommitSha;
  readonly files: readonly RepoFileView[];
  /** More files differ than the MAX_COMPARE_FILES listed. */
  readonly truncated: boolean;
}

/**
 * The files that differ from `base` to `head` (each a branch, a full ref or a
 * commit id; `head` absent is `main`), with their text within the diff's caps.
 * Both are read from the project's trunk alone, so a commit only another repo
 * holds is a ref that names nothing.
 */
export const compareRepoCommits = (
  projectId: ProjectId,
  input: { readonly base: string; readonly head?: string },
): Effect.Effect<RepoCompareView, ProjectNotFound | RefNotFound, CodeHost> =>
  Effect.gen(function* () {
    const repo = trunkOf(projectId);
    const host = yield* CodeHost;
    const base = yield* resolve(repo, input.base);
    const head = yield* resolve(repo, input.head);
    const changes = yield* host
      .diffTrees(repo, base, head)
      .pipe(Effect.catchTag("ObjectNotFound", Effect.die));
    const listed = changes.slice(0, MAX_COMPARE_FILES);
    const files = yield* withSides(repo, listed);
    return { base, head, files, truncated: changes.length > listed.length };
  }).pipe(Effect.catchTag("RepoNotFound", projectMissing(projectId)));

/**
 * A change whose diff Keel cannot serve: it has submitted no commit, or it
 * ended without landing and its workspace no longer holds its commits.
 */
export class ChangeDiffUnavailable extends Schema.TaggedError<ChangeDiffUnavailable>()(
  "ChangeDiffUnavailable",
  {
    changeId: ChangeId,
    reason: Schema.Literals(["unsubmitted", "released"]),
  },
) {}

/** A changed file of a change's diff: a rename names the path it had before. */
export interface ChangeFileView extends RepoFileView {
  readonly renamedFrom?: string;
}

export interface ChangeDiffView {
  /** In path order. */
  readonly files: readonly ChangeFileView[];
}

/** git's id of the empty blob: every empty file has it, so two of them are no rename. */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** A side that may pair into a rename: a file with content, never a submodule. */
const pairable = (oid: string | undefined, mode: string | undefined) =>
  oid !== undefined && oid !== EMPTY_BLOB && mode !== MODE_GITLINK;

/**
 * Each file deleted at one path and added at another with the same content, as
 * one rename at the new path: paired one to one in path order. A submodule or
 * an empty file is never paired.
 */
const withRenames = (files: readonly RepoFileView[]): ChangeFileView[] => {
  const deleted = new Map<string, RepoFileView[]>();
  for (const f of files)
    if (f.change === "deleted" && pairable(f.oldOid, f.oldMode))
      deleted.set(f.oldOid ?? "", [...(deleted.get(f.oldOid ?? "") ?? []), f]);
  const paired = new Set<RepoFileView>();
  const out: ChangeFileView[] = [];
  for (const f of files) {
    if (f.change !== "added" || !pairable(f.newOid, f.newMode)) continue;
    const from = deleted.get(f.newOid ?? "")?.find((d) => !paired.has(d));
    if (from === undefined) continue;
    paired.add(from);
    paired.add(f);
    out.push({
      path: f.path,
      change: "modified",
      renamedFrom: from.path,
      ...(from.oldOid === undefined ? {} : { oldOid: from.oldOid }),
      ...(from.oldMode === undefined ? {} : { oldMode: from.oldMode }),
      ...(f.newOid === undefined ? {} : { newOid: f.newOid }),
      ...(f.newMode === undefined ? {} : { newMode: f.newMode }),
      binary: from.binary || f.binary,
      truncated: from.truncated || f.truncated,
      ...(from.before === undefined ? {} : { before: from.before }),
      ...(f.after === undefined ? {} : { after: f.after }),
    });
  }
  return [...out, ...files.filter((f) => !paired.has(f))].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
};

/**
 * What a change alters, each file with its text on each side within the diff's
 * caps. A landed change is its commit on trunk against the commit before it. A
 * change not landed is its submitted commit against its base, both read by id
 * from its workspace; one that has submitted nothing, or whose workspace no
 * longer holds them, is ChangeDiffUnavailable.
 */
export const readChangeDiff = (
  changeId: ChangeId,
): Effect.Effect<ChangeDiffView, ChangeNotFound | ChangeDiffUnavailable, Changes | CodeHost> =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    const { change, projectId } = yield* changes.get(changeId);
    if (change.landedCommit !== undefined) {
      const landed = yield* readRepoCommit(projectId, change.landedCommit).pipe(
        Effect.catchTags({ ProjectNotFound: Effect.die, RefNotFound: Effect.die }),
      );
      return { files: withRenames(landed.files) };
    }
    const released = () => Effect.fail(new ChangeDiffUnavailable({ changeId, reason: "released" }));
    const head = change.commitSha;
    if (head === undefined)
      return yield* Effect.fail(new ChangeDiffUnavailable({ changeId, reason: "unsubmitted" }));
    const workspace = yield* changes
      .workspace(changeId)
      .pipe(Effect.catchTag("ChangeStateRefused", released));
    const host = yield* CodeHost;
    const files = yield* host
      .diffTrees(workspace.repo, change.baseSha ?? workspace.baseSha, head)
      .pipe(
        Effect.flatMap((listed) => withSides(workspace.repo, listed)),
        Effect.catchTags({ RepoNotFound: released, ObjectNotFound: released }),
      );
    return { files: withRenames(files) };
  });
