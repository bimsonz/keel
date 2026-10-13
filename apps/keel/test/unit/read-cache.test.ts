// The read cache over an in-memory code host: what it keeps, what it never
// keeps, and how far it grows. A Map stands in for the colo's cache.
import { describe, expect, it } from "@effect/vitest";
import type { CommitSha } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import {
  CodeHostReadCache,
  makeMemoryTier,
  type MemoryTier,
} from "../../src/adapters/driven/artifacts/read-cache.ts";

const MAIN = "refs/heads/main";
const A = { namespace: "keel-core", name: "cache-a" };
const B = { namespace: "keel-core", name: "cache-b" };

const keyText = (key: RequestInfo | URL): string =>
  typeof key === "string" ? key : key instanceof URL ? key.href : key.url;

/** A colo's cache in a Map: what was put, by key, as bytes. */
function sharedCache() {
  const kept = new Map<string, Uint8Array>();
  const cache: Cache = {
    match: async (key) => {
      const bytes = kept.get(keyText(key));
      return bytes === undefined ? undefined : new Response(bytes);
    },
    put: async (key, response) => {
      kept.set(keyText(key), new Uint8Array(await response.arrayBuffer()));
    },
    delete: async (key) => kept.delete(keyText(key)),
  };
  return { kept, cache };
}

/** The cache over a memory host whose every read by id is counted, by method. */
function cachedHost(options: { readonly memory?: MemoryTier; readonly shared?: Cache } = {}) {
  const code = makeCodeHostMemory();
  const reads = new Map<string, number>();
  const count = (method: string) => reads.set(method, (reads.get(method) ?? 0) + 1);
  const counted = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (host) =>
      CodeHost.of({
        ...host,
        readBlob: (repo, oid) =>
          Effect.suspend(() => (count("readBlob"), host.readBlob(repo, oid))),
        readCommit: (repo, sha) =>
          Effect.suspend(() => (count("readCommit"), host.readCommit(repo, sha))),
        readTree: (repo, commit) =>
          Effect.suspend(() => (count("readTree"), host.readTree(repo, commit))),
        listDir: (repo, commit, path) =>
          Effect.suspend(() => (count("listDir"), host.listDir(repo, commit, path))),
        diffTrees: (repo, base, head) =>
          Effect.suspend(() => (count("diffTrees"), host.diffTrees(repo, base, head))),
        hasCommit: (repo, sha) =>
          Effect.suspend(() => (count("hasCommit"), host.hasCommit(repo, sha))),
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const background: Promise<unknown>[] = [];
  const layer = CodeHostReadCache({
    host: "keel.test",
    memory: options.memory ?? makeMemoryTier(),
    shared: options.shared,
    background: (work) => background.push(work),
  }).pipe(Layer.provide(counted));
  return { code, reads, background, layer };
}

/** A repo with two commits on main: `base`, then `head`, which edits one file and adds another. */
const seeded = (code: ReturnType<typeof makeCodeHostMemory>, repo = A) =>
  Effect.gen(function* () {
    yield* (yield* CodeHost).create(repo);
    const base = yield* code.fixture.commit(repo, MAIN, {
      "README.md": "one\n",
      "src/a.ts": "a\n",
    });
    const head = yield* code.fixture.commit(repo, MAIN, {
      "README.md": "two\n",
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
    });
    return { base, head };
  }).pipe(Effect.provide(code.layer));

/** Every read by id, once, at `head` and from `base`. */
const readAll = (base: CommitSha, head: CommitSha, repo = A) =>
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const tree = yield* host.readTree(repo, head);
    const readme = tree.find((entry) => entry.path === "README.md");
    if (readme === undefined) throw new Error("the fixture has a README");
    return {
      blob: new TextDecoder().decode(yield* host.readBlob(repo, readme.oid)),
      commit: (yield* host.readCommit(repo, head)).parents,
      dir: (yield* host.listDir(repo, head, "src")).map((entry) => entry.path),
      diff: (yield* host.diffTrees(repo, base, head)).map((change) => change.path),
      held: yield* host.hasCommit(repo, base),
      readme: readme.oid,
    };
  });

describe("the read cache", () => {
  it.effect(
    "[cache.hit] a second read of the same id answers the same and reaches the host no more",
    () => {
      const w = cachedHost();
      return Effect.gen(function* () {
        const { base, head } = yield* seeded(w.code);
        const first = yield* readAll(base, head).pipe(Effect.provide(w.layer));
        const again = yield* readAll(base, head).pipe(Effect.provide(w.layer));
        expect(again).toEqual(first);
        expect(first).toMatchObject({ blob: "two\n", commit: [base], held: true });
        expect(first.dir).toEqual(["src/a.ts", "src/b.ts"]);
        expect(first.diff).toEqual(["README.md", "src/b.ts"]);
        expect(Object.fromEntries(w.reads)).toEqual({
          readTree: 1,
          readBlob: 1,
          readCommit: 1,
          listDir: 1,
          diffTrees: 1,
          hasCommit: 1,
        });
      });
    },
  );

  it.effect(
    "[cache.misses-not-kept] a repo that is not there, and a commit a repo lacks, are read again once they are",
    () => {
      const w = cachedHost();
      return Effect.gen(function* () {
        const { head } = yield* seeded(w.code, B);
        const host = yield* CodeHost;
        const C = { ...A, name: "cache-c" };
        expect((yield* Effect.flip(host.readCommit(C, head)))._tag).toBe("RepoNotFound");
        yield* host.create(A);
        expect(yield* host.hasCommit(A, head)).toBe(false);
        expect((yield* Effect.flip(host.readCommit(A, head)))._tag).toBe("ObjectNotFound");
        yield* host.delete(A);
        yield* host.fork(B, A);
        yield* host.fork(B, C);
        expect(yield* host.hasCommit(A, head)).toBe(true);
        expect((yield* host.readCommit(A, head)).sha).toBe(head);
        expect((yield* host.readCommit(C, head)).sha).toBe(head);
        expect(w.reads.get("hasCommit")).toBe(2);
        expect(w.reads.get("readCommit")).toBe(4);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect("[cache.by-repo] an object one repo holds is never served as another's", () => {
    const w = cachedHost();
    return Effect.gen(function* () {
      const { base, head } = yield* seeded(w.code, A);
      const host = yield* CodeHost;
      yield* host.create(B);
      const inA = yield* readAll(base, head, A);
      expect((yield* Effect.flip(host.readBlob(B, inA.readme)))._tag).toBe("ObjectNotFound");
      expect(yield* host.hasCommit(B, base)).toBe(false);
      expect(w.reads.get("readBlob")).toBe(2);
    }).pipe(Effect.provide(w.layer));
  });

  it("[cache.bounded] memory keeps at most its entries and its bytes, dropping the least recently used, and never a value heavier than an eighth of its bytes", () => {
    const byCount = makeMemoryTier({ entries: 2, bytes: 1000 });
    byCount.set("a", 1, 10);
    byCount.set("b", 2, 10);
    expect(byCount.get("a")).toBe(1);
    byCount.set("c", 3, 10);
    expect([byCount.get("a"), byCount.get("b"), byCount.get("c")]).toEqual([1, undefined, 3]);
    expect(byCount.size()).toEqual({ entries: 2, bytes: 20 });

    const byWeight = makeMemoryTier({ entries: 100, bytes: 800 });
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) byWeight.set(key, key, 100);
    expect(byWeight.size()).toEqual({ entries: 8, bytes: 800 });
    byWeight.set("i", "i", 100);
    expect(byWeight.get("a")).toBeUndefined();
    expect(byWeight.size()).toEqual({ entries: 8, bytes: 800 });
    byWeight.set("heavy", "heavy", 101);
    expect(byWeight.get("heavy")).toBeUndefined();
    expect(byWeight.size()).toEqual({ entries: 8, bytes: 800 });
  });

  it.effect(
    "[cache.shared] another isolate is answered from the colo's cache, written in the background, and an entry it cannot read is a miss",
    () => {
      const shared = sharedCache();
      const first = cachedHost({ shared: shared.cache });
      return Effect.gen(function* () {
        const { base, head } = yield* seeded(first.code);
        const read = yield* readAll(base, head).pipe(Effect.provide(first.layer));
        yield* Effect.promise(() => Promise.all(first.background));
        expect(first.background).toHaveLength(6);
        expect(shared.kept.size).toBe(6);

        const second = cachedHost({ shared: shared.cache });
        const fromShared = yield* readAll(base, head).pipe(Effect.provide(second.layer));
        expect(fromShared).toEqual(read);
        expect(second.reads.size).toBe(0);

        for (const key of shared.kept.keys())
          if (key.includes("/commit/")) shared.kept.set(key, new TextEncoder().encode("{"));
        const third = cachedHost({ shared: shared.cache });
        const unreadable = yield* Effect.flip(
          Effect.flatMap(CodeHost, (host) => host.readCommit(A, head)),
        ).pipe(Effect.provide(third.layer));
        expect(unreadable._tag).toBe("RepoNotFound");
        expect(Object.fromEntries(third.reads)).toEqual({ readCommit: 1 });
      });
    },
  );
});
