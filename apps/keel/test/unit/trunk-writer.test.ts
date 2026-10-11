// TrunkWriter.push over a recording git server: the candidate's own pack is
// fetched from staging and pushed to trunk with the WAL's old value, whatever
// trunk's head reads now. Artifacts' own compare-and-swap is proven live
// ([trunkwriter.live]); this proves what the adapter asks it to compare.
import { describe, expect, it } from "@effect/vitest";
import { CommitSha } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef, StagingWriter, TrunkWriter } from "@keeltown/core/ports";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { afterEach, vi } from "vitest";
import { StagingWriterGitCore } from "../../src/adapters/driven/gitcore/staging-writer.ts";
import { TrunkWriterGitCore } from "../../src/adapters/driven/gitcore/trunk-writer.ts";
import { gitServer, PACK, type Reply } from "./git-server.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const TRUNK: RepoRef = { namespace: "memory", name: "prj" };
const STAGING: RepoRef = { namespace: "memory", name: "prj-staging" };
const FROM = sha("a");
const TO = sha("b");

/** Trunk and staging in memory, trunk's main at a commit that is not FROM, and every minted token recorded. */
function host() {
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
  const layer = TrunkWriterGitCore({ trunk: TRUNK, staging: STAGING }).pipe(Layer.provide(spied));
  const stagingLayer = StagingWriterGitCore({ trunk: TRUNK, staging: STAGING }).pipe(
    Layer.provide(spied),
  );
  const seeded = Effect.gen(function* () {
    const h = yield* CodeHost;
    yield* h.create(TRUNK);
    yield* h.create(STAGING);
    return yield* code.fixture.commit(TRUNK, "refs/heads/main", { "README.md": "moved on\n" });
  }).pipe(Effect.provide(code.layer));
  /** Staging's main at a commit of its own, which a stale push may find it already at. */
  const stagingAt = code.fixture.commit(STAGING, "refs/heads/main", { "README.md": "staged\n" });
  return { minted, layer, stagingLayer, seeded, stagingAt };
}

const pushing = (replies: Reply[], pack?: Uint8Array) => {
  const server = gitServer(replies, pack);
  vi.stubGlobal("fetch", server.fetch);
  const { minted, layer, stagingLayer, seeded, stagingAt } = host();
  return { server, minted, layer, stagingLayer, seeded, stagingAt };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TrunkWriter.push", () => {
  it.effect(
    "[trunkwriter.cas] fetches the candidate from staging and pushes it to trunk with the WAL's old value",
    () =>
      Effect.gen(function* () {
        const { server, minted, layer, seeded } = pushing(["ok"]);
        const head = yield* seeded;
        expect(head).not.toBe(FROM);
        yield* Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO)).pipe(Effect.provide(layer));
        expect(
          server.requests.map(({ auth, ...r }) => ({ ...r, auth: auth?.replace(/_\d+$/, "") })),
        ).toEqual([
          {
            service: "upload-pack",
            repo: "memory/prj-staging.git",
            auth: "Bearer memrepo_read_memory/prj-staging",
            lines: [expect.stringMatching(new RegExp(`^want ${TO} `)), `have ${FROM}`, "done"],
          },
          {
            service: "receive-pack",
            repo: "memory/prj.git",
            auth: "Bearer memrepo_write_memory/prj",
            lines: [`${FROM} ${TO} refs/heads/main`],
          },
        ]);
        expect(minted).toEqual(["prj-staging read 60s", "prj write 60s"]);
      }),
  );

  it.effect(
    "[trunkwriter.stale] answers PushRejected when trunk no longer holds the old value",
    () =>
      Effect.gen(function* () {
        const { layer, seeded } = pushing(["stale"]);
        yield* seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO)).pipe(Effect.provide(layer)),
        );
        expect(error).toMatchObject({ _tag: "PushRejected", reason: "stale" });
      }),
  );

  it.effect(
    "[trunkwriter.busy] sends the same pack again while trunk is busy, and gives up after three retries",
    () =>
      Effect.gen(function* () {
        const landed = pushing(["busy", "busy", "ok"]);
        yield* landed.seeded;
        yield* Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO)).pipe(
          Effect.provide(landed.layer),
        );
        expect(landed.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(3);
        vi.unstubAllGlobals();

        const busy = pushing(["busy", "busy", "busy", "busy", "ok"]);
        yield* busy.seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO)).pipe(Effect.provide(busy.layer)),
        );
        expect(error).toMatchObject({ _tag: "PushRejected", reason: "busy" });
        expect(busy.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(4);
      }),
  );

  it.effect(
    "[trunkwriter.too-large] refuses a candidate pack over the receive-pack cap, pushing nothing",
    () =>
      Effect.gen(function* () {
        const big = new Uint8Array(61 * 1024 * 1024);
        big.set(PACK);
        const { server, layer, seeded } = pushing(["ok"], big);
        yield* seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO)).pipe(Effect.provide(layer)),
        );
        expect(error).toMatchObject({ _tag: "PackTooLarge", repo: TRUNK });
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
      }),
  );
});

describe("StagingWriter.fastForward", () => {
  it.effect(
    "[stagingwriter.cas] relays trunk's pack into staging with trunk's old head as the explicit old value",
    () =>
      Effect.gen(function* () {
        const { server, minted, stagingLayer, seeded, stagingAt } = pushing(["ok"]);
        yield* seeded;
        const held = yield* stagingAt;
        expect(held).not.toBe(FROM);
        const moved = yield* Effect.flatMap(StagingWriter, (w) => w.fastForward(FROM, TO)).pipe(
          Effect.provide(stagingLayer),
        );
        expect(moved).toBe("advanced");
        expect(
          server.requests.map(({ service, repo, lines }) => ({ service, repo, lines })),
        ).toEqual([
          {
            service: "upload-pack",
            repo: "memory/prj.git",
            lines: [expect.stringMatching(new RegExp(`^want ${TO} `)), `have ${FROM}`, "done"],
          },
          {
            service: "receive-pack",
            repo: "memory/prj-staging.git",
            lines: [`${FROM} ${TO} refs/heads/main`],
          },
        ]);
        expect(minted).toEqual(["prj read 60s", "prj-staging write 60s"]);
      }),
  );

  it.effect(
    "[stagingwriter.stale] a staging already at the head is unchanged; one anywhere else is PushRejected",
    () =>
      Effect.gen(function* () {
        const first = pushing(["stale"]);
        yield* first.seeded;
        const held = yield* first.stagingAt;
        const unchanged = yield* Effect.flatMap(StagingWriter, (w) =>
          w.fastForward(FROM, held),
        ).pipe(Effect.provide(first.stagingLayer));
        expect(unchanged).toBe("unchanged");
        const second = pushing(["stale"]);
        yield* second.seeded;
        yield* second.stagingAt;
        const refused = yield* Effect.flip(
          Effect.flatMap(StagingWriter, (w) => w.fastForward(FROM, TO)).pipe(
            Effect.provide(second.stagingLayer),
          ),
        );
        expect(refused).toMatchObject({ _tag: "PushRejected", reason: "stale" });
      }),
  );
});
