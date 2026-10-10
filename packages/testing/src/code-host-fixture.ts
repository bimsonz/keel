import type { CommitSha } from "@keeltown/core/kernel";
import type { RepoNotFound, RepoRef } from "@keeltown/core/ports";
import { enc, encodeCommit, encodeTree, type GitObject, hashObject, MODE_GITLINK, MODE_TREE, type TreeEntry } from "@keeltown/gitcore";
import { Context, type Effect } from "effect";

/** A file as the fixture writes it. A bare string or bytes is a regular file; a submodule's `data` is its commit id. */
export type FixtureFile =
  | string
  | Uint8Array
  | { readonly mode: "100644" | "100755" | "120000" | "160000"; readonly data: string | Uint8Array };

/** A whole tree as `path → file`, paths repo-relative and `/`-separated. */
export type FixtureFiles = Readonly<Record<string, FixtureFile>>;

/**
 * Test-only: puts content into a code host's repo, as an agent's push would.
 * `CodeHost` never writes git content, so its contract suite seeds repos
 * through this. The in-memory host stores the objects; a real host's fixture
 * pushes them.
 */
export class CodeHostFixture extends Context.Service<CodeHostFixture, {
  /** A repo ref no test has used, in a namespace this host serves. */
  readonly scratch: () => RepoRef;
  /**
   * Commits `files` as the repo's whole tree on `ref` (a full name such as
   * `refs/heads/main`), parented on the ref's current commit if it has one,
   * and moves the ref. The repo must exist.
   */
  readonly commit: (repo: RepoRef, ref: string, files: FixtureFiles) => Effect.Effect<CommitSha, RepoNotFound>;
}>()("keel-testing/CodeHostFixture") {}

const fileOf = (file: FixtureFile) =>
  typeof file === "string" || file instanceof Uint8Array ? { mode: "100644", data: file } : file;

/** Writes `files` as blobs and nested trees; returns the root tree id and every new object, keyed by id. */
export async function buildTree(files: FixtureFiles): Promise<{ readonly tree: string; readonly objects: Map<string, GitObject> }> {
  const objects = new Map<string, GitObject>();
  const put = async (type: "blob" | "tree", body: Uint8Array) => {
    const oid = await hashObject(type, body);
    objects.set(oid, { type, body });
    return oid;
  };
  const write = async (listing: readonly (readonly [string, FixtureFile])[]): Promise<string> => {
    const here: TreeEntry[] = [];
    const dirs = new Map<string, [string, FixtureFile][]>();
    for (const [path, raw] of listing) {
      const slash = path.indexOf("/");
      if (slash >= 0) {
        const below = dirs.get(path.slice(0, slash)) ?? [];
        below.push([path.slice(slash + 1), raw]);
        dirs.set(path.slice(0, slash), below);
        continue;
      }
      const file = fileOf(raw);
      if (file.mode === MODE_GITLINK) here.push({ name: path, mode: file.mode, oid: String(file.data) });
      else here.push({ name: path, mode: file.mode, oid: await put("blob", typeof file.data === "string" ? enc.encode(file.data) : file.data) });
    }
    for (const [dir, below] of dirs) here.push({ name: dir, mode: MODE_TREE, oid: await write(below) });
    return put("tree", encodeTree(here));
  };
  const tree = await write(Object.entries(files));
  return { tree, objects };
}

/** A fixture commit: fixed identity and time, so the same tree on the same parent is the same commit. */
export async function buildCommit(tree: string, parents: readonly string[]): Promise<{ readonly oid: string; readonly object: GitObject }> {
  const who = { name: "keel fixture", email: "fixture@keel.invalid", time: 1_760_000_000 };
  const body = encodeCommit({ tree, parents, author: who, committer: who, message: "fixture" });
  return { oid: await hashObject("commit", body), object: { type: "commit", body } };
}
