import type { ProjectNotFound } from "@keeltown/core/domain/integration";
import type {
  RepoBlobView,
  RepoCommitDiffView,
  RepoCommitPage,
  RepoTreeView,
} from "@keeltown/core/application/integration";
import { ChangeId, CommitSha } from "@keeltown/core/kernel";
import type {
  CommitIdentity,
  CommitInfo,
  PathNotFound,
  RefNotFound,
  TreeEntry,
} from "@keeltown/core/ports";
import { Option, Result, Schema } from "effect";
import type {
  Repo_getBlobResult,
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
const decodeChangeId = Schema.decodeUnknownOption(ChangeId);
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? null : new TextDecoder().decode(bytes);

/**
 * The change a trunk commit landed: the composer writes it as the message's
 * `Change-Id` trailer. The last such line wins, as git's trailer parsing reads it.
 */
function changeOf(message: string): ChangeId | undefined {
  const ids = [...message.matchAll(/^Change-Id: (\S+)$/gm)].map((m) => m[1]);
  return Option.getOrUndefined(decodeChangeId(ids.at(-1)));
}

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
  const changeId = changeOf(c.message);
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

export function commitOk(
  view: RepoCommitDiffView,
): Extract<Repo_getCommitResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      commit: wireCommit(view.commit),
      ...(view.base === undefined ? {} : { base: view.base }),
      files: view.files.map((f) => ({
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
      })),
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
