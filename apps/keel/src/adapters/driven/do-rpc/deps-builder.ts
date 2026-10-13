import { depsNeedFrom } from "@keeltown/core/application/verification";
import { BundleStore, DepsBuilder, ManifestUnreadable } from "@keeltown/core/ports";
import {
  BUNDLE_URL_TTL_SECONDS,
  bundleTexts,
  sha256Hex,
  signedBundleUrl,
} from "@keeltown/runner-protocol";
import { Clock, Effect, Exit, Layer, Schema } from "effect";
import {
  decodeExit,
  DepsBuildRequest,
  DepsCodecs,
  type VerifierEntrypoint,
} from "../../../rpc/index.ts";

const encodeRequest = Schema.encodeSync(DepsBuildRequest);

const NOT_AN_ANSWER = "keel-verify's answer is not one";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * DepsBuilder over the namespace's bundle store and keel-verify's entrypoint
 * (the VERIFIER service binding).
 *
 * `need` reads the candidate's bundle from the store and answers core's
 * `depsNeedFrom` over the manifest of exactly the files the bundle holds
 * (`bundleTexts`), hashed here. A bundle that is not one Keel wrote is
 * `ManifestUnreadable`.
 *
 * `build` hands keel-verify the bundle's URL, signed with `signingKey` for a
 * step's life, and answers what its deps box for the namespace and the
 * install digest answers. A call that never reached it, or an answer that is
 * not one, is `DepsUnavailable` saying so: a retry may change it.
 */
export const DepsBuilderRpc = (verifier: VerifierEntrypoint, signingKey: string) =>
  Layer.effect(
    DepsBuilder,
    Effect.gen(function* () {
      const bundles = yield* BundleStore;
      return DepsBuilder.of({
        need: (namespace, bundle) =>
          Effect.gen(function* () {
            const bytes = yield* bundles.get(namespace, bundle);
            const texts = yield* Effect.tryPromise({
              try: () => bundleTexts(bytes),
              catch: (error) => new ManifestUnreadable({ hash: bundle, reason: describe(error) }),
            });
            return yield* depsNeedFrom(texts.manifest, texts.read, (text) =>
              Effect.promise(() => sha256Hex(new TextEncoder().encode(text))),
            );
          }),
        build: (namespace, need, bundle) =>
          Effect.gen(function* () {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
            const bundleUrl = yield* Effect.promise(() =>
              signedBundleUrl(signingKey, namespace, bundle, now + BUNDLE_URL_TTL_SECONDS),
            );
            const raw = yield* Effect.tryPromise({
              try: () => verifier.buildDeps(encodeRequest({ namespace, need, bundleUrl })),
              catch: (error) => `keel-verify did not answer: ${describe(error)}`,
            });
            // The codec throws on what is no Exit at all: that is an answer that is not one too.
            const exit = yield* Effect.try({
              try: () => decodeExit(DepsCodecs.build, raw),
              catch: () => NOT_AN_ANSWER,
            });
            return Exit.isSuccess(exit) ? exit.value : yield* Effect.fail(NOT_AN_ANSWER);
          }).pipe(
            Effect.catch((reason) => Effect.succeed({ _tag: "DepsUnavailable" as const, reason })),
          ),
      });
    }),
  );
