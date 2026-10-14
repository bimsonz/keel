import { describe, expect, it } from "@effect/vitest";
import { CommitSha } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef, type TreeChange } from "@keeltown/core/ports";
import { Effect, Result, Schema } from "effect";
import { CodeHostFixture, type FixtureFiles } from "../code-host-fixture.ts";
import type { LayerFactory } from "./index.ts";

const MAIN = "refs/heads/main";
const GITLINK = "1".repeat(40);

/** A commit id no repo holds. */
const unknownSha = () =>
  Schema.decodeUnknownSync(CommitSha)(
    [...crypto.getRandomValues(new Uint8Array(20))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );

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

/**
 * An agent's merge of trunk, as `git fetch origin keel/trunk && git merge
 * FETCH_HEAD` leaves it: `work` and `trunk` both on `base`, and `merge`
 * parented on `work` first and `trunk` second.
 */
const mergeHistory = Effect.gen(function* () {
  const fixture = yield* CodeHostFixture;
  const repo = yield* freshRepo;
  const base = yield* fixture.commit(repo, MAIN, { f: "base\n" });
  const work = yield* fixture.commit(repo, MAIN, { f: "work\n" });
  const trunk = yield* fixture.commit(repo, "refs/heads/trunk", { f: "trunk\n" }, [base]);
  const merge = yield* fixture.commit(repo, MAIN, { f: "merged\n" }, [trunk]);
  return { repo, base, work, trunk, merge };
});

/** A fresh, created repo. */
const freshRepo = Effect.gen(function* () {
  const host = yield* CodeHost;
  const fixture = yield* CodeHostFixture;
  return yield* host.create(fixture.scratch());
});

const oidAt = (entries: readonly { readonly path: string; readonly oid: string }[], path: string) =>
  entries.find((e) => e.path === path)?.oid ?? "";

const shas = (commits: readonly { readonly sha: string }[]) => commits.map((c) => c.sha);

const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => e._tag);

export function describeCodeHostContract(
  adapter: string,
  make: LayerFactory<CodeHost | CodeHostFixture>,
) {
  describe(`CodeHost contract: ${adapter}`, () => {
    it.live(
      "[codehost.head] head reads the commit a ref points at; a missing ref fails RefNotFound",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          expect(yield* Effect.flip(host.head(repo, MAIN))).toMatchObject({
            _tag: "RefNotFound",
            ref: MAIN,
          });
          const first = yield* fixture.commit(repo, MAIN, { f: "1\n" });
          expect(yield* host.head(repo, MAIN)).toBe(first);
          const second = yield* fixture.commit(repo, MAIN, { f: "2\n" });
          expect(second).not.toBe(first);
          expect(yield* host.head(repo, MAIN)).toBe(second);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.read-tree] readTree lists the whole tree in git order, a tree before its contents; readBlob returns the bytes",
      () =>
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
          expect(new TextDecoder().decode(yield* host.readBlob(repo, blob?.oid ?? ""))).toBe(
            "bb\n",
          );
          const link = entries.find((e) => e.path === "l");
          expect(new TextDecoder().decode(yield* host.readBlob(repo, link?.oid ?? ""))).toBe(
            "target",
          );
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.read-blobs] readBlobs answers each blob as readBlob does, in the order asked, a repeat included; a blob the repo lacks is that one's ObjectNotFound and the rest are still read",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          const head = yield* fixture.commit(repo, MAIN, HEAD);
          const entries = yield* host.readTree(repo, head);
          const missing = unknownSha();
          const asked = [
            oidAt(entries, "new.txt"),
            oidAt(entries, "b/inner"),
            missing,
            oidAt(entries, "l"),
            oidAt(entries, "new.txt"),
          ];
          const read = yield* host.readBlobs(repo, asked);
          expect(
            read.map((r) =>
              Result.isSuccess(r) ? new TextDecoder().decode(r.success) : r.failure,
            ),
          ).toMatchObject([
            "new\n",
            "bb\n",
            {
              _tag: "ObjectNotFound",
              repo: { namespace: repo.namespace, name: repo.name },
              oid: missing,
            },
            "target",
            "new\n",
          ]);
          expect(yield* host.readBlobs(repo, [])).toEqual([]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.missing-repo] every read of a repo that does not exist fails RepoNotFound",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const ghost: RepoRef = fixture.scratch();
          const sha = unknownSha();
          const tags = [
            yield* tagOf(host.head(ghost, MAIN)),
            yield* tagOf(host.readTree(ghost, sha)),
            yield* tagOf(host.readBlob(ghost, sha)),
            yield* tagOf(host.readBlobs(ghost, [sha])),
            yield* tagOf(host.diffTrees(ghost, sha, sha)),
            yield* tagOf(host.mintToken(ghost, "read", 60)),
            yield* tagOf(host.info(ghost)),
            yield* tagOf(host.hasCommit(ghost, sha)),
            yield* tagOf(host.fork(ghost, fixture.scratch())),
            yield* tagOf(host.listDir(ghost, sha, "")),
            yield* tagOf(host.readCommit(ghost, sha)),
            yield* tagOf(host.log(ghost, sha, 5)),
            yield* tagOf(host.isAncestor(ghost, sha, unknownSha(), [])),
          ];
          expect(tags).toEqual(Array.from({ length: 13 }, () => "RepoNotFound"));
          expect(yield* Effect.flip(host.head(ghost, MAIN))).toMatchObject({
            repo: { namespace: ghost.namespace, name: ghost.name },
          });
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.missing-object] a commit or blob the repo lacks fails ObjectNotFound, naming the id",
      () =>
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
            yield* Effect.flip(host.listDir(repo, missing, "")),
            yield* Effect.flip(host.readCommit(repo, missing)),
            yield* Effect.flip(host.log(repo, missing, 5)),
            yield* Effect.flip(host.isAncestor(repo, known, missing, [])),
          ];
          expect(errors).toMatchObject(
            Array.from({ length: 8 }, () => ({ _tag: "ObjectNotFound", oid: missing })),
          );
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.list-dir] listDir lists one directory's entries in git order with repo paths; a file or absent path fails PathNotFound",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          const head = yield* fixture.commit(repo, MAIN, HEAD);
          const all = yield* host.readTree(repo, head);
          const root = yield* host.listDir(repo, head, "");
          expect(root.map((e) => [e.path, e.type])).toEqual([
            ["a", "blob"],
            ["b", "tree"],
            ["g", "commit"],
            ["keep", "tree"],
            ["l", "blob"],
            ["m", "blob"],
            ["new.txt", "blob"],
          ]);
          expect(root.find((e) => e.path === "l")?.mode).toBe("120000");
          expect(root.find((e) => e.path === "m")?.mode).toBe("100755");
          const deep = yield* host.listDir(repo, head, "keep/deep");
          expect(deep).toEqual([
            {
              path: "keep/deep/file",
              mode: "100644",
              oid: oidAt(all, "keep/deep/file"),
              type: "blob",
            },
          ]);
          expect((yield* host.listDir(repo, head, "keep")).map((e) => e.path)).toEqual([
            "keep/deep",
          ]);
          for (const path of ["new.txt", "nope", "keep/nope", "keep/deep/file/x", "g"])
            expect(yield* Effect.flip(host.listDir(repo, head, path))).toMatchObject({
              _tag: "PathNotFound",
              path,
              commit: head,
            });
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.log] log walks the first-parent chain from the given commit, newest first, as many as asked; readCommit decodes one",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          const first = yield* fixture.commit(repo, MAIN, { f: "1\n" });
          const second = yield* fixture.commit(repo, MAIN, { f: "2\n" });
          const third = yield* fixture.commit(repo, MAIN, { f: "3\n" });
          expect(shas(yield* host.log(repo, third, 10))).toEqual([third, second, first]);
          expect(shas(yield* host.log(repo, third, 2))).toEqual([third, second]);
          expect(shas(yield* host.log(repo, second, 10))).toEqual([second, first]);
          expect(shas(yield* host.log(repo, first, 1))).toEqual([first]);
          const read = yield* host.readCommit(repo, second);
          const who = {
            name: "keel fixture",
            email: "fixture@keel.invalid",
            at: 1_760_000_000_000,
          };
          expect(read).toEqual({
            sha: second,
            tree: read.tree,
            parents: [first],
            message: "fixture",
            author: who,
            committer: who,
          });
          expect(read.tree).toMatch(/^[0-9a-f]{40}$/);
          expect((yield* host.readCommit(repo, first)).parents).toEqual([]);
          expect((yield* host.log(repo, third, 10))[1]).toEqual(read);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.log-merge] log follows a merge's first parent only, never the trunk it merged",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const { repo, base, work, trunk, merge } = yield* mergeHistory;
          expect((yield* host.readCommit(repo, merge)).parents).toEqual([work, trunk]);
          expect(shas(yield* host.log(repo, merge, 10))).toEqual([merge, work, base]);
          expect(shas(yield* host.log(repo, merge, 2))).toEqual([merge, work]);
          expect(shas(yield* host.log(repo, trunk, 10))).toEqual([trunk, base]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.fork] a fork copies refs and content, then moves independently and outlives its source",
      () =>
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

    it.live(
      "[codehost.exists] create or fork onto a taken name fails RepoAlreadyExists and leaves that repo as it was",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const source = yield* freshRepo;
          yield* fixture.commit(source, MAIN, BASE);
          const taken = yield* freshRepo;
          const kept = yield* fixture.commit(taken, MAIN, HEAD);
          expect(yield* Effect.flip(host.create(taken))).toMatchObject({
            _tag: "RepoAlreadyExists",
            repo: { namespace: taken.namespace, name: taken.name },
          });
          expect(yield* Effect.flip(host.fork(source, taken))).toMatchObject({
            _tag: "RepoAlreadyExists",
            repo: { namespace: taken.namespace, name: taken.name },
          });
          expect(yield* host.head(taken, MAIN)).toBe(kept);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.contract.branches] branches lists every branch with its head, in name order, and nothing for a repo with no commit",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          expect(yield* host.branches(repo)).toEqual([]);
          const main = yield* fixture.commit(repo, MAIN, BASE);
          const side = yield* fixture.commit(repo, "refs/heads/a/side", HEAD, [main]);
          expect(yield* host.branches(repo)).toEqual([
            { ref: "refs/heads/a/side", commit: side },
            { ref: MAIN, commit: main },
          ]);
          expect(yield* tagOf(host.branches(fixture.scratch()))).toBe("RepoNotFound");
          // What an import answered is what the repo's branches say afterwards.
          const { url } = yield* fixture.upstreams;
          const target = fixture.scratch();
          const came = yield* host.import({ url }, target);
          expect(yield* host.branches(target)).toEqual([came]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.contract.import] an import brings one branch under its own name and answers it with its head",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const { url, byDefault, other } = yield* fixture.upstreams;
          const target = fixture.scratch();
          expect(yield* host.import({ url }, target)).toEqual({
            ref: byDefault.ref,
            commit: byDefault.commit,
          });
          expect(yield* host.head(target, byDefault.ref)).toBe(byDefault.commit);
          expect((yield* host.readCommit(target, byDefault.commit)).sha).toBe(byDefault.commit);
          // The upstream's default branch is not main, and nothing called main came with it.
          expect(byDefault.ref).not.toBe(MAIN);
          expect(yield* tagOf(host.head(target, MAIN))).toBe("RefNotFound");
          // A named branch comes instead of the default one, and alone.
          const named = fixture.scratch();
          expect(yield* host.import({ url, ref: other.name }, named)).toEqual({
            ref: other.ref,
            commit: other.commit,
          });
          expect(yield* host.head(named, other.ref)).toBe(other.commit);
          expect(yield* tagOf(host.head(named, byDefault.ref))).toBe("RefNotFound");
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.contract.import-refused] an import of nothing, of something that is not git or of a branch the upstream lacks is refused, and no repo is left",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const { url, missing, notGit } = yield* fixture.upstreams;
          const refusals = [
            [{ url: missing }, "not-found"],
            [{ url: notGit }, "not-git"],
            [{ url, ref: "no-such-branch" }, "no-branch"],
          ] as const;
          for (const [source, reason] of refusals) {
            const target = fixture.scratch();
            expect([source, yield* Effect.flip(host.import(source, target))]).toMatchObject([
              source,
              { _tag: "ImportRefused", reason },
            ]);
            expect([source, yield* tagOf(host.info(target))]).toEqual([source, "RepoNotFound"]);
          }
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.contract.import-exists] an import onto a taken name fails RepoAlreadyExists and leaves that repo as it was",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const { url } = yield* fixture.upstreams;
          const taken = yield* freshRepo;
          const kept = yield* fixture.commit(taken, MAIN, HEAD);
          expect(yield* Effect.flip(host.import({ url }, taken))).toMatchObject({
            _tag: "RepoAlreadyExists",
            repo: { namespace: taken.namespace, name: taken.name },
          });
          expect(yield* host.head(taken, MAIN)).toBe(kept);
        }).pipe(Effect.provide(make())),
    );

    it.live("[codehost.info] info gives each repo its own git remote and the default branch", () =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const repo = yield* freshRepo;
        yield* fixture.commit(repo, MAIN, BASE);
        const fork = yield* host.fork(repo, fixture.scratch());
        const [mine, theirs] = [yield* host.info(repo), yield* host.info(fork)];
        expect(mine.defaultBranch).toBe("main");
        expect(mine.remote).toMatch(/^[a-z]+:\/\/.+/);
        expect(mine.remote).toContain(repo.name);
        expect(theirs.remote).not.toBe(mine.remote);
      }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.has-commit] hasCommit finds a commit and its parent, and nothing the repo lacks",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          const base = yield* fixture.commit(repo, MAIN, BASE);
          const head = yield* fixture.commit(repo, MAIN, HEAD);
          expect([
            yield* host.hasCommit(repo, head),
            yield* host.hasCommit(repo, base),
            yield* host.hasCommit(repo, unknownSha()),
          ]).toEqual([true, true, false]);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.token] a minted token carries the requested access and expires about ttl from now",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const repo = yield* freshRepo;
          const minted: string[] = [];
          for (const [access, ttl] of [
            ["read", 120],
            ["write", 600],
            ["write", 600],
          ] as const) {
            const token = yield* host.mintToken(repo, access, ttl);
            expect(token.access).toBe(access);
            expect(token.token.length).toBeGreaterThan(0);
            // A real host stamps expiry with its own clock: allow a minute of skew.
            expect(Math.abs(token.expiresAt - (Date.now() + ttl * 1000))).toBeLessThan(60_000);
            minted.push(token.token);
          }
          // Each mint is a new credential, so a re-grant never hands out an earlier one.
          expect(new Set(minted).size).toBe(minted.length);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.diff] diffTrees gives git diff-tree -r's rows in path order, mirrored when reversed, and none for one commit",
      () =>
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
            {
              path: "g",
              change: "type-changed",
              oldOid: oidAt(was, "g"),
              newOid: GITLINK,
              oldMode: "100644",
              newMode: "160000",
            },
            {
              path: "l",
              change: "type-changed",
              oldOid: oidAt(was, "l"),
              newOid: oidAt(now, "l"),
              oldMode: "100644",
              newMode: "120000",
            },
            {
              path: "m",
              change: "modified",
              oldOid: oidAt(was, "m"),
              newOid: oidAt(was, "m"),
              oldMode: "100644",
              newMode: "100755",
            },
            { path: "new.txt", change: "added", newOid: oidAt(now, "new.txt"), newMode: "100644" },
          ];
          expect(yield* host.diffTrees(repo, base, head)).toEqual(expected);
          const reversed = yield* host.diffTrees(repo, head, base);
          expect(
            reversed.map((r) => [r.path, r.change, r.oldMode ?? "-", r.newMode ?? "-"]),
          ).toEqual([
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

    it.live(
      "[codehost.ancestor-merge] isAncestor reaches trunk's head through the second parent of an agent's merge",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const { repo, base, work, trunk, merge } = yield* mergeHistory;
          expect(yield* host.isAncestor(repo, trunk, merge, [base])).toBe(true);
          expect(yield* host.isAncestor(repo, work, merge, [base])).toBe(true);
          expect(yield* host.isAncestor(repo, base, merge, [])).toBe(true);
          expect(yield* host.isAncestor(repo, merge, merge, [])).toBe(true);
          // Both sides stopped short of base: nothing reaches it.
          expect(yield* host.isAncestor(repo, base, merge, [work, trunk])).toBe(false);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.ancestor-sibling] isAncestor is false between two commits on one base, and from a commit to its own descendant",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const { repo, base, work, trunk, merge } = yield* mergeHistory;
          expect(yield* host.isAncestor(repo, trunk, work, [base])).toBe(false);
          expect(yield* host.isAncestor(repo, work, trunk, [])).toBe(false);
          expect(yield* host.isAncestor(repo, merge, base, [])).toBe(false);
          expect(yield* host.isAncestor(repo, merge, trunk, [])).toBe(false);
        }).pipe(Effect.provide(make())),
    );

    it.live(
      "[codehost.delete] after delete every read fails RepoNotFound, and deleting again succeeds",
      () =>
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const repo = yield* freshRepo;
          const commit = yield* fixture.commit(repo, MAIN, BASE);
          yield* host.delete(repo);
          expect([
            yield* tagOf(host.head(repo, MAIN)),
            yield* tagOf(host.readTree(repo, commit)),
          ]).toEqual(["RepoNotFound", "RepoNotFound"]);
          yield* host.delete(repo);
          expect(yield* tagOf(host.mintToken(repo, "read", 60))).toBe("RepoNotFound");
        }).pipe(Effect.provide(make())),
    );
  });
}
