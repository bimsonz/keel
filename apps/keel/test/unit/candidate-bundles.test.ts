// The GitCore candidate bundler over an in-memory repo: the commit's tree,
// read object by object, written with the runner protocol's bundle writer and
// stored content-addressed.
import { describe, expect, it } from "@effect/vitest";
import { CommitSha } from "@keeltown/core/kernel";
import { BundleStore, CandidateBundles } from "@keeltown/core/ports";
import {
  decodeCommit,
  decodeTree,
  type GitObject,
  MissingObject,
  type ObjectReader,
} from "@keeltown/gitcore";
import { writeBundle } from "@keeltown/runner-protocol";
import {
  buildCommit,
  buildTree,
  type FixtureFiles,
  makeBundleStoreMemory,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { CandidateBundlesGitCore } from "../../src/adapters/driven/gitcore/candidate-bundles.ts";

const STAGING = { namespace: "keel-core", name: "prj-staging" };
const text = (s: string) => new TextEncoder().encode(s);

/** A repo holding one commit of `files`, read the way the binding reads: one object at a time. */
async function repoOf(files: FixtureFiles) {
  const { tree, objects } = await buildTree(files);
  const commit = await buildCommit(tree, []);
  const all = new Map<string, GitObject>([...objects, [commit.oid, commit.object]]);
  const read = (oid: string) => {
    const o = all.get(oid);
    if (o === undefined) throw new MissingObject(oid);
    return o.body;
  };
  const reader: ObjectReader & Disposable = {
    readTree: async (oid) => decodeTree(read(oid)),
    readBlob: async (oid) => read(oid),
    readCommit: async (oid) => decodeCommit(read(oid)),
    [Symbol.dispose]: () => undefined,
  };
  return { commit: Schema.decodeUnknownSync(CommitSha)(commit.oid), reader };
}

const bundling = (reader: ObjectReader & Disposable) => {
  const store = makeBundleStoreMemory();
  const layer = CandidateBundlesGitCore(async () => reader).pipe(Layer.provide(store.layer));
  return Layer.merge(layer, store.layer);
};

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
          const hash = yield* (yield* CandidateBundles).bundle(STAGING, commit);
          const again = yield* (yield* CandidateBundles).bundle(STAGING, commit);
          const stored = yield* (yield* BundleStore).get(hash);
          return { hash, again, stored };
        });
        const { hash, again, stored } = yield* program.pipe(Effect.provide(bundling(reader)));
        expect(stored).toEqual(expected);
        expect(again).toBe(hash);
      }),
  );

  it.effect("[bundles.refuses] refuses a tree holding a symlink or a submodule", () =>
    Effect.gen(function* () {
      for (const odd of [
        { mode: "120000", data: "../README.md" },
        { mode: "160000", data: "1".repeat(40) },
      ] as const) {
        const { commit, reader } = yield* Effect.promise(() =>
          repoOf({ "README.md": "keel\n", "lib/odd": odd }),
        );
        const error = yield* Effect.flip(
          Effect.flatMap(CandidateBundles, (b) => b.bundle(STAGING, commit)).pipe(
            Effect.provide(bundling(reader)),
          ),
        );
        expect(error).toMatchObject({
          _tag: "BundleRefused",
          reason: expect.stringContaining("lib/odd"),
        });
      }
    }),
  );
});
