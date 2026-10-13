import { describe, expect, it } from "@effect/vitest";
import { addedLines } from "@keeltown/core/application/verification";
import { CommitSha, type ContentHash, type OrgId } from "@keeltown/core/kernel";
import { NoopWorlds, ProbeSources, type RepoRef } from "@keeltown/core/ports";
import { Effect, Exit, type Layer } from "effect";
import { otherNamespace, sampleNamespace } from "../namespaces.ts";

/** A commit's whole tree: text, or bytes that are not UTF-8. */
export type ContractTree = Readonly<Record<string, string | Uint8Array>>;

/** A port and a way to commit a whole tree to the one repo it reads. */
interface TreeHarness<S> {
  readonly layer: Layer.Layer<S>;
  readonly commit: (
    files: ContractTree,
  ) => Effect.Effect<{ readonly repo: RepoRef; readonly sha: CommitSha }>;
}
export type ProbeSourcesHarness = TreeHarness<ProbeSources>;
/** NoopWorlds, and a way to store a whole tree as a namespace's world bundle, as the Probe's worlds step builds A's. */
export interface NoopWorldsHarness {
  readonly layer: Layer.Layer<NoopWorlds>;
  readonly world: (namespace: OrgId, files: ContractTree) => Effect.Effect<ContentHash>;
}

const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
const UNKNOWN = CommitSha.make("e".repeat(40));

export function describeProbeSourcesContract(adapter: string, make: () => ProbeSourcesHarness) {
  describe(`ProbeSources contract: ${adapter}`, () => {
    it.effect(
      "[probe-sources.src] reads every UTF-8 file under src/, whole and in path order, and nothing else",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const { repo, sha } = yield* harness.commit({
            "src/b.ts": "export const b = 2;\n",
            "src/a/x.ts": "export const x = 1;\n",
            "src/logo.bin": NOT_UTF8,
            "srcx/y.ts": "y\n",
            "README.md": "# r\n",
            "test/a.test.ts": "t\n",
          });
          expect(yield* (yield* ProbeSources).source(repo, sha)).toEqual([
            { path: "src/a/x.ts", text: "export const x = 1;\n" },
            { path: "src/b.ts", text: "export const b = 2;\n" },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-sources.hunks] writes each changed text file as git does, adding the head's lines",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const base = yield* harness.commit({
            "src/a.ts": "one\ntwo\nthree\n",
            "src/gone.ts": "gone\n",
            "src/same.ts": "same\n",
            "src/logo.bin": NOT_UTF8,
            "src/flip.txt": "text for now\n",
          });
          const head = yield* harness.commit({
            "src/a.ts": "one\ntwo\nthree\nfour\n",
            "src/new.ts": "new\n",
            "src/same.ts": "same\n",
            "src/logo.bin": new Uint8Array([0xff, 0xfe, 0x01]),
            "src/flip.txt": NOT_UTF8,
          });
          const hunks = yield* (yield* ProbeSources).hunks(base.repo, base.sha, head.sha);
          expect(addedLines(hunks, "src/a.ts")).toContain("four");
          expect(addedLines(hunks, "src/a.ts")).not.toContain("");
          expect(addedLines(hunks, "src/new.ts")).toEqual(["new"]);
          expect(addedLines(hunks, "src/gone.ts")).toBeUndefined();
          expect(hunks).toContain(
            "diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n",
          );
          expect(hunks).toContain(
            "diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n",
          );
          expect(hunks).toContain("-gone");
          expect(hunks).not.toContain("same.ts");
          expect(hunks).not.toContain("logo.bin");
          // A file that stops being text is not diffed as if it had been deleted.
          expect(hunks).not.toContain("flip.txt");
          expect(yield* (yield* ProbeSources).hunks(base.repo, base.sha, base.sha)).toBe("");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-sources.missing] fails, never answers empty, for a commit the repo does not hold",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const { repo, sha } = yield* harness.commit({ "src/a.ts": "a\n" });
          const sources = yield* ProbeSources;
          expect(Exit.isFailure(yield* Effect.exit(sources.source(repo, UNKNOWN)))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(sources.hunks(repo, sha, UNKNOWN)))).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export function describeNoopWorldsContract(adapter: string, make: () => NoopWorldsHarness) {
  describe(`NoopWorlds contract: ${adapter}`, () => {
    const files = {
      "src/routes.ts": "app.delete(path, async (c) => {\n  store.removeCollaborator(a, b);\n});\n",
      "src/store.ts": "export const store = {};\n",
    };
    const recipe = {
      path: "src/routes.ts",
      anchor: "store.removeCollaborator(a, b);",
      replacement: "/* noop */",
    };

    it.effect(
      "[noop-worlds.built] builds one world per recipe from A's world: the same recipe the same world, another recipe another, none of them A's",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const a = yield* harness.world(sampleNamespace, files);
          const worlds = yield* NoopWorlds;
          const first: ContentHash = yield* worlds.build(sampleNamespace, a, recipe);
          expect(yield* worlds.build(sampleNamespace, a, recipe)).toBe(first);
          expect(first).not.toBe(a);
          expect(
            yield* worlds.build(sampleNamespace, a, { ...recipe, replacement: "/* other */" }),
          ).not.toBe(first);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t5.noop-worlds.namespaces-apart] A's world is read from, and A-noop's kept for, the namespace named: neither is there for another",
      () => {
        const harness = make();
        const next = { path: "src/store.ts", anchor: "export const store = {};", replacement: "" };
        return Effect.gen(function* () {
          const a = yield* harness.world(sampleNamespace, files);
          const worlds = yield* NoopWorlds;
          // A's world is not the other namespace's to read: a defect, as for any bundle not in the store.
          expect(Exit.hasDies(yield* Effect.exit(worlds.build(otherNamespace, a, recipe)))).toBe(
            true,
          );
          const noop = yield* worlds.build(sampleNamespace, a, recipe);
          // A-noop's world is a world of its namespace, and only of it.
          expect(yield* worlds.build(sampleNamespace, noop, next)).not.toBe(noop);
          expect(Exit.hasDies(yield* Effect.exit(worlds.build(otherNamespace, noop, next)))).toBe(
            true,
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[noop-worlds.refused] refuses a recipe whose file or call is not in A's world once, saying which",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const a = yield* harness.world(sampleNamespace, {
            ...files,
            "src/twice.ts": "f();\nf();\n",
            "src/logo.bin": NOT_UTF8,
          });
          const worlds = yield* NoopWorlds;
          const refused = (r: typeof recipe) => Effect.flip(worlds.build(sampleNamespace, a, r));
          expect(yield* refused({ ...recipe, path: "src/absent.ts" })).toMatchObject({
            reason: "file-absent",
            path: "src/absent.ts",
          });
          expect(yield* refused({ ...recipe, path: "src/logo.bin" })).toMatchObject({
            reason: "file-absent",
          });
          expect(yield* refused({ ...recipe, anchor: "store.addCollaborator" })).toMatchObject({
            reason: "anchor-absent",
          });
          expect(yield* refused({ ...recipe, path: "src/twice.ts", anchor: "f();" })).toMatchObject(
            {
              reason: "anchor-ambiguous",
              count: 2,
            },
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
