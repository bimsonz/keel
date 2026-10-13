// TrunkWriter.push over a recording git server: the candidate's own pack is
// fetched from staging once, admitted on its length, and pushed to trunk with
// the WAL's old value, whatever trunk's head reads now. Artifacts' own compare-and-swap is proven live
// ([trunkwriter.live]); this proves what the adapter asks it to compare.
import { describe, expect, it } from "@effect/vitest";
import { CommitSha, Instant } from "@keeltown/core/kernel";
import {
  CodeHost,
  RELAY_PACK_CAP_BYTES,
  type RepoRef,
  StagingWriter,
  TrunkWriter,
} from "@keeltown/core/ports";
import {
  importSshSigningKey,
  MAX_RELAY_PACK_BYTES,
  rootCommit,
  sshSignature,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { makeCodeHostMemory } from "@keeltown/testing";
import { makeCommitSigningKeys } from "@keeltown/testing/commit-signing-keys";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { afterEach, vi } from "vitest";
import { StagingWriterGitCore } from "../../src/adapters/driven/gitcore/staging-writer.ts";
import { TrunkWriterGitCore } from "../../src/adapters/driven/gitcore/trunk-writer.ts";
import { gitServer, PACK, type Reply } from "./git-server.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const TRUNK: RepoRef = { namespace: "memory", name: "prj" };
const STAGING: RepoRef = { namespace: "memory", name: "prj-staging" };
/** Another project's trunk: what a fork takes its history from. */
const SOURCE: RepoRef = { namespace: "memory", name: "src" };
const FROM = sha("a");
const TO = sha("b");
const MAIN = "refs/heads/main";
const HOST = "keel.test";
/** An admission that admits every pack. */
const ADMITTED = () => Effect.void;
/** A deployment with no signing key: enough for a writer that seeds nothing. */
const UNSIGNED = { host: HOST, signingKey: undefined, signers: "[]" };

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
  const layer = TrunkWriterGitCore({ trunk: TRUNK, staging: STAGING }, UNSIGNED).pipe(
    Layer.provide(spied),
  );
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

describe("the relay's cap", () => {
  it("[trunkwriter.cap] what the port says one relayed pack may weigh is what the relay holds every pack to", () => {
    expect(RELAY_PACK_CAP_BYTES).toBe(MAX_RELAY_PACK_BYTES);
  });
});

describe("TrunkWriter.push", () => {
  it.effect(
    "[trunkwriter.cas] fetches the candidate from staging and pushes it to trunk with the WAL's old value",
    () =>
      Effect.gen(function* () {
        const { server, minted, layer, seeded } = pushing(["ok"]);
        const head = yield* seeded;
        expect(head).not.toBe(FROM);
        yield* Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
          Effect.provide(layer),
        );
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
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
            Effect.provide(layer),
          ),
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
        yield* Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
          Effect.provide(landed.layer),
        );
        expect(landed.server.requests.filter((r) => r.service === "receive-pack")).toHaveLength(3);
        vi.unstubAllGlobals();

        const busy = pushing(["busy", "busy", "busy", "busy", "ok"]);
        yield* busy.seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
            Effect.provide(busy.layer),
          ),
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
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
            Effect.provide(layer),
          ),
        );
        expect(error).toMatchObject({ _tag: "PackTooLarge", repo: TRUNK });
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
      }),
  );

  it.effect(
    "[trunkwriter.push-fetches-once] a push asks staging for its pack once, and what it admits is what trunk receives",
    () =>
      Effect.gen(function* () {
        const pack = new Uint8Array(150_000);
        pack.set(PACK);
        const { server, layer, seeded } = pushing(["ok"], pack);
        yield* seeded;
        let admissions = 0;
        yield* Effect.flatMap(TrunkWriter, (w) =>
          w.push(FROM, TO, () =>
            Effect.sync(() => {
              admissions += 1;
            }),
          ),
        ).pipe(Effect.provide(layer));
        expect(admissions).toBe(1);
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack", "receive-pack"]);
        expect(server.received).toEqual([150_000]);
      }),
  );

  it.effect(
    "[trunkwriter.push-admits-length] the admission is given the pack's own length, with none of its framing",
    () =>
      Effect.gen(function* () {
        // Three side-bands' worth, so a count that kept the framing would differ.
        const pack = new Uint8Array(150_000);
        pack.set(PACK);
        const { layer, seeded } = pushing(["ok"], pack);
        yield* seeded;
        const admitted: number[] = [];
        yield* Effect.flatMap(TrunkWriter, (w) =>
          w.push(FROM, TO, (packBytes) =>
            Effect.sync(() => {
              admitted.push(packBytes);
            }),
          ),
        ).pipe(Effect.provide(layer));
        expect(admitted).toEqual([150_000]);
      }),
  );

  it.effect(
    "[trunkwriter.push-admits-first] a pack its admission refuses is never sent: the push fails as the admission did, and trunk is asked for nothing",
    () =>
      Effect.gen(function* () {
        const { server, minted, layer, seeded } = pushing(["ok"]);
        yield* seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, () => Effect.fail("refused"))).pipe(
            Effect.provide(layer),
          ),
        );
        expect(error).toBe("refused");
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
        // No write token for trunk was minted for a push that was refused.
        expect(minted).toEqual(["prj-staging read 60s"]);
      }),
  );

  it.effect(
    "[trunkwriter.pack-bytes] weighs the very pack a push relays: the same want and have, and the pack's own length",
    () =>
      Effect.gen(function* () {
        // Three side-bands' worth, so a count that kept the framing would differ.
        const pack = new Uint8Array(150_000);
        pack.set(PACK);
        const { server, minted, layer, seeded } = pushing(["ok"], pack);
        yield* seeded;
        const bytes = yield* Effect.flatMap(TrunkWriter, (w) => w.packBytes(FROM, TO)).pipe(
          Effect.provide(layer),
        );
        // Weighing reads staging and writes nothing.
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
        expect(minted).toEqual(["prj-staging read 60s"]);
        yield* Effect.flatMap(TrunkWriter, (w) => w.push(FROM, TO, ADMITTED)).pipe(
          Effect.provide(layer),
        );
        const [weighed, fetched] = server.requests;
        expect(weighed?.lines).toEqual([
          expect.stringMatching(new RegExp(`^want ${TO} `)),
          `have ${FROM}`,
          "done",
        ]);
        expect(weighed?.lines).toEqual(fetched?.lines);
        expect(weighed?.repo).toBe(fetched?.repo);
        expect(server.received).toEqual([150_000]);
        expect(bytes).toBe(150_000);
      }),
  );

  it.effect(
    "[trunkwriter.pack-bytes-cap] a pack of exactly the receive-pack cap is weighed, and one byte over is PackTooLarge",
    () =>
      Effect.gen(function* () {
        const cap = 60 * 1024 * 1024;
        const atCap = new Uint8Array(cap);
        atCap.set(PACK);
        const fits = pushing([], atCap);
        yield* fits.seeded;
        const bytes = yield* Effect.flatMap(TrunkWriter, (w) => w.packBytes(FROM, TO)).pipe(
          Effect.provide(fits.layer),
        );
        expect(bytes).toBe(cap);
        vi.unstubAllGlobals();

        // One byte is far inside the side-band framing the streamed read allows for.
        const justOver = new Uint8Array(cap + 1);
        justOver.set(PACK);
        const over = pushing([], justOver);
        yield* over.seeded;
        const error = yield* Effect.flip(
          Effect.flatMap(TrunkWriter, (w) => w.packBytes(FROM, TO)).pipe(
            Effect.provide(over.layer),
          ),
        );
        expect(error).toMatchObject({
          _tag: "PackTooLarge",
          repo: TRUNK,
          bytes: cap + 1,
          limit: cap,
        });
        expect(over.server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
      }),
  );

  it.effect(
    "[trunkwriter.history-bytes] weighs trunk's whole history at a commit: a want with no have, asked of trunk, and the pack's own length",
    () =>
      Effect.gen(function* () {
        const pack = new Uint8Array(150_000);
        pack.set(PACK);
        const { server, minted, layer, seeded } = pushing([], pack);
        yield* seeded;
        const bytes = yield* Effect.flatMap(TrunkWriter, (w) => w.historyBytes(TO)).pipe(
          Effect.provide(layer),
        );
        expect(
          server.requests.map(({ auth, ...r }) => ({ ...r, auth: auth?.replace(/_\d+$/, "") })),
        ).toEqual([
          {
            service: "upload-pack",
            repo: "memory/prj.git",
            auth: "Bearer memrepo_read_memory/prj",
            lines: [expect.stringMatching(new RegExp(`^want ${TO} `)), "done"],
          },
        ]);
        expect(minted).toEqual(["prj read 60s"]);
        expect(bytes).toBe(150_000);
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

/** An empty trunk in memory, its writer signing with a fresh key, and the recording server its pushes reach. */
const emptyTrunk = (replies: Reply[], pack?: Uint8Array) =>
  Effect.gen(function* () {
    const keys = yield* Effect.promise(() => makeCommitSigningKeys());
    const server = gitServer(replies, pack);
    vi.stubGlobal("fetch", server.fetch);
    const code = makeCodeHostMemory();
    yield* Effect.flatMap(CodeHost, (h) => h.create(TRUNK)).pipe(Effect.provide(code.layer));
    const layer = TrunkWriterGitCore(
      { trunk: TRUNK, staging: STAGING },
      { host: HOST, signingKey: keys.signingKey, signers: keys.signers },
    ).pipe(Layer.provide(code.layer));
    /** Trunk's main as the memory host holds it: the recording server takes pushes and moves nothing. */
    const setMain = (to: CommitSha) => {
      code.repos.get("memory/prj")?.refs.set(MAIN, to);
    };
    /** The source repo with one commit on main, which is answered. */
    const sourced = Effect.gen(function* () {
      yield* (yield* CodeHost).create(SOURCE);
      return yield* code.fixture.commit(SOURCE, MAIN, { "README.md": "the source\n" });
    }).pipe(Effect.provide(code.layer));
    return { keys, server, layer, setMain, sourced };
  });

/** Keel's first commit for `name` at `at`, built here from the key itself. */
const firstCommit = (signingKey: string, name: string, at: number) =>
  Effect.promise(async () => {
    const key = await importSshSigningKey(signingKey);
    const keel = { name: "Keel", email: `keel@${HOST}`, time: Math.floor(at / 1000) };
    return rootCommit({
      path: "README.md",
      content: `# ${name}\n`,
      message: `Start ${name}`,
      author: keel,
      committer: keel,
      sign: (unsigned) => sshSignature(key, unsigned),
    });
  });

describe("TrunkWriter.seed and adopt", () => {
  const AT = Instant(1_760_000_000_999);

  it.effect(
    "[project.start-empty] seeds an empty trunk with Keel's signed first commit, made of the name and the time alone, and a retry finds it",
    () =>
      Effect.gen(function* () {
        const { keys, server, layer, setMain } = yield* emptyTrunk(["ok"]);
        const seed = Effect.flatMap(TrunkWriter, (w) => w.seed("forge", AT)).pipe(
          Effect.provide(layer),
        );
        const seeded = yield* seed;
        const expected = yield* firstCommit(keys.signingKey, "forge", AT);
        expect(seeded).toBe(expected.oid);
        expect(
          server.requests.map(({ service, repo, lines }) => ({ service, repo, lines })),
        ).toEqual([
          {
            service: "receive-pack",
            repo: "memory/prj.git",
            lines: [`${ZERO_OID} ${expected.oid} ${MAIN}`],
          },
        ]);
        // The pack is the blob, the tree and the commit, and nothing else.
        const pack = yield* Effect.promise(() => writePack(expected.objects));
        expect(server.received).toEqual([pack.length]);
        // A retry of the same bootstrap writes the same commit, finds it there and sends nothing.
        setMain(seeded);
        expect(yield* seed).toBe(seeded);
        expect(server.requests).toHaveLength(1);
      }),
  );

  it.effect(
    "[project.start-empty] never seeds over a main that holds something else, and never unsigned",
    () =>
      Effect.gen(function* () {
        const { server, layer, setMain } = yield* emptyTrunk([]);
        setMain(FROM);
        const over = yield* Effect.exit(
          Effect.flatMap(TrunkWriter, (w) => w.seed("forge", AT)).pipe(Effect.provide(layer)),
        );
        expect(Exit.isFailure(over) ? Cause.pretty(over.cause) : "").toContain(
          "trunk already has a main, at another commit",
        );
        const code = makeCodeHostMemory();
        yield* Effect.flatMap(CodeHost, (h) => h.create(TRUNK)).pipe(Effect.provide(code.layer));
        const keyless = yield* Effect.exit(
          Effect.flatMap(TrunkWriter, (w) => w.seed("forge", AT)).pipe(
            Effect.provide(
              TrunkWriterGitCore({ trunk: TRUNK, staging: STAGING }, UNSIGNED).pipe(
                Layer.provide(code.layer),
              ),
            ),
          ),
        );
        expect(Exit.isFailure(keyless) ? Cause.pretty(keyless.cause) : "").toContain(
          "KEEL_COMMIT_SIGNING_KEY is not set",
        );
        expect(server.requests).toEqual([]);
      }),
  );

  // Live, not on the test clock: the busy retry sleeps for real.
  it.live(
    "[trunkwriter.adopt] makes main at a commit trunk holds with no object sent and no old value, and leaves a main that exists",
    () =>
      Effect.gen(function* () {
        const { server, layer, setMain } = yield* emptyTrunk(["busy", "ok"]);
        const adopt = (commit: CommitSha) =>
          Effect.flatMap(TrunkWriter, (w) => w.adopt(commit)).pipe(Effect.provide(layer));
        yield* adopt(TO);
        const empty = yield* Effect.promise(() => writePack([]));
        // Trunk was busy once: the same ref-only push was sent again.
        expect(server.requests.map(({ service, lines }) => ({ service, lines }))).toEqual([
          { service: "receive-pack", lines: [`${ZERO_OID} ${TO} ${MAIN}`] },
          { service: "receive-pack", lines: [`${ZERO_OID} ${TO} ${MAIN}`] },
        ]);
        expect(server.received).toEqual([empty.length, empty.length]);
        // Already there: a retry, and nothing is sent.
        setMain(TO);
        yield* adopt(TO);
        expect(server.requests).toHaveLength(2);
        // At another commit: a defect, and main is never moved.
        const moved = yield* Effect.exit(adopt(FROM));
        expect(Exit.isFailure(moved) ? Cause.pretty(moved.cause) : "").toContain(
          "trunk already has a main, at another commit",
        );
        expect(server.requests).toHaveLength(2);
      }),
  );
});

describe("TrunkWriter.take", () => {
  const take = Effect.flatMap(TrunkWriter, (w) => w.take(SOURCE));

  it.effect(
    "[trunkwriter.take] brings an empty trunk its source's whole history: one pack asked of the source at its head with no have, pushed to trunk with no old value, and the head answered",
    () =>
      Effect.gen(function* () {
        const { server, layer, sourced } = yield* emptyTrunk(["ok"]);
        const tip = yield* sourced;
        expect(yield* take.pipe(Effect.provide(layer))).toBe(tip);
        expect(
          server.requests.map(({ auth, ...r }) => ({ ...r, auth: auth?.replace(/_\d+$/, "") })),
        ).toEqual([
          {
            service: "upload-pack",
            repo: "memory/src.git",
            auth: "Bearer memrepo_read_memory/src",
            lines: [expect.stringMatching(new RegExp(`^want ${tip} `)), "done"],
          },
          {
            service: "receive-pack",
            repo: "memory/prj.git",
            auth: "Bearer memrepo_write_memory/prj",
            lines: [`${ZERO_OID} ${tip} ${MAIN}`],
          },
        ]);
        expect(server.received).toEqual([PACK.length]);
      }),
  );

  it.effect(
    "[trunkwriter.take-keeps-main] a trunk that has a main is a retry: nothing is asked of the source or sent, and its main is answered though the source is elsewhere; a push refused because a racing attempt made main first answers what trunk then holds",
    () =>
      Effect.gen(function* () {
        const { server, layer, setMain, sourced } = yield* emptyTrunk(["stale"]);
        const tip = yield* sourced;
        // The racing attempt lands as ours is pushed: ours is refused, and trunk holds the racer's.
        vi.stubGlobal("fetch", (...asked: Parameters<typeof server.fetch>) => {
          const [input] = asked;
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith("/git-receive-pack")) setMain(TO);
          return server.fetch(...asked);
        });
        expect(yield* take.pipe(Effect.provide(layer))).toBe(TO);
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack", "receive-pack"]);
        // From here trunk has its main: a retry asks nothing and answers it.
        expect(TO).not.toBe(tip);
        expect(yield* take.pipe(Effect.provide(layer))).toBe(TO);
        expect(server.requests).toHaveLength(2);
      }),
  );

  it.effect(
    "[trunkwriter.take-refused] a source over the receive-pack cap is PackTooLarge naming the source, with nothing sent to trunk; a source that is gone is RepoNotFound, with nothing asked",
    () =>
      Effect.gen(function* () {
        const big = new Uint8Array(61 * 1024 * 1024);
        big.set(PACK);
        const { server, layer, sourced } = yield* emptyTrunk(["ok"], big);
        const gone = yield* Effect.flip(take.pipe(Effect.provide(layer)));
        expect(gone).toMatchObject({ _tag: "RepoNotFound", repo: SOURCE });
        expect(server.requests).toEqual([]);
        yield* sourced;
        const large = yield* Effect.flip(take.pipe(Effect.provide(layer)));
        expect(large).toMatchObject({
          _tag: "PackTooLarge",
          repo: SOURCE,
          limit: RELAY_PACK_CAP_BYTES,
        });
        expect(server.requests.map((r) => r.service)).toEqual(["upload-pack"]);
      }),
  );
});
