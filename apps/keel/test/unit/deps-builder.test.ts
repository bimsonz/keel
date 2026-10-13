import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import type { DepsAnswer, Locked } from "@keeltown/core/application/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { BundleStore, DepsBuilder } from "@keeltown/core/ports";
import {
  BUNDLE_URL_TTL_SECONDS,
  type BundleFile,
  bundleUrlSigned,
  writeBundle,
} from "@keeltown/runner-protocol";
import {
  makeBundleStoreMemory,
  makeBundleUrlKeys,
  otherNamespace,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Exit, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  DepsBuildRequest as VerifierDepsBuildRequest,
  DepsCodecs as KeelVerifyDepsCodecs,
  encodeExit as encodeVerifierExit,
} from "../../../keel-verify/src/rpc/index.ts";
import { DepsBuilderRpc } from "../../src/adapters/driven/do-rpc/deps-builder.ts";
import { decodeExit, DepsBuildRequest, DepsCodecs, encodeExit } from "../../src/rpc/index.ts";

const KEYS = await makeBundleUrlKeys();

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const text = (s: string) => new TextEncoder().encode(s);

const LOCKFILE = "lockfileVersion: '9.0'\n";
const PACKAGE = '{"name":"candidate"}\n';
const SOURCE = "export const one = 1;\n";

/** A candidate as Keel bundles one: a package, its lockfile, and a file no install reads. */
const LOCKED: readonly BundleFile[] = [
  { path: "src/one.ts", bytes: text(SOURCE) },
  { path: "pnpm-lock.yaml", bytes: text(LOCKFILE) },
  { path: "package.json", bytes: text(PACKAGE) },
];

/** The install inputs of LOCKED, written out: the manifest's lines for the files an install reads, in its order. */
const INPUTS = `keel.install/1\n${sha256(PACKAGE)}  package.json\n${sha256(LOCKFILE)}  pnpm-lock.yaml\n`;

const NEED: Locked = { _tag: "Locked", install: hex("d1"), inputs: INPUTS };
const BUNDLE = ContentHash.make(`sha256:${hex("b7")}`);

const ANSWERS: readonly DepsAnswer[] = [
  {
    _tag: "DepsReady",
    install: hex("d1"),
    parts: [
      { sha256: hex("07"), bytes: 33_554_432 },
      { sha256: hex("18"), bytes: 4321 },
    ],
  },
  { _tag: "DepsUnavailable", reason: "upload-failed" },
  { _tag: "DepsRefused", reason: "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE" },
  { _tag: "DepsUnneeded" },
];

/** keel-verify's entrypoint, answering `buildDeps` with what `answer` gives: the other copy of the contract. */
const never = async (): Promise<unknown> => {
  throw new Error("not asked in these cases");
};

function verifier(answer: () => unknown) {
  const received: unknown[] = [];
  return {
    received,
    entrypoint: {
      runProbe: never,
      worldReady: never,
      buildDeps: async (request: unknown): Promise<unknown> => {
        received.push(request);
        return answer();
      },
    },
  };
}

type Entrypoint = ReturnType<typeof verifier>["entrypoint"];

/** The adapter over a memory bundle store holding what `kept` puts there. */
const withBuilder = <A, E>(
  entrypoint: Entrypoint,
  use: (builder: DepsBuilder["Service"], store: Store) => Effect.Effect<A, E>,
) => {
  const store = makeBundleStoreMemory();
  return Effect.gen(function* () {
    return yield* use(yield* DepsBuilder, store);
  }).pipe(Effect.provide(DepsBuilderRpc(entrypoint, KEYS.signingKey)), Effect.provide(store.layer));
};

const unasked = verifier(() => {
  throw new Error("need asks keel-verify nothing");
});

type Store = ReturnType<typeof makeBundleStoreMemory>;

/** Puts bytes in the store as a namespace's bundle, answering the hash they are kept under. */
const putBytes = (store: Store, bytes: Uint8Array, namespace = sampleNamespace) =>
  Effect.gen(function* () {
    return yield* (yield* BundleStore).put(namespace, bytes);
  }).pipe(Effect.provide(store.layer));

/** Bundles these files as Keel writes a candidate, and keeps the bundle for a namespace. */
const putBundle = (store: Store, files: readonly BundleFile[], namespace = sampleNamespace) =>
  Effect.promise(() => writeBundle(files)).pipe(
    Effect.flatMap((bytes) => putBytes(store, bytes, namespace)),
  );

describe("DepsBuilder over the bundle store and keel-verify's buildDeps", () => {
  it.effect(
    "[deps-builder.need] reads the candidate's own bundle: its install inputs in the manifest's order, and their sha256 as the install digest",
    () =>
      withBuilder(unasked.entrypoint, (builder, store) =>
        Effect.gen(function* () {
          const locked = yield* putBundle(store, LOCKED);
          expect(yield* builder.need(sampleNamespace, locked)).toEqual({
            _tag: "Locked",
            install: sha256(INPUTS),
            inputs: INPUTS,
          });
          const unlocked = yield* putBundle(
            store,
            LOCKED.filter((f) => f.path !== "pnpm-lock.yaml"),
          );
          expect(yield* builder.need(sampleNamespace, unlocked)).toEqual({
            _tag: "Unlocked",
            reason: "no-lockfile: the candidate has no pnpm-lock.yaml at its root",
          });
          expect(unasked.received).toEqual([]);
        }),
      ),
  );

  it.effect(
    "[deps-builder.need-missing] a bundle that is not kept, or kept only for another namespace, is missing",
    () =>
      withBuilder(unasked.entrypoint, (builder, store) =>
        Effect.gen(function* () {
          const missing = yield* Effect.flip(builder.need(sampleNamespace, BUNDLE));
          expect(missing).toMatchObject({ _tag: "BundleMissing", hash: BUNDLE });
          const theirs = yield* putBundle(store, LOCKED, otherNamespace);
          const error = yield* Effect.flip(builder.need(sampleNamespace, theirs));
          expect(error).toMatchObject({ _tag: "BundleMissing", hash: theirs });
          expect((yield* builder.need(otherNamespace, theirs))._tag).toBe("Locked");
        }),
      ),
  );

  it.effect(
    "[deps-builder.need-unreadable] bytes that are no bundle of Keel's are an unreadable manifest, naming the bundle and why",
    () =>
      withBuilder(unasked.entrypoint, (builder, store) =>
        Effect.gen(function* () {
          const hash = yield* putBytes(store, text("not a gzip, and no bundle"));
          const error = yield* Effect.flip(builder.need(sampleNamespace, hash));
          expect(error).toMatchObject({
            _tag: "ManifestUnreadable",
            hash,
            reason: expect.stringMatching(/\S/),
          });
        }),
      ),
  );

  it.effect(
    "[deps-builder.build] asks keel-verify in a request it decodes, with the bundle's URL signed for the namespace and a step's life, and answers what it answered",
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("1000 seconds");
        for (const answer of ANSWERS) {
          const v = verifier(() =>
            encodeVerifierExit(KeelVerifyDepsCodecs.build, Exit.succeed(answer)),
          );
          const built = yield* withBuilder(v.entrypoint, (builder) =>
            builder.build(sampleNamespace, NEED, BUNDLE),
          );
          expect(built).toEqual(answer);
          expect(v.received).toHaveLength(1);
          const request = Schema.decodeUnknownSync(VerifierDepsBuildRequest)(v.received[0]);
          expect({ namespace: request.namespace, need: request.need }).toEqual({
            namespace: sampleNamespace,
            need: NEED,
          });
          const url = new URL(request.bundleUrl);
          expect(`${url.origin}${url.pathname}`).toBe(
            `https://bundles.keel.internal/${sampleNamespace}/${hex("b7")}`,
          );
          const signed = (namespace: string, sha: string, now: number) =>
            Effect.promise(() =>
              bundleUrlSigned(KEYS.publicKey, namespace, sha, url.searchParams, now),
            );
          const until = 1000 + BUNDLE_URL_TTL_SECONDS;
          expect(BUNDLE_URL_TTL_SECONDS).toBe(1800);
          expect(yield* signed(sampleNamespace, hex("b7"), until)).toBe(true);
          expect(yield* signed(sampleNamespace, hex("b7"), until + 1)).toBe(false);
          expect(yield* signed(otherNamespace, hex("b7"), 1000)).toBe(false);
          expect(yield* signed(sampleNamespace, hex("b8"), 1000)).toBe(false);
        }
      }),
  );

  it.effect(
    "[deps-builder.build-threw] a call that never reached keel-verify is unavailable, saying so: a retry may reach it",
    () => {
      const v = verifier(() => {
        throw new Error("Network connection lost.");
      });
      return Effect.gen(function* () {
        const built = yield* withBuilder(v.entrypoint, (builder) =>
          builder.build(sampleNamespace, NEED, BUNDLE),
        );
        expect(built).toEqual({
          _tag: "DepsUnavailable",
          reason: "keel-verify did not answer: Network connection lost.",
        });
      });
    },
  );

  it.effect(
    "[deps-builder.build-not-an-answer] anything that is not a build's answer is unavailable and never a defect, whatever it is",
    () =>
      Effect.gen(function* () {
        for (const raw of [
          undefined,
          null,
          "built",
          {},
          { _tag: "Success", value: { _tag: "DepsReady", install: "not a sha256", parts: [] } },
          { _tag: "Success", value: { _tag: "DepsBounced", reason: "no such member" } },
          encodeVerifierExit(KeelVerifyDepsCodecs.build, Exit.die("the box fell over")),
        ]) {
          const v = verifier(() => raw);
          const built = yield* withBuilder(v.entrypoint, (builder) =>
            builder.build(sampleNamespace, NEED, BUNDLE),
          );
          expect(built).toEqual({
            _tag: "DepsUnavailable",
            reason: "keel-verify's answer is not one",
          });
        }
      }),
  );
});

describe("the two copies of the deps contract", () => {
  it("[deps.codecs.copies] keel's and keel-verify's read each other's requests and answers, and refuse the same ones", () => {
    const request = { namespace: sampleNamespace, need: NEED, bundleUrl: "https://b.test/x" };
    expect(
      Schema.decodeUnknownSync(VerifierDepsBuildRequest)(
        Schema.encodeSync(DepsBuildRequest)(request),
      ),
    ).toEqual(request);
    expect(
      Schema.decodeUnknownSync(DepsBuildRequest)(
        Schema.encodeSync(VerifierDepsBuildRequest)(request),
      ),
    ).toEqual(request);
    for (const answer of ANSWERS) {
      const exit = Exit.succeed(answer);
      expect(
        decodeExit(DepsCodecs.build, encodeVerifierExit(KeelVerifyDepsCodecs.build, exit)),
      ).toEqual(exit);
      expect(
        Schema.decodeUnknownSync(KeelVerifyDepsCodecs.build)(encodeExit(DepsCodecs.build, exit)),
      ).toEqual(exit);
      expect(encodeExit(DepsCodecs.build, exit)).toEqual(
        encodeVerifierExit(KeelVerifyDepsCodecs.build, exit),
      );
    }
    for (const bad of [
      { ...request, need: { ...NEED, install: "not a sha256" } },
      { ...request, need: { _tag: "Unlocked", reason: "no-lockfile" } },
      { ...request, namespace: "not a namespace" },
      { namespace: sampleNamespace, need: NEED },
    ])
      for (const codec of [DepsBuildRequest, VerifierDepsBuildRequest])
        expect(Schema.decodeUnknownOption(codec)(bad)._tag).toBe("None");
    for (const bad of [
      { _tag: "DepsReady", install: hex("d1"), parts: [{ sha256: hex("07"), bytes: 0 }] },
      { _tag: "DepsReady", install: "d1", parts: [] },
      { _tag: "DepsRefused" },
      { _tag: "DepsBounced", reason: "no such member" },
    ])
      for (const codec of [DepsCodecs.build, KeelVerifyDepsCodecs.build])
        expect(Schema.decodeUnknownOption(codec)({ _tag: "Success", value: bad })._tag).toBe(
          "None",
        );
  });
});
