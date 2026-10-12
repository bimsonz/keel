import type { CommitSha } from "@keeltown/core/kernel";
import {
  BundleRefused,
  BundleStore,
  CodeHost,
  NoopWorlds,
  ProbeSources,
  type RepoRef,
  type TreeEntry,
} from "@keeltown/core/ports";
import type { BundleFile } from "@keeltown/runner-protocol";
import { structuredPatch } from "diff";
import { Effect, Layer } from "effect";
import { noopWorld } from "../r2/noop-world.ts";

const MODE_FILE = "100644";
const MODE_EXEC = "100755";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A blob as text, or undefined when it is not UTF-8. */
const textOf = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

const isFile = (mode: string | undefined) => mode === MODE_FILE || mode === MODE_EXEC;

/**
 * A hunk range as git writes it: `start,count`, the count left out when it is
 * 1, and an empty side starting at the line before it (jsdiff gives the next).
 */
const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;

/**
 * One file's change as `git diff` writes it (no index line), from its text
 * before and after; absent is a side the file is not on. Minimal hunks with
 * three lines of context; undefined when the texts are the same.
 */
export function gitFileDiff(path: string, before?: string, after?: string): string | undefined {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before ?? "", after ?? "", "", "", {
    context: 3,
  });
  if (patch.hunks.length === 0 && before !== undefined && after !== undefined) return undefined;
  return [
    `diff --git a/${path} b/${path}`,
    before === undefined ? "--- /dev/null" : `--- a/${path}`,
    after === undefined ? "+++ /dev/null" : `+++ b/${path}`,
    ...patch.hunks.flatMap((h) => [
      `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`,
      ...h.lines,
    ]),
    "",
  ].join("\n");
}

/**
 * ProbeSources over CodeHost: `src/` from one read of the commit's tree, each
 * regular file's blob decoded as UTF-8 (one that is not is left out), and a
 * change's hunks from the host's tree diff, each changed text file diffed
 * with jsdiff and written as git writes it. A symlink or submodule is never
 * text, so a side that is one counts as absent.
 */
export const ProbeSourcesCodeHost = Layer.effect(
  ProbeSources,
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const read = (repo: RepoRef, oid: string | undefined, mode: string | undefined) =>
      oid === undefined || !isFile(mode)
        ? Effect.succeed(undefined)
        : Effect.map(host.readBlob(repo, oid), textOf);
    return ProbeSources.of({
      source: (repo, commit) =>
        Effect.gen(function* () {
          const entries = (yield* host.readTree(repo, commit)).filter(
            (e) => e.type === "blob" && isFile(e.mode) && e.path.startsWith("src/"),
          );
          const files = yield* Effect.forEach(
            entries,
            (e) =>
              Effect.map(host.readBlob(repo, e.oid), (bytes) => ({
                path: e.path,
                text: textOf(bytes),
              })),
            { concurrency: 8 },
          );
          return files
            .flatMap((f) => (f.text === undefined ? [] : [{ path: f.path, text: f.text }]))
            .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        }),
      hunks: (repo, base, head) =>
        Effect.gen(function* () {
          const rows = yield* host.diffTrees(repo, base, head);
          const diffs = yield* Effect.forEach(
            rows,
            (row) =>
              Effect.gen(function* () {
                const before = yield* read(repo, row.oldOid, row.oldMode);
                const after = yield* read(repo, row.newOid, row.newMode);
                const binary =
                  (isFile(row.oldMode) && before === undefined) ||
                  (isFile(row.newMode) && after === undefined);
                return binary || (before === undefined && after === undefined)
                  ? undefined
                  : gitFileDiff(row.path, before, after);
              }),
            { concurrency: 8 },
          );
          return diffs.filter((d) => d !== undefined).join("");
        }),
    });
  }),
);

/** The commit's tree as bundle files: regular files only, as CandidateBundles refuses anything else. */
const bundleFiles = (repo: RepoRef, commit: CommitSha) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const leaves = (yield* host.readTree(repo, commit)).filter((e: TreeEntry) => e.type !== "tree");
    const odd = leaves.find((e) => e.type !== "blob" || !isFile(e.mode));
    if (odd !== undefined)
      return yield* Effect.fail(
        new BundleRefused({
          reason: `${odd.path} has mode ${odd.mode}: a bundle carries regular files only`,
          path: odd.path,
        }),
      );
    return yield* Effect.forEach(
      leaves,
      (e) =>
        Effect.map(host.readBlob(repo, e.oid), (bytes): BundleFile => ({
          path: e.path,
          bytes,
          executable: e.mode === MODE_EXEC,
        })),
      { concurrency: 8 },
    );
  });

/**
 * NoopWorlds over CodeHost and BundleStore: the premise-holder's tree read
 * whole, then noopWorld applies the recipe, bundles it and stores it.
 */
export const NoopWorldsCodeHost = Layer.effect(
  NoopWorlds,
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const store = yield* BundleStore;
    return NoopWorlds.of({
      build: (repo, commit, recipe) =>
        bundleFiles(repo, commit).pipe(
          Effect.flatMap((files) => noopWorld(files)(recipe)),
          Effect.provideService(CodeHost, host),
          Effect.provideService(BundleStore, store),
        ),
    });
  }),
);
