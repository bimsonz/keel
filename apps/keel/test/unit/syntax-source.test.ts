import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { CommitSha } from "@keeltown/core/kernel";
import type { RepoRef } from "@keeltown/core/ports";
import { CodeHost, SyntaxSource } from "@keeltown/core/ports";
import {
  bootParser,
  openReading,
  ParserStarting,
  type PathKind,
  type SourceParser,
} from "@keeltown/syntax";
import {
  describeSyntaxSourceContract,
  type FixtureFiles,
  makeCodeHostMemory,
} from "@keeltown/testing";
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

/**
 * CodeHost with each call of every one of its methods logged by name in
 * `calls`, each directory `listDir` is asked for in `dirs`, and each it
 * fails for in `refused`, with the failure's tag.
 */
const logging = (calls: string[], dirs: string[], refused: string[]) => {
  const logged =
    <Args extends readonly unknown[], A, E>(
      name: string,
      method: (...args: Args) => Effect.Effect<A, E>,
    ) =>
    (...args: Args): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        calls.push(name);
        return method(...args);
      });
  return Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (host) =>
      CodeHost.of({
        create: logged("create", host.create),
        fork: logged("fork", host.fork),
        import: logged("import", host.import),
        branches: logged("branches", host.branches),
        mintToken: logged("mintToken", host.mintToken),
        info: logged("info", host.info),
        head: logged("head", host.head),
        hasCommit: logged("hasCommit", host.hasCommit),
        isAncestor: logged("isAncestor", host.isAncestor),
        readTree: logged("readTree", host.readTree),
        readBlob: logged("readBlob", host.readBlob),
        readBlobs: logged("readBlobs", host.readBlobs),
        listDir: logged("listDir", (repo: RepoRef, commit: CommitSha, path: string) => {
          dirs.push(path);
          return host
            .listDir(repo, commit, path)
            .pipe(Effect.tapError((e) => Effect.sync(() => refused.push(`${path} ${e._tag}`))));
        }),
        readCommit: logged("readCommit", host.readCommit),
        log: logged("log", host.log),
        diffTrees: logged("diffTrees", host.diffTrees),
        delete: logged("delete", host.delete),
      }),
    ),
  );
};

/** The parser, booted in this process; a boot under way elsewhere is waited out. */
const parser = async (): Promise<SourceParser> => {
  for (;;)
    try {
      return await bootParser(WASM);
    } catch (error) {
      if (!(error instanceof ParserStarting)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

/**
 * The reading the whole tree gives: every entry of the commit read at once,
 * a blob a regular file when its mode is one, and the same path rule over it.
 */
const wholeTreeReading = (repo: RepoRef, sha: CommitSha, seeds: readonly string[]) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const blobs = new Map<string, { readonly oid: string; readonly kind: PathKind }>();
    for (const entry of yield* host.readTree(repo, sha))
      if (entry.type !== "tree")
        blobs.set(entry.path, {
          oid: entry.oid,
          kind:
            entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")
              ? "file"
              : "other",
        });
    const up = yield* Effect.promise(parser);
    const reading = openReading(seeds, (path) => blobs.get(path)?.kind);
    for (let wanted = reading.wanted(); wanted.length > 0; wanted = reading.wanted())
      for (const path of wanted)
        expect(reading.give(path, yield* host.readBlob(repo, blobs.get(path)?.oid ?? ""), up)).toBe(
          "taken",
        );
    const result = reading.result();
    if ("unavailable" in result) throw new Error(`no reading: ${result.unavailable}`);
    return { facts: { commit: sha, ...result.facts }, skipped: result.skipped };
  });

/** Commits `files` to a fresh repo and reads it from `seeds` over a logged CodeHost: the reading, the whole tree's, and the calls the first made. */
const loggedReading = (files: FixtureFiles, seeds: readonly string[]) => {
  const host = makeCodeHostMemory();
  const calls: string[] = [];
  const dirs: string[] = [];
  const refused: string[] = [];
  const layer = SyntaxSourceTreeSitter(WASM).pipe(
    Layer.provide(logging(calls, dirs, refused).pipe(Layer.provide(host.layer))),
  );
  return Effect.gen(function* () {
    const repo = yield* (yield* CodeHost).create(host.fixture.scratch());
    const sha = yield* host.fixture.commit(repo, MAIN, files);
    const whole = yield* wholeTreeReading(repo, sha, seeds);
    const reading = yield* Effect.flatMap(SyntaxSource, (source) =>
      source.facts(repo, sha, seeds),
    ).pipe(Effect.provide(layer));
    return { sha, reading, whole, calls, dirs, refused };
  }).pipe(Effect.provide(host.layer), Effect.orDie);
};

const STORE = (name: string) => `
const ${name} = new Map<string, number>();
export function ${name}Of(key: string) {
  if (!${name}.has(key)) ${name}.set(key, 1);
  return ${name}.get(key);
}
`;

/**
 * A change's files and what they import: a sibling, a `.js` name for a `.ts`
 * file in another directory, a directory's index, a symlink, a path in a
 * directory the commit lacks, and a bare package re-exported.
 */
const SMALL: FixtureFiles = {
  "src/a.ts": `
import { bOf } from "./b";
import { cOf } from "../lib/c.js";
import { dOf } from "./dir";
import { linked } from "./link";
import { gone } from "./missing/x";
export * from "pkg";
export function a(key: string) {
  return bOf(key) ?? cOf(key) ?? dOf(key) ?? linked(key) ?? gone(key);
}
`,
  "src/b.ts": STORE("b"),
  "lib/c.ts": `import { eOf } from "../vendor/e";\n${STORE("c")}`,
  "src/dir/index.ts": STORE("d"),
  "src/link.ts": { mode: "120000", data: "b.ts" },
};
const SEEDS = ["src/a.ts", "src/new.ts"];
/**
 * The directories the reading needs: the seeds', then each level's that a
 * listed directory above does not already show absent (`src/b`, `src/link`,
 * `src/missing` and `src/pkg` are not in `src`'s listing).
 */
const NEEDED = ["lib", "lib/c.js", "src", "src/dir", "vendor", "vendor/e"];

/** SMALL among hundreds of files nothing imports, in many directories, `src` among them. */
const LARGE: FixtureFiles = {
  ...SMALL,
  ...Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [
      i % 4 === 0
        ? `src/noise-${i}.ts`
        : `noise/d${String(i % 37).padStart(2, "0")}/f${String(i).padStart(3, "0")}.ts`,
      STORE(`n${i}`),
    ]),
  ),
};

describe("SyntaxSourceTreeSitter over CodeHost", () => {
  it.effect(
    "[syntaxsource.reads-directories] lists only the directories the seeds and their imports need, the same for a small repo and a large one, never the whole tree, and reads what the whole tree gives",
    () =>
      Effect.gen(function* () {
        const small = yield* loggedReading(SMALL, SEEDS);
        const large = yield* loggedReading(LARGE, SEEDS);
        for (const { reading, whole, calls, dirs } of [small, large]) {
          expect({ facts: reading.facts, skipped: reading.skipped }).toEqual(whole);
          expect(calls).not.toContain("readTree");
          expect(dirs.toSorted()).toEqual(NEEDED);
        }
        expect(small.reading.facts.calls.map((call) => call.to.path).toSorted()).toEqual([
          "lib/c.ts",
          "src/b.ts",
          "src/dir/index.ts",
        ]);
        expect(small.reading.skipped).toEqual([
          { path: "src/link.ts", reason: "unsupported" },
          { path: "src/new.ts", reason: "absent" },
        ]);
        expect(large.reading.facts).toEqual({ ...small.reading.facts, commit: large.sha });
        expect(large.calls).toEqual(small.calls);
      }),
    60_000,
  );

  it.effect(
    "[syntaxsource.missing-dir] an import into a directory the commit lacks reads as absent, not as a failure",
    () =>
      Effect.gen(function* () {
        const files: FixtureFiles = {
          "src/a.ts": `import { gone } from "../vendor/x/y";\n${STORE("a")}`,
        };
        const { reading, whole, dirs, refused } = yield* loggedReading(files, ["src/a.ts"]);
        expect({ facts: reading.facts, skipped: reading.skipped }).toEqual(whole);
        expect(reading.skipped).toEqual([]);
        expect(reading.facts.stores).toHaveLength(1);
        // The directories were asked for, and the host answered that they are not there.
        expect(dirs.toSorted()).toEqual(["src", "vendor/x", "vendor/x/y"]);
        expect(refused.toSorted()).toEqual(["vendor/x PathNotFound", "vendor/x/y PathNotFound"]);
      }),
  );
});
