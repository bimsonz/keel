import { describe, expect, it } from "@effect/vitest";
import { CommitSha } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef, type TreeChange } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { CodeHostFixture, type FixtureFiles } from "../code-host-fixture.ts";
import type { LayerFactory } from "./index.ts";

const MAIN = "refs/heads/main";
const GITLINK = "1".repeat(40);

/** A commit id no repo holds. */
const unknownSha = () => Schema.decodeUnknownSync(CommitSha)([...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join(""));

/** Base and head for the diff case: a mode change, two type changes, a dir/file swap each way, an add, and an untouched subtree. */
const BASE: FixtureFiles = {
  "a/x": "x\n",
  b: "z\n",
  g: "g\n",
  "keep/deep/file": "same\n",
  l: "l\n",
  m: "m\n",
};
const HEAD: FixtureFiles = {
  a: "nowfile\n",
  "b/inner": "bb\n",
  g: { mode: "160000", data: GITLINK },
  "keep/deep/file": "same\n",
  l: { mode: "120000", data: "target" },
  m: { mode: "100755", data: "m\n" },
  "new.txt": "new\n",
};

/** A fresh, created repo. */
const freshRepo = Effect.gen(function* () {
  const host = yield* CodeHost;
  const fixture = yield* CodeHostFixture;
  return yield* host.create(fixture.scratch());
});

const oidAt = (entries: readonly { readonly path: string; readonly oid: string }[], path: string) => entries.find((e) => e.path === path)?.oid ?? "";

const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => e._tag);

export function describeCodeHostContract(adapter: string, make: LayerFactory<CodeHost | CodeHostFixture>) {
  describe(`CodeHost contract: ${adapter}`, () => {
    it.live("[codehost.head] head reads the commit a ref points at; a missing ref fails RefNotFound", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        expect(yield* Effect.flip(host.head(repo, MAIN))).toMatchObject({ _tag: "RefNotFound", ref: MAIN });
        const first = yield* fixture.commit(repo, MAIN, { f: "1\n" });
        expect(yield* host.head(repo, MAIN)).toBe(first);
        const second = yield* fixture.commit(repo, MAIN, { f: "2\n" });
        expect(second).not.toBe(first);
        expect(yield* host.head(repo, MAIN)).toBe(second);
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.read-tree] readTree lists the whole tree in git order, a tree before its contents; readBlob returns the bytes", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        const head = yield* fixture.commit(repo, MAIN, HEAD);
        const entries = yield* host.readTree(repo, head);
        expect(entries.map((e) => [e.path, e.type, e.mode])).toEqual([
          ["a", "blob", "100644"],
          ["b", "tree", "40000"],
          ["b/inner", "blob", "100644"],
          ["g", "commit", "160000"],
          ["keep", "tree", "40000"],
          ["keep/deep", "tree", "40000"],
          ["keep/deep/file", "blob", "100644"],
          ["l", "blob", "120000"],
          ["m", "blob", "100755"],
          ["new.txt", "blob", "100644"],
        ]);
        expect(entries.find((e) => e.path === "g")?.oid).toBe(GITLINK);
        const blob = entries.find((e) => e.path === "b/inner");
        expect(new TextDecoder().decode(yield* host.readBlob(repo, blob?.oid ?? ""))).toBe("bb\n");
        const link = entries.find((e) => e.path === "l");
        expect(new TextDecoder().decode(yield* host.readBlob(repo, link?.oid ?? ""))).toBe("target");
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.missing-repo] every read of a repo that does not exist fails RepoNotFound", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const ghost: RepoRef = fixture.scratch();
        const sha = unknownSha();
        const tags = [
          yield* tagOf(host.head(ghost, MAIN)),
          yield* tagOf(host.readTree(ghost, sha)),
          yield* tagOf(host.readBlob(ghost, sha)),
          yield* tagOf(host.diffTrees(ghost, sha, sha)),
          yield* tagOf(host.mintToken(ghost, "read", 60)),
          yield* tagOf(host.fork(ghost, fixture.scratch())),
        ];
        expect(tags).toEqual(Array.from({ length: 6 }, () => "RepoNotFound"));
        expect(yield* Effect.flip(host.head(ghost, MAIN))).toMatchObject({ repo: { namespace: ghost.namespace, name: ghost.name } });
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.missing-object] a commit or blob the repo lacks fails ObjectNotFound, naming the id", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        const known = yield* fixture.commit(repo, MAIN, BASE);
        const missing = unknownSha();
        const errors = [
          yield* Effect.flip(host.readTree(repo, missing)),
          yield* Effect.flip(host.readBlob(repo, missing)),
          yield* Effect.flip(host.diffTrees(repo, missing, known)),
          yield* Effect.flip(host.diffTrees(repo, known, missing)),
        ];
        expect(errors).toMatchObject(Array.from({ length: 4 }, () => ({ _tag: "ObjectNotFound", oid: missing })));
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.fork] a fork copies refs and content, then moves independently and outlives its source", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const source = yield* freshRepo;
        const base = yield* fixture.commit(source, MAIN, BASE);
        const target = yield* host.fork(source, fixture.scratch());
        expect(yield* host.head(target, MAIN)).toBe(base);
        expect(yield* host.readTree(target, base)).toEqual(yield* host.readTree(source, base));
        const moved = yield* fixture.commit(target, MAIN, HEAD);
        expect(yield* host.head(source, MAIN)).toBe(base);
        yield* host.delete(source);
        expect(yield* host.head(target, MAIN)).toBe(moved);
        expect((yield* host.diffTrees(target, base, moved)).length).toBeGreaterThan(0);
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.token] a minted token carries the requested access and expires about ttl from now", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const repo = yield* freshRepo;
        for (const [access, ttl] of [["read", 120], ["write", 600]] as const) {
          const token = yield* host.mintToken(repo, access, ttl);
          expect(token.access).toBe(access);
          expect(token.token.length).toBeGreaterThan(0);
          // A real host stamps expiry with its own clock: allow a minute of skew.
          expect(Math.abs(token.expiresAt - (Date.now() + ttl * 1000))).toBeLessThan(60_000);
        }
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.diff] diffTrees gives git diff-tree -r's rows in path order, mirrored when reversed, and none for one commit", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        const base = yield* fixture.commit(repo, MAIN, BASE);
        const head = yield* fixture.commit(repo, MAIN, HEAD);
        const was = yield* host.readTree(repo, base);
        const now = yield* host.readTree(repo, head);
        const expected: TreeChange[] = [
          { path: "a", change: "added", newOid: oidAt(now, "a"), newMode: "100644" },
          { path: "a/x", change: "deleted", oldOid: oidAt(was, "a/x"), oldMode: "100644" },
          { path: "b", change: "deleted", oldOid: oidAt(was, "b"), oldMode: "100644" },
          { path: "b/inner", change: "added", newOid: oidAt(now, "b/inner"), newMode: "100644" },
          { path: "g", change: "type-changed", oldOid: oidAt(was, "g"), newOid: GITLINK, oldMode: "100644", newMode: "160000" },
          { path: "l", change: "type-changed", oldOid: oidAt(was, "l"), newOid: oidAt(now, "l"), oldMode: "100644", newMode: "120000" },
          { path: "m", change: "modified", oldOid: oidAt(was, "m"), newOid: oidAt(was, "m"), oldMode: "100644", newMode: "100755" },
          { path: "new.txt", change: "added", newOid: oidAt(now, "new.txt"), newMode: "100644" },
        ];
        expect(yield* host.diffTrees(repo, base, head)).toEqual(expected);
        const reversed = yield* host.diffTrees(repo, head, base);
        expect(reversed.map((r) => [r.path, r.change, r.oldMode ?? "-", r.newMode ?? "-"])).toEqual([
          ["a", "deleted", "100644", "-"],
          ["a/x", "added", "-", "100644"],
          ["b", "added", "-", "100644"],
          ["b/inner", "deleted", "100644", "-"],
          ["g", "type-changed", "160000", "100644"],
          ["l", "type-changed", "120000", "100644"],
          ["m", "modified", "100755", "100644"],
          ["new.txt", "deleted", "100644", "-"],
        ]);
        expect(yield* host.diffTrees(repo, head, head)).toEqual([]);
      }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.delete] after delete every read fails RepoNotFound, and deleting again succeeds", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        const commit = yield* fixture.commit(repo, MAIN, BASE);
        yield* host.delete(repo);
        expect([yield* tagOf(host.head(repo, MAIN)), yield* tagOf(host.readTree(repo, commit))]).toEqual(["RepoNotFound", "RepoNotFound"]);
        yield* host.delete(repo);
        expect(yield* tagOf(host.mintToken(repo, "read", 60))).toBe("RepoNotFound");
      }).pipe(Effect.provide(make())),
    );
  });
}
