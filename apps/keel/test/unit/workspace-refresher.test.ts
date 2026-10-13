// WorkspaceRefresher.advance over a recording git server: trunk's pack is
// fetched with the commit the pool names as the only have, then pushed to the
// workspace's main with that commit as the explicit old value. Artifacts' own
// compare-and-swap is proven live ([refresher.contract.stale]); this proves
// what the adapter asks it to compare.
import { describe, expect, it } from "@effect/vitest";
import { CommitSha, makeId } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef, WorkspaceRefresher } from "@keeltown/core/ports";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { afterEach, vi } from "vitest";
import { WorkspaceRefresherGitCore } from "../../src/adapters/driven/gitcore/workspace-refresher.ts";
import { EMPTY_PACK, gitServer, type Reply } from "./git-server.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const PROJECT = makeId("prj", "01KRBSRCNTRCT0000000000000");
const TRUNK: RepoRef = { namespace: "memory", name: "prj" };
const WORKSPACE: RepoRef = { namespace: "memory", name: "prj-ws-01" };
const MAIN = "refs/heads/main";
const BASE = sha("a");
const HEAD = sha("b");

/** Trunk and the workspace in memory, every minted token recorded, and the server's requests. `pack` is what trunk sends, when the test says. */
function refreshing(replies: Reply[], pack?: Uint8Array) {
  const server = gitServer(replies, pack);
  vi.stubGlobal("fetch", server.fetch);
  const code = makeCodeHostMemory();
  const minted: string[] = [];
  const spied = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (h) =>
      CodeHost.of({
        ...h,
        mintToken: (repo, access, ttl) => {
          minted.push(`${repo.name} ${access} ${ttl}s`);
          return h.mintToken(repo, access, ttl);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const layer = WorkspaceRefresherGitCore(() => TRUNK).pipe(Layer.provide(spied));
  const seeded = Effect.gen(function* () {
    const h = yield* CodeHost;
    yield* h.create(TRUNK);
    yield* h.create(WORKSPACE);
  }).pipe(Effect.provide(code.layer));
  const advance = (from: CommitSha, to: CommitSha) =>
    Effect.flatMap(WorkspaceRefresher, (r) => r.advance(PROJECT, WORKSPACE, from, to)).pipe(
      Effect.provide(layer),
    );
  return { code, server, minted, seeded, advance };
}

/** A recorded request, with the token's per-mint counter dropped. */
const plainRequest = ({ auth, ...r }: { readonly auth: string | null }) => ({
  ...r,
  auth: auth?.replace(/_\d+$/, ""),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceRefresher.advance", () => {
  it.effect(
    "[refresher.cas] fetches trunk's head past the commit the pool names and pushes it to the workspace's main with that commit as old; the same commit sends nothing",
    () =>
      Effect.gen(function* () {
        const moving = refreshing(["ok"]);
        yield* moving.seeded;
        expect(yield* moving.advance(BASE, HEAD)).toBe("advanced");
        expect(moving.server.requests.map(plainRequest)).toEqual([
          {
            service: "upload-pack",
            repo: "memory/prj.git",
            auth: "Bearer memrepo_read_memory/prj",
            lines: [expect.stringMatching(new RegExp(`^want ${HEAD} `)), `have ${BASE}`, "done"],
          },
          {
            service: "receive-pack",
            repo: "memory/prj-ws-01.git",
            auth: "Bearer memrepo_write_memory/prj-ws-01",
            lines: [`${BASE} ${HEAD} ${MAIN}`],
          },
        ]);
        // Each token lives a minute, and trunk's is a read token.
        expect(moving.minted).toEqual(["prj-ws-01 write 60s", "prj read 60s"]);

        vi.unstubAllGlobals();
        const still = refreshing([]);
        yield* still.seeded;
        expect(yield* still.advance(HEAD, HEAD)).toBe("unchanged");
        expect(still.server.requests).toEqual([]);
        expect(still.minted).toEqual([]);
      }),
  );

  it.effect(
    "[refresher.stale] a main that is not where the pool says is PushRejected stale after one push, with nothing read or retried; a workspace that stays busy is PushRejected busy",
    () =>
      Effect.gen(function* () {
        const stale = refreshing(["stale", "ok"]);
        yield* stale.seeded;
        expect(yield* Effect.flip(stale.advance(BASE, HEAD))).toMatchObject({
          _tag: "PushRejected",
          reason: "stale",
        });
        expect(stale.server.requests.map((r) => r.service)).toEqual([
          "upload-pack",
          "receive-pack",
        ]);

        vi.unstubAllGlobals();
        const busy = refreshing(["busy", "busy", "busy", "busy"]);
        yield* busy.seeded;
        expect(yield* Effect.flip(busy.advance(BASE, HEAD))).toMatchObject({
          _tag: "PushRejected",
          reason: "busy",
        });
      }),
  );

  it.effect(
    "[refresher.not-forward] a head trunk has nothing to send for past the commit the pool names is PushRejected stale, and nothing is pushed: a workspace is never taken back",
    () =>
      Effect.gen(function* () {
        // Trunk answers an empty pack: everything the head reaches, the workspace's main reaches already.
        const behind = refreshing(["ok"], EMPTY_PACK);
        yield* behind.seeded;
        expect(yield* Effect.flip(behind.advance(HEAD, BASE))).toMatchObject({
          _tag: "PushRejected",
          reason: "stale",
        });
        expect(behind.server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
      }),
  );

  it.effect(
    "[refresher.missing] a workspace that is gone is RepoNotFound, and trunk is asked for nothing",
    () =>
      Effect.gen(function* () {
        const gone = refreshing([]);
        yield* Effect.flatMap(CodeHost, (h) => h.create(TRUNK)).pipe(
          Effect.provide(gone.code.layer),
        );
        expect(yield* Effect.flip(gone.advance(BASE, HEAD))).toMatchObject({
          _tag: "RepoNotFound",
          repo: { namespace: "memory", name: "prj-ws-01" },
        });
        expect(gone.server.requests).toEqual([]);
        expect(gone.minted).toEqual([]);
      }),
  );
});
