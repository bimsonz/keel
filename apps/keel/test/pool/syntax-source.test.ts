import { describe, expect, it } from "@effect/vitest";
import type { RepoRef } from "@keeltown/core/ports";
import { CodeHost, SyntaxSource } from "@keeltown/core/ports";
import { describeSyntaxSourceContract, makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { SyntaxSourceTreeSitter } from "../../src/adapters/driven/syntax/syntax-source.ts";
import { SYNTAX_WASM } from "../../src/adapters/driven/syntax/wasm.ts";

const MAIN = "refs/heads/main";

/**
 * The adapter as the Worker runs it: tree-sitter's runtime and grammar as the
 * Worker's own Wasm modules, booted in workerd, over the in-memory CodeHost.
 */
const inWorkerd = () => {
  const host = makeCodeHostMemory();
  let repo: RepoRef | undefined;
  return {
    layer: SyntaxSourceTreeSitter(SYNTAX_WASM).pipe(Layer.provide(host.layer)),
    commit: (files: Readonly<Record<string, string | Uint8Array>>) =>
      Effect.gen(function* () {
        repo ??= yield* (yield* CodeHost).create(host.fixture.scratch());
        const sha = yield* host.fixture.commit(repo, MAIN, files);
        return { repo, sha };
      }).pipe(Effect.provide(host.layer), Effect.orDie),
  };
};

describeSyntaxSourceContract("tree-sitter in workerd", inWorkerd);

/** 16 KB that grows the parser's heap past any cap: a call left open, every argument a comparison or a generic. */
const HOSTILE = `f(${"a<b,".repeat(4096)}`;
const PLAIN = `
const plain = new Map<string, number>();
export function plainOf(key: string) {
  if (!plain.has(key)) plain.set(key, 1);
  return plain.get(key);
}
`;

describe("SyntaxSourceTreeSitter in workerd", () => {
  it.effect(
    "[syntaxsource.hostile-file] a file that grows the parser past its memory cap is skipped as unparseable, and the next file is read in the same isolate on a rebuilt parser",
    () => {
      const harness = inWorkerd();
      return Effect.gen(function* () {
        const source = yield* SyntaxSource;
        const { repo, sha } = yield* harness.commit({
          "src/hostile.ts": HOSTILE,
          "src/z-plain.ts": PLAIN,
        });
        const reading = yield* source.facts(repo, sha, ["src/hostile.ts", "src/z-plain.ts"]);
        expect(reading.skipped).toEqual([{ path: "src/hostile.ts", reason: "unparseable" }]);
        expect(reading.facts.stores).toEqual([
          { at: { path: "src/z-plain.ts", symbol: "plain" }, holder: "module", weak: false },
        ]);
        // `has` and `get` on one key in one symbol are one read.
        expect(reading.facts.accesses.map((access) => access.op).toSorted()).toEqual([
          "read",
          "write",
        ]);
        // The isolate is alive and the parser whole: a second call reads the same file again.
        const again = yield* source.facts(repo, sha, ["src/z-plain.ts"]);
        expect(again.skipped).toEqual([]);
        expect(again.facts.stores).toEqual(reading.facts.stores);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
