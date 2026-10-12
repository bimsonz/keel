import { noopTree, type TextCodec } from "@keeltown/core/application/verification";
import { CommitSha, contentHashOf } from "@keeltown/core/kernel";
import { NoopWorlds, ObjectNotFound, ProbeSources, type RepoRef } from "@keeltown/core/ports";
import { Effect, Layer, Result } from "effect";

/** A file's content in memory: text, or bytes that are not UTF-8. */
export type MemoryFile = string | Uint8Array;

/** A tree in memory: the whole of it, by path. */
export type MemoryTree = Readonly<Record<string, MemoryFile>>;

/** Trees by commit, in one repo, and a way to commit another. */
function treeStore(kind: string) {
  const trees = new Map<string, MemoryTree>();
  const repo: RepoRef = { namespace: "memory", name: `${kind}-${crypto.randomUUID()}` };
  return {
    repo,
    commit: (files: MemoryTree) =>
      Effect.sync(() => {
        const sha = CommitSha.make(
          [...crypto.getRandomValues(new Uint8Array(20))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        );
        trees.set(sha, files);
        return { repo, sha };
      }),
    tree: (at: RepoRef, commit: CommitSha) => {
      const files = at.name === repo.name ? trees.get(commit) : undefined;
      return files === undefined
        ? Effect.fail(new ObjectNotFound({ repo: at, oid: commit }))
        : Effect.succeed(files);
    },
  };
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** The whole-file diff of one path: every base line removed, every head line added. */
function wholeFileDiff(path: string, before?: string, after?: string): string {
  const removed = before === undefined ? [] : lines(before);
  const added = after === undefined ? [] : lines(after);
  return [
    `diff --git a/${path} b/${path}`,
    before === undefined ? "--- /dev/null" : `--- a/${path}`,
    after === undefined ? "+++ /dev/null" : `+++ b/${path}`,
    `@@ -${removed.length === 0 ? 0 : 1},${removed.length} +${added.length === 0 ? 0 : 1},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}

const text = (f: MemoryFile | undefined) => (typeof f === "string" ? f : undefined);

const MEMORY_TEXT: TextCodec<{ readonly path: string; readonly file: MemoryFile }> = {
  path: (e) => e.path,
  text: (e) => text(e.file),
  withText: (e, t) => ({ ...e, file: t }),
};

/**
 * ProbeSources in memory: trees committed whole, `src/` read from them, and
 * hunks as whole-file diffs (every base line removed, every head line added).
 * A real adapter writes minimal hunks; the contract asks only what both do.
 */
export function makeProbeSourcesMemory() {
  const store = treeStore("probe-sources");
  return {
    commit: store.commit,
    layer: Layer.succeed(
      ProbeSources,
      ProbeSources.of({
        source: (repo, commit) =>
          Effect.map(store.tree(repo, commit), (files) =>
            Object.entries(files)
              .flatMap(([path, f]) => {
                const t = text(f);
                return path.startsWith("src/") && t !== undefined ? [{ path, text: t }] : [];
              })
              .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          ),
        hunks: (repo, base, head) =>
          Effect.gen(function* () {
            const before = yield* store.tree(repo, base);
            const after = yield* store.tree(repo, head);
            const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
            return paths
              .flatMap((path) => {
                const b = before[path];
                const a = after[path];
                if (b === a) return [];
                if (
                  (b !== undefined && text(b) === undefined) ||
                  (a !== undefined && text(a) === undefined)
                )
                  return [];
                return [wholeFileDiff(path, text(b), text(a))];
              })
              .join("");
          }),
      }),
    ),
  };
}

/**
 * NoopWorlds in memory: trees committed whole, and A-noop's world the tree
 * with the recipe applied, answered as the content hash of that tree. The
 * real adapter bundles it; the contract asks only what both do.
 */
export function makeNoopWorldsMemory() {
  const store = treeStore("noop-worlds");
  return {
    commit: store.commit,
    layer: Layer.succeed(
      NoopWorlds,
      NoopWorlds.of({
        build: (repo, commit, recipe) =>
          Effect.gen(function* () {
            const files = yield* store.tree(repo, commit);
            const applied = noopTree(
              Object.entries(files).map(([path, file]) => ({ path, file })),
              recipe,
              MEMORY_TEXT,
            );
            if (Result.isFailure(applied)) return yield* Effect.fail(applied.failure);
            return contentHashOf(
              applied.success.map((e) => [
                e.path,
                typeof e.file === "string" ? e.file : [...e.file],
              ]),
            );
          }),
      }),
    ),
  };
}
