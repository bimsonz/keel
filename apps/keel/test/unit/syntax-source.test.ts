import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RepoRef } from "@keeltown/core/ports";
import { CodeHost } from "@keeltown/core/ports";
import { describeSyntaxSourceContract, makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { SyntaxSourceTreeSitter } from "../../src/adapters/driven/syntax/syntax-source.ts";

const MAIN = "refs/heads/main";
// The Worker's types give `WebAssembly.Module` no constructor, because a Worker is handed its
// modules compiled. This test runs in Node, which compiles them here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node's constructor, absent from the Worker's types
const Compiled = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
const compiled = (specifier: string): WebAssembly.Module =>
  new Compiled(readFileSync(fileURLToPath(import.meta.resolve(specifier))));
/** In Node the two modules are compiled from the packages' files; the Worker imports them compiled. */
const WASM = {
  runtime: compiled("web-tree-sitter/web-tree-sitter.wasm"),
  grammar: compiled("tree-sitter-typescript/tree-sitter-typescript.wasm"),
};

/** The adapter over the in-memory CodeHost, which keeps real git objects: each commit is a whole tree on one repo's main. */
const overCodeHost = () => {
  const host = makeCodeHostMemory();
  let repo: RepoRef | undefined;
  return {
    layer: SyntaxSourceTreeSitter(WASM).pipe(Layer.provide(host.layer)),
    commit: (files: Readonly<Record<string, string | Uint8Array>>) =>
      Effect.gen(function* () {
        repo ??= yield* (yield* CodeHost).create(host.fixture.scratch());
        const sha = yield* host.fixture.commit(repo, MAIN, files);
        return { repo, sha };
      }).pipe(Effect.provide(host.layer), Effect.orDie),
  };
};

describeSyntaxSourceContract("tree-sitter over CodeHost", overCodeHost);
