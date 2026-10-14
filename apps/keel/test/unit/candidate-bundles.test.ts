// The GitCore candidate bundler over an in-memory repo: the commit's tree,
// read object by object, written with the runner protocol's bundle writer and
// stored content-addressed.
import { describe, expect, it } from "@effect/vitest";
import { CommitSha, ContentHash } from "@keeltown/core/kernel";
import { BundleStore, CandidateBundles } from "@keeltown/core/ports";
import {
  decodeCommit,
  decodeTree,
  type GitObject,
  hashObject,
  MissingObject,
  type ObjectReader,
} from "@keeltown/gitcore";
import { writeBundle } from "@keeltown/runner-protocol";
import {
  buildCommit,
  buildTree,
  type FixtureFiles,
  makeBundleStoreMemory,
  otherNamespace,
  sampleNamespace,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import * as fc from "fast-check";
import { CandidateBundlesGitCore } from "../../src/adapters/driven/gitcore/candidate-bundles.ts";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const STAGING = { namespace: "keel-core", name: "prj-staging" };
const text = (s: string) => new TextEncoder().encode(s);
const sha = Schema.decodeUnknownSync(CommitSha);

/**
 * A repo holding one commit of each tree, read the way the binding reads: one
 * object at a time. `reads` counts each kind of read, and `taken()` answers
 * the reads since it was last asked.
 */
async function repoOf(first: FixtureFiles, ...more: FixtureFiles[]) {
  const all = new Map<string, GitObject>();
  const commits: CommitSha[] = [];
  for (const files of [first, ...more]) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of trees, built one after another
    const { tree, objects } = await buildTree(files);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const commit = await buildCommit(tree, []);
    for (const [oid, object] of objects) all.set(oid, object);
    all.set(commit.oid, commit.object);
    commits.push(sha(commit.oid));
  }
  const read = (oid: string) => {
    const o = all.get(oid);
    if (o === undefined) throw new MissingObject(oid);
    return o.body;
  };
  const reads = { commits: 0, trees: 0, blobs: 0 };
  const reader: ObjectReader & Disposable = {
    readTree: async (oid) => {
      reads.trees += 1;
      return decodeTree(read(oid));
    },
    readBlob: async (oid) => {
      reads.blobs += 1;
      return read(oid);
    },
    readCommit: async (oid) => {
      reads.commits += 1;
      return decodeCommit(read(oid));
    },
    [Symbol.dispose]: () => undefined,
  };
  const taken = () => {
    const since = { ...reads };
    Object.assign(reads, { commits: 0, trees: 0, blobs: 0 });
    return since;
  };
  return { commit: sha(commits[0]), commits, reader, taken };
}

const bundling = (reader: ObjectReader & Disposable) => {
  const store = makeBundleStoreMemory();
  const layer = CandidateBundlesGitCore(async () => reader).pipe(Layer.provide(store.layer));
  return Layer.merge(layer, store.layer);
};

const nth = <T>(items: readonly T[], at: number): T => {
  const found = items[at];
  if (found === undefined) throw new Error(`nothing at ${at}`);
  return found;
};

/** A commit's bundle as it is stored, taking what it can from `from` when one is named. */
const bundled = (commit: CommitSha, from?: ContentHash) =>
  Effect.gen(function* () {
    const hash = yield* (yield* CandidateBundles).bundle(sampleNamespace, STAGING, commit, from);
    const bytes = yield* (yield* BundleStore).get(sampleNamespace, hash).pipe(Effect.orDie);
    return { hash, bytes };
  });

// A tree as the property edits it: regular files by path, no path under another file's.
interface Entry {
  readonly data: string;
  readonly exec: boolean;
}
type Tree = ReadonlyMap<string, Entry>;
type Edit =
  | { readonly kind: "put"; readonly path: string; readonly entry: Entry }
  | { readonly kind: "delete"; readonly at: number }
  | { readonly kind: "rename"; readonly at: number; readonly to: string }
  | { readonly kind: "flip"; readonly at: number }
  | { readonly kind: "rewrite"; readonly at: number; readonly data: string };

/** `tree` with a file at `path`: a directory there, or a file where one of its directories must be, gives way. */
const placed = (tree: Tree, path: string, entry: Entry): Tree => {
  const next = new Map(
    [...tree].filter(
      ([at]) => at !== path && !at.startsWith(`${path}/`) && !path.startsWith(`${at}/`),
    ),
  );
  next.set(path, entry);
  return next;
};

/** One edit: a file added or replaced, deleted, renamed, its mode flipped, or rewritten where it is. */
const edited = (tree: Tree, edit: Edit): Tree => {
  if (edit.kind === "put") return placed(tree, edit.path, edit.entry);
  const path = [...tree.keys()][edit.at % Math.max(tree.size, 1)];
  const was = path === undefined ? undefined : tree.get(path);
  if (path === undefined || was === undefined) return tree;
  if (edit.kind === "flip") return placed(tree, path, { ...was, exec: !was.exec });
  if (edit.kind === "rewrite") return placed(tree, path, { ...was, data: edit.data });
  const without = new Map([...tree].filter(([at]) => at !== path));
  return edit.kind === "delete" ? without : placed(without, edit.to, was);
};

const fileOf = (entry: Entry): FixtureFiles[string] => ({
  mode: entry.exec ? "100755" : "100644",
  data: entry.data,
});
const fixtureOf = (tree: Tree): FixtureFiles =>
  Object.fromEntries([...tree].map(([path, entry]) => [path, fileOf(entry)]));

// Few names and few contents, so paths collide, directories nest and one blob turns up in many places.
const pathArb = fc
  .array(fc.constantFrom("a", "b", "c", "lib", "src"), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));
const dataArb = fc.constantFrom("", "one\n", "two\n", "three\n", "#!/bin/sh\n");
const entryArb = fc.record({ data: dataArb, exec: fc.boolean() });
const NO_FILES: Tree = new Map();
const treeArb = fc
  .array(fc.tuple(pathArb, entryArb), { maxLength: 8 })
  .map((files) => files.reduce((tree, [path, entry]) => placed(tree, path, entry), NO_FILES));
const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant("put" as const), path: pathArb, entry: entryArb }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("rename" as const), at: fc.nat(), to: pathArb }),
  fc.record({ kind: fc.constant("flip" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("rewrite" as const), at: fc.nat(), data: dataArb }),
);
const treeOf = (files: Readonly<Record<string, Entry>>): Tree => new Map(Object.entries(files));
const SCRIPT: Entry = { data: "#!/bin/sh\n", exec: true };
const ONE: Entry = { data: "one\n", exec: false };
const TWO: Entry = { data: "two\n", exec: false };
/** The cases a random run may not reach, pinned: each is a tree and the edits made to it. */
const PINNED: [Tree, Edit[]][] = [
  // Only a mode changes, under a directory whose files are otherwise the last bundle's.
  [treeOf({ "lib/run": SCRIPT, "lib/a": ONE, b: TWO }), [{ kind: "flip", at: 0 }]],
  [treeOf({ "lib/run": { ...SCRIPT, exec: false }, "lib/a": ONE }), [{ kind: "flip", at: 0 }]],
  // A file rewritten where it is, its path and its neighbours unchanged.
  [treeOf({ "src/a": ONE, "src/b": TWO }), [{ kind: "rewrite", at: 0, data: "three\n" }]],
  // A file becomes a directory, and a directory a file.
  [treeOf({ a: ONE, b: TWO }), [{ kind: "put", path: "a/b", entry: TWO }]],
  [treeOf({ "a/b": ONE, "a/c/d": TWO }), [{ kind: "put", path: "a", entry: SCRIPT }]],
  // A file moves to a new directory, and one is deleted.
  [treeOf({ "lib/a": ONE, "lib/b": TWO }), [{ kind: "rename", at: 0, to: "src/c/a" }]],
  [treeOf({ "lib/a": ONE, "lib/b": TWO, c: ONE }), [{ kind: "delete", at: 1 }]],
  // Nothing changes at all.
  [treeOf({ "lib/a": ONE, b: SCRIPT }), [{ kind: "rewrite", at: 0, data: "one\n" }]],
];

describe("CandidateBundles over gitcore", () => {
  it.effect(
    "[bundles.candidate] bundles the commit's whole tree with the runner protocol's writer, executables kept",
    () =>
      Effect.gen(function* () {
        const { commit, reader } = yield* Effect.promise(() =>
          repoOf({
            "README.md": "keel\n",
            "bin/run.sh": { mode: "100755", data: "#!/bin/sh\necho ok\n" },
            "src/a/b.ts": "export const b = 1;\n",
          }),
        );
        const expected = yield* Effect.promise(() =>
          writeBundle([
            { path: "README.md", bytes: text("keel\n") },
            { path: "bin/run.sh", bytes: text("#!/bin/sh\necho ok\n"), executable: true },
            { path: "src/a/b.ts", bytes: text("export const b = 1;\n") },
          ]),
        );
        const program = Effect.gen(function* () {
          const hash = yield* (yield* CandidateBundles).bundle(sampleNamespace, STAGING, commit);
          const again = yield* (yield* CandidateBundles).bundle(sampleNamespace, STAGING, commit);
          const store = yield* BundleStore;
          const stored = yield* store.get(sampleNamespace, hash);
          // [t5.candidate-bundles.namespace] The bundle is the namespace's it was bundled for, and no other's.
          const elsewhere = yield* Effect.flip(store.get(otherNamespace, hash));
          return { hash, again, stored, elsewhere };
        });
        const { hash, again, stored, elsewhere } = yield* program.pipe(
          Effect.provide(bundling(reader)),
        );
        expect(stored).toEqual(expected);
        expect(again).toBe(hash);
        expect(elsewhere).toMatchObject({ _tag: "BundleMissing", hash });
      }),
  );

  it.effect(
    "[bundles.refuses] refuses a tree holding a symlink, a submodule or the manifest, naming it",
    () =>
      Effect.gen(function* () {
        for (const [path, odd] of [
          ["lib/odd", { mode: "120000", data: "../README.md" }],
          ["lib/odd", { mode: "160000", data: "1".repeat(40) }],
          [".keel-bundle.sha256", "planted\n"],
        ] as const) {
          const { commit, reader } = yield* Effect.promise(() =>
            repoOf({ "README.md": "keel\n", [path]: odd }),
          );
          const error = yield* Effect.flip(
            Effect.flatMap(CandidateBundles, (b) =>
              b.bundle(sampleNamespace, STAGING, commit),
            ).pipe(Effect.provide(bundling(reader))),
          );
          expect(error).toMatchObject({
            _tag: "BundleRefused",
            reason: expect.stringContaining(path),
            path,
          });
        }
      }),
  );

  it("[bundles.reuse-same-bytes] a bundle that takes from the last one is, byte for byte, the bundle read whole", async () => {
    await fc.assert(
      fc.asyncProperty(
        treeArb,
        fc.array(editArb, { minLength: 1, maxLength: 4 }),
        async (before, edits) => {
          const after = edits.reduce(edited, before);
          const { commits, reader } = await repoOf(fixtureOf(before), fixtureOf(after));
          const whole = await Effect.runPromise(
            bundled(nth(commits, 1)).pipe(Effect.provide(bundling(reader))),
          );
          const reused = await Effect.runPromise(
            Effect.gen(function* () {
              const last = yield* bundled(nth(commits, 0));
              return yield* bundled(nth(commits, 1), last.hash);
            }).pipe(Effect.provide(bundling(reader))),
          );
          expect(reused.hash).toBe(whole.hash);
          expect(reused.bytes).toEqual(whole.bytes);
        },
      ),
      { examples: PINNED },
    );
    // Each run builds a repo and bundles it twice: seconds in all on a loaded machine, past the default five.
  }, 60_000);

  it.effect(
    "[bundles.reuse-reads] taking from the last bundle, an unchanged tree costs one read of its commit, an edit the trees on its path and its one blob, and a moved directory its parent alone",
    () =>
      Effect.gen(function* () {
        const rest: FixtureFiles = {
          "README.md": "keel\n",
          "bin/run.sh": { mode: "100755", data: "#!/bin/sh\necho ok\n" },
          "src/a/b.ts": "export const b = 1;\n",
          "src/a/c.ts": "export const c = 1;\n",
          "src/d.ts": "export const d = 1;\n",
        };
        const before = { ...rest, "docs/guide/intro.md": "# intro\n" };
        const { commits, reader, taken } = yield* Effect.promise(() =>
          repoOf(
            before,
            { ...before, "src/a/b.ts": "export const b = 2;\n" },
            { ...rest, "manual/guide/intro.md": "# intro\n" },
          ),
        );
        const program = Effect.gen(function* () {
          const last = yield* bundled(nth(commits, 0));
          const whole = taken();
          const again = yield* bundled(nth(commits, 0), last.hash);
          const unchanged = taken();
          yield* bundled(nth(commits, 1), last.hash);
          const edit = taken();
          yield* bundled(nth(commits, 2), last.hash);
          const move = taken();
          return { whole, unchanged, edit, move, same: again.hash === last.hash };
        });
        expect(yield* program.pipe(Effect.provide(bundling(reader)))).toEqual({
          // Six trees (the root, bin, docs, docs/guide, src, src/a) and six files.
          whole: { commits: 1, trees: 6, blobs: 6 },
          unchanged: { commits: 1, trees: 0, blobs: 0 },
          // The root, src and src/a, and the one file that changed.
          edit: { commits: 1, trees: 3, blobs: 1 },
          // The root alone: manual is the tree docs was, under another name.
          move: { commits: 1, trees: 1, blobs: 0 },
          same: true,
        });
      }),
  );

  it.effect(
    "[bundles.reuse-foreign] a `from` that is another namespace's, another tree's, missing or no bundle at all costs the whole read and changes nothing",
    () =>
      Effect.gen(function* () {
        const { commits, reader, taken } = yield* Effect.promise(() =>
          repoOf(
            { "README.md": "keel\n", "src/a.ts": "export const a = 1;\n" },
            { LICENSE: "all of it\n", "lib/z.rb": "puts 1\n" },
          ),
        );
        const expected = yield* Effect.promise(() =>
          writeBundle([
            { path: "README.md", bytes: text("keel\n") },
            { path: "src/a.ts", bytes: text("export const a = 1;\n") },
          ]),
        );
        const program = Effect.gen(function* () {
          const store = yield* BundleStore;
          const commit = nth(commits, 0);
          // This very tree's bundle, held for another namespace: here its address names nothing.
          const theirs = yield* store.put(otherNamespace, expected);
          const fromTheirs = { ...(yield* bundled(commit, theirs)), reads: taken() };
          const other = yield* bundled(nth(commits, 1));
          taken();
          const fromOther = { ...(yield* bundled(commit, other.hash)), reads: taken() };
          const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${"0".repeat(64)}`);
          const fromMissing = { ...(yield* bundled(commit, missing)), reads: taken() };
          const junk = yield* store.put(sampleNamespace, text("not a bundle"));
          const fromJunk = { ...(yield* bundled(commit, junk)), reads: taken() };
          return { theirs, results: [fromTheirs, fromOther, fromMissing, fromJunk] };
        });
        const { theirs, results } = yield* program.pipe(Effect.provide(bundling(reader)));
        for (const result of results)
          expect(result).toEqual({
            hash: theirs,
            bytes: expected,
            reads: { commits: 1, trees: 2, blobs: 2 },
          });
      }),
  );

  it.effect(
    "[bundles.refuses] taking from the last bundle, an entry the format cannot carry is still refused by its path, though the bundle holds its id",
    () =>
      Effect.gen(function* () {
        const before: FixtureFiles = {
          "README.md": "keel\n",
          "lib/a.txt": "b.txt",
          "lib/b.txt": "plain\n",
        };
        const readme = yield* Effect.promise(() => hashObject("blob", text("keel\n")));
        for (const [path, odd] of [
          // A symlink added under a directory otherwise unchanged.
          ["lib/odd", { mode: "120000", data: "../README.md" }],
          // Its target, as text, is a file the last bundle holds: one blob id for both.
          ["lib/odd", { mode: "120000", data: "b.txt" }],
          // A submodule whose commit id is a held file's blob id.
          ["lib/odd", { mode: "160000", data: readme }],
          [".keel-bundle.sha256", "planted\n"],
        ] as const) {
          const { commits, reader } = yield* Effect.promise(() =>
            repoOf(before, { ...before, [path]: odd }),
          );
          const error = yield* Effect.flip(
            Effect.gen(function* () {
              const last = yield* bundled(nth(commits, 0));
              return yield* bundled(nth(commits, 1), last.hash);
            }).pipe(Effect.provide(bundling(reader))),
          );
          expect(error).toMatchObject({
            _tag: "BundleRefused",
            reason: expect.stringContaining(path),
            path,
          });
        }
      }),
  );

  it.effect(
    "[bundles.read-failed-named] a read the code host fails says which read it was, of which path and object, and how far the walk had got",
    () =>
      Effect.gen(function* () {
        const { commit, reader } = yield* Effect.promise(() =>
          repoOf({ "README.md": "keel\n", "src/a/b.ts": "export const b = 1;\n" }),
        );
        const oid = yield* Effect.promise(() => hashObject("blob", text("export const b = 1;\n")));
        const failing: ObjectReader & Disposable = {
          ...reader,
          readBlob: async (asked) => {
            if (asked === oid) throw new HostFault("An internal error occurred.");
            return reader.readBlob(asked);
          },
        };
        const exit = yield* Effect.exit(
          Effect.flatMap(CandidateBundles, (b) => b.bundle(sampleNamespace, STAGING, commit)).pipe(
            Effect.provide(bundling(failing)),
          ),
        );
        const said = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
        expect(said).toMatch(
          new RegExp(
            `BundleReadFailed: readBlob src/a/b\\.ts ${oid} failed as read \\d+ of \\d+, \\d+ in flight: ArtifactsError: An internal error occurred\\.`,
          ),
        );
      }),
  );
});

/** What the binding throws when Artifacts fails a read. */
class HostFault extends Error {
  override readonly name = "ArtifactsError";
}
