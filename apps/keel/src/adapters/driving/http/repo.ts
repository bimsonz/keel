import { changeIdOf, type ProjectNotFound } from "@keeltown/core/domain/integration";
import type {
  ChangeDiffUnavailable,
  ChangeDiffView,
  ChangeFileView,
  RepoBlobView,
  RepoCommitDiffView,
  RepoCompareView,
  RepoFileView,
  RepoCommitPage,
  RepoTreeView,
} from "@keeltown/core/application/integration";
import { CommitSha } from "@keeltown/core/kernel";
import type {
  CommitIdentity,
  CommitInfo,
  PathNotFound,
  RefNotFound,
  TreeEntry,
} from "@keeltown/core/ports";
import { structuredPatch } from "diff";
import { Option, Result, Schema } from "effect";
import type {
  DiffResult,
  Repo_getBlobResult,
  Repo_compareResult,
  Repo_getCommitResult,
  Repo_getTreeResult,
  Repo_listCommitsResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem, type ProblemBody } from "./problems.ts";

/**
 * Pure mappers for the repo read API: the use-cases' views as the spec's
 * RepoTree, RepoBlob, RepoCommitPage and RepoCommitDiff, and every refusal as
 * one of three 404s.
 */

type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();
const decodeSha = Schema.decodeUnknownOption(CommitSha);
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? null : new TextDecoder().decode(bytes);

/** A page's cursor: the commit the next page starts at, behind a prefix so it reads as opaque. */
const CURSOR_PREFIX = "c.";

export const commitCursor = (sha: string) => `${CURSOR_PREFIX}${sha}`;

/** A cursor from an earlier page as the commit it names; anything else is a 400 naming it. */
export function commitsFrom(
  cursor: string | undefined,
): Result.Result<CommitSha | undefined, Issues> {
  if (cursor === undefined) return Result.succeed(undefined);
  const sha = cursor.startsWith(CURSOR_PREFIX)
    ? decodeSha(cursor.slice(CURSOR_PREFIX.length))
    : Option.none();
  return Option.isSome(sha)
    ? Result.succeed(sha.value)
    : Result.fail([{ path: ["cursor"], message: "Expected a cursor from an earlier page" }]);
}

/** The path parameter as a commit id; the spec's pattern has already checked its shape. */
export function commitParam(sha: string): Result.Result<CommitSha, Issues> {
  const decoded = decodeSha(sha);
  return Option.isSome(decoded)
    ? Result.succeed(decoded.value)
    : Result.fail([{ path: ["path", "sha"], message: "Expected a commit id" }]);
}

const entryType = (e: TreeEntry) =>
  e.type === "tree"
    ? "tree"
    : e.type === "commit"
      ? "submodule"
      : e.mode === "120000"
        ? "symlink"
        : "blob";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function treeOk(view: RepoTreeView): Extract<Repo_getTreeResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      commit: view.commit,
      path: view.path,
      entries: view.entries.map((e) => ({
        name: nameOf(e.path),
        path: e.path,
        kind: entryType(e),
        mode: e.mode,
        sha: e.oid,
      })),
    },
  };
}

export function blobOk(view: RepoBlobView): Extract<Repo_getBlobResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      commit: view.commit,
      path: view.path,
      sha: view.oid,
      mode: view.mode,
      size: view.size,
      binary: view.binary,
      truncated: view.truncated,
      ...(view.content === undefined ? {} : { content: new TextDecoder().decode(view.content) }),
    },
  };
}

const identity = (who: CommitIdentity) => ({ name: who.name, email: who.email, at: iso(who.at) });

const wireCommit = (c: CommitInfo) => {
  const changeId = changeIdOf(c.message);
  return {
    sha: c.sha,
    parents: [...c.parents],
    message: c.message,
    author: identity(c.author),
    committer: identity(c.committer),
    ...(changeId === undefined ? {} : { changeId }),
  };
};

export function commitsOk(
  page: RepoCommitPage,
): Extract<Repo_listCommitsResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      items: page.commits.map(wireCommit),
      ...(page.next === undefined ? {} : { nextCursor: commitCursor(page.next) }),
    },
  };
}

/** One changed file as the wire shows it: its text on each side, null where that side has none. */
const wireFile = (f: RepoFileView) => ({
  path: f.path,
  status: f.change,
  ...(f.oldOid === undefined ? {} : { oldSha: f.oldOid }),
  ...(f.newOid === undefined ? {} : { newSha: f.newOid }),
  ...(f.oldMode === undefined ? {} : { oldMode: f.oldMode }),
  ...(f.newMode === undefined ? {} : { newMode: f.newMode }),
  binary: f.binary,
  truncated: f.truncated,
  before: text(f.before),
  after: text(f.after),
});

export function commitOk(
  view: RepoCommitDiffView,
): Extract<Repo_getCommitResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      commit: wireCommit(view.commit),
      ...(view.base === undefined ? {} : { base: view.base }),
      files: view.files.map(wireFile),
    },
  };
}

export function compareOk(
  view: RepoCompareView,
): Extract<Repo_compareResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      base: view.base,
      head: view.head,
      files: view.files.map(wireFile),
      truncated: view.truncated,
    },
  };
}

/**
 * Every refusal is a 404. A project the caller may not read answers exactly as
 * one that does not exist, so a private project's existence does not leak.
 */
export function repoError(caller: Caller, error: ProjectNotFound | RefNotFound | PathNotFound) {
  if (error._tag === "ProjectNotFound")
    return {
      status: 404 as const,
      body: problem(404, "resource.not_found", caller.requestId, {
        detail: `No project ${error.projectId}.`,
      }),
    };
  if (error._tag === "RefNotFound")
    return {
      status: 404 as const,
      body: problem(404, "repo.ref_not_found", caller.requestId, {
        detail: `The project's trunk has no branch or commit ${error.ref}.`,
        nextActions: [
          { kind: "read", title: "List the trunk's commits", operationId: "Repo_listCommits" },
        ],
      }),
    };
  return {
    status: 404 as const,
    body: problem(404, "repo.path_not_found", caller.requestId, {
      detail: `Nothing of that kind at ${error.path === "" ? "the root" : error.path} in ${error.commit}.`,
      nextActions: [
        {
          kind: "read",
          title: "List the directory",
          operationId: "Repo_getTree",
          args: { ref: error.commit },
        },
      ],
    }),
  };
}

type DiffFile = Extract<DiffResult, { readonly status: 200 }>["body"]["files"][number];
type DiffHunk = DiffFile["hunks"][number];
type DiffLine = DiffHunk["lines"][number];

/** A line diff past this many edits is not served: it would cost the request more than it shows. */
export const MAX_DIFF_EDITS = 2000;
/** A file whose two sides hold more lines than this together is not line-diffed. */
export const MAX_DIFF_LINES = 40_000;

/** git's range: `start,count`, the count left out when it is one, the start before the hunk when it is zero. */
const gitStart = (start: number, count: number) => (count === 0 ? start - 1 : start);
const gitRange = (start: number, count: number) =>
  count === 1 ? `${start}` : `${gitStart(start, count)},${count}`;

/** A hunk's lines numbered on each side; jsdiff's "no newline at end of file" marker is not a line. */
function numbered(oldStart: number, newStart: number, lines: readonly string[]): DiffLine[] {
  let oldNumber = oldStart;
  let newNumber = newStart;
  const out: DiffLine[] = [];
  for (const line of lines) {
    const body = line.slice(1).replace(/\r$/, "");
    if (line.startsWith("+")) out.push({ kind: "add", newNumber: newNumber++, text: body });
    else if (line.startsWith("-")) out.push({ kind: "del", oldNumber: oldNumber++, text: body });
    else if (line.startsWith(" "))
      out.push({ kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text: body });
  }
  return out;
}

const lineCount = (t: string) => (t === "" ? 0 : t.split("\n").length);

/** One file's hunks with three lines of context, or undefined past the line or edit cap. */
function hunksOf(before: string, after: string): DiffHunk[] | undefined {
  if (lineCount(before) + lineCount(after) > MAX_DIFF_LINES) return undefined;
  const patch = structuredPatch("a", "b", before, after, "", "", {
    context: 3,
    maxEditLength: MAX_DIFF_EDITS,
  });
  return patch?.hunks.map((h) => ({
    header: `@@ -${gitRange(h.oldStart, h.oldLines)} +${gitRange(h.newStart, h.newLines)} @@`,
    oldStart: gitStart(h.oldStart, h.oldLines),
    oldLines: h.oldLines,
    newStart: gitStart(h.newStart, h.newLines),
    newLines: h.newLines,
    lines: numbered(h.oldStart, h.newStart, h.lines),
  }));
}

const statusOf = (file: ChangeFileView): DiffFile["status"] =>
  file.renamedFrom !== undefined
    ? "renamed"
    : file.change === "type-changed"
      ? "modified"
      : file.change;

/** A changed file as the spec's ChangeDiffFile: binary and over-cap files carry no hunks and zero counts. */
export function diffFile(file: ChangeFileView): DiffFile {
  const head = {
    path: file.path,
    ...(file.renamedFrom === undefined ? {} : { previousPath: file.renamedFrom }),
    status: statusOf(file),
  };
  const none = { additions: 0, deletions: 0, hunks: [] };
  if (file.binary) return { ...head, ...none, binary: true };
  const hunks = file.truncated
    ? undefined
    : hunksOf(text(file.before) ?? "", text(file.after) ?? "");
  if (hunks === undefined) return { ...head, ...none, tooLarge: true };
  const all = hunks.flatMap((h) => h.lines);
  return {
    ...head,
    additions: all.filter((l) => l.kind === "add").length,
    deletions: all.filter((l) => l.kind === "del").length,
    hunks,
  };
}

export function changeDiffOk(view: ChangeDiffView): Extract<DiffResult, { readonly status: 200 }> {
  return { status: 200, body: { files: view.files.map(diffFile) } };
}

/** A change with no diff to serve: it submitted nothing yet, or it ended unlanded and its workspace was let go. */
export function changeDiffUnavailable(caller: Caller, error: ChangeDiffUnavailable) {
  return {
    status: 404 as const,
    body: problem(404, "change.diff_unavailable", caller.requestId, {
      detail:
        error.reason === "unsubmitted"
          ? `${error.changeId} has submitted no commit yet, so it has no diff.`
          : `${error.changeId} ended without landing, and its workspace no longer holds its commits.`,
      nextActions: [
        {
          kind: "read",
          title: "Read the change",
          operationId: "change",
          args: { changeId: error.changeId },
        },
      ],
    }),
  };
}
