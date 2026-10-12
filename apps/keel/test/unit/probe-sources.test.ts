import { describe, expect, it } from "@effect/vitest";
import type { RepoRef } from "@keeltown/core/ports";
import { CodeHost, NoopWorlds } from "@keeltown/core/ports";
import { readBundle } from "@keeltown/runner-protocol";
import {
  type ContractTree,
  describeNoopWorldsContract,
  describeProbeSourcesContract,
  makeBundleStoreMemory,
  makeCodeHostMemory,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import {
  gitFileDiff,
  NoopWorldsCodeHost,
  ProbeSourcesCodeHost,
} from "../../src/adapters/driven/gitcore/probe-sources.ts";

const MAIN = "refs/heads/main";

/** An adapter over the in-memory CodeHost, which keeps real git objects: each commit is a whole tree on one repo's main. */
const over = <S>(adapter: (host: ReturnType<typeof makeCodeHostMemory>) => Layer.Layer<S>) => {
  const host = makeCodeHostMemory();
  let repo: RepoRef | undefined;
  return {
    host,
    layer: adapter(host),
    commit: (files: ContractTree) =>
      Effect.gen(function* () {
        repo ??= yield* (yield* CodeHost).create(host.fixture.scratch());
        const sha = yield* host.fixture.commit(repo, MAIN, files);
        return { repo, sha };
      }).pipe(Effect.provide(host.layer), Effect.orDie),
  };
};

const bundles = makeBundleStoreMemory();
const sources = () => over((host) => ProbeSourcesCodeHost.pipe(Layer.provide(host.layer)));
const noops = () =>
  over((host) => NoopWorldsCodeHost.pipe(Layer.provide(Layer.merge(host.layer, bundles.layer))));

describeProbeSourcesContract("CodeHost", sources);
describeNoopWorldsContract("CodeHost", noops);

const TEN = Array.from({ length: 10 }, (_, i) => `${i + 1}`).join("\n") + "\n";

describe("ProbeSourcesCodeHost", () => {
  it("[probe-sources.git-format] writes minimal hunks with three lines of context, exactly as git diff does", () => {
    expect(gitFileDiff("src/a.ts", TEN, TEN.replace("5\n", "five\n"))).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
    expect(gitFileDiff("src/n.ts", undefined, "one\ntwo\n")).toBe(
      "diff --git a/src/n.ts b/src/n.ts\n--- /dev/null\n+++ b/src/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    );
    expect(gitFileDiff("src/g.ts", "gone\n", undefined)).toBe(
      "diff --git a/src/g.ts b/src/g.ts\n--- a/src/g.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
    );
    expect(gitFileDiff("src/e.ts", "a", "b")).toBe(
      "diff --git a/src/e.ts b/src/e.ts\n--- a/src/e.ts\n+++ b/src/e.ts\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
    );
    expect(gitFileDiff("src/s.ts", TEN, TEN)).toBeUndefined();
  });
});

describe("NoopWorldsCodeHost", () => {
  it.effect(
    "[noop-worlds.bundle] bundles the premise-holder's whole tree with only the recipe's call replaced",
    () => {
      const h = noops();
      return Effect.gen(function* () {
        const { repo, sha } = yield* h.commit({
          "src/routes.ts": "remove();\nstore.removeCollaborator(a, b);\n",
          "src/store.ts": "export const store = {};\n",
          "package.json": "{}",
        });
        const hash = yield* (yield* NoopWorlds).build(repo, sha, {
          path: "src/routes.ts",
          anchor: "store.removeCollaborator(a, b);",
          replacement: "/* noop */",
        });
        const bytes = bundles.objects.get(hash);
        if (bytes === undefined) throw new Error("A-noop's bundle is not in the store");
        const files = yield* Effect.promise(() => readBundle(bytes));
        const decoder = new TextDecoder();
        expect(Object.fromEntries(files.map((f) => [f.path, decoder.decode(f.bytes)]))).toEqual({
          "src/routes.ts": "remove();\n/* noop */\n",
          "src/store.ts": "export const store = {};\n",
          "package.json": "{}",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
});
