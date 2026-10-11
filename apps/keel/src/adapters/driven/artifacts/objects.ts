import type { RepoRef } from "@keeltown/core/ports";
import { MissingObject, normaliseMode, type ObjectReader } from "@keeltown/gitcore";

/** gitcore's reader over one open repo handle: an object the repo lacks throws `MissingObject`. */
export const objectsOf = (handle: ArtifactsRepo): ObjectReader => ({
  readTree: async (oid) => {
    const entries = await handle.readTree(oid);
    if (entries === null) throw new MissingObject(oid);
    return entries.map((e) => ({ name: e.name, mode: normaliseMode(e.mode), oid: e.hash }));
  },
  readBlob: async (oid) => {
    const blob = await handle.readBlob(oid);
    if (blob === null) throw new MissingObject(oid);
    return new Uint8Array(await blob.arrayBuffer());
  },
  readCommit: async (oid) => {
    const commit = await handle.readCommit(oid);
    if (commit === null) throw new MissingObject(oid);
    return { tree: commit.treeHash, parents: commit.parents };
  },
});

/**
 * Opens a repo for gitcore's object reads through its namespace's binding.
 * The handle stays open until disposed: `get()` caps at about 150 a second,
 * so one compose holds one handle per repo.
 */
export const ArtifactsObjects =
  (namespaces: Readonly<Record<string, Artifacts>>) =>
  async (repo: RepoRef): Promise<ObjectReader & Disposable> => {
    const binding = namespaces[repo.namespace];
    if (binding === undefined)
      throw new Error(`no Artifacts binding serves namespace ${repo.namespace}`);
    const handle = await binding.get(repo.name);
    return { ...objectsOf(handle), [Symbol.dispose]: () => handle[Symbol.dispose]() };
  };
