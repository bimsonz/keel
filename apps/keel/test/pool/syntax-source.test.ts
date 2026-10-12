import type { RepoRef } from "@keeltown/core/ports";
import { CodeHost } from "@keeltown/core/ports";
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
