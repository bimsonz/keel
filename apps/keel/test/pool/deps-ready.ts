import { env } from "cloudflare:workers";
import { BundleStore } from "@keeltown/core/ports";
import { writeBundle } from "@keeltown/runner-protocol";
import { Effect } from "effect";
import { BundleStoreR2 } from "../../src/adapters/driven/r2/bundle-store.ts";
import { POOL_ORG } from "./helpers.ts";

/**
 * A candidate's deps, ready, as the two deps steps keep them. The pool builds
 * no deps and most cases keep no bundle in BUNDLES, so a case that mocks the
 * suite's runner step mocks these two with it: the steps themselves run for
 * real in the `[deps.pool.steps]` cases.
 */
const INSTALL = "1d".repeat(32);

const READY: Readonly<Record<string, string>> = {
  "deps-need": JSON.stringify({
    _tag: "Locked",
    install: INSTALL,
    inputs: `keel.install/1\n${"a1".repeat(32)}  pnpm-lock.yaml\n`,
  }),
  [`deps:${INSTALL}`]: JSON.stringify({
    _tag: "DepsReady",
    install: INSTALL,
    parts: [{ sha256: "07".repeat(32), bytes: 4321 }],
  }),
};

/** Mocks both deps steps of a Workflow instance with ready deps. */
export const mockDepsReady = async (m: {
  mockStepResult(step: { name: string }, result: unknown): Promise<void>;
}): Promise<void> => {
  for (const [name, kept] of Object.entries(READY)) await m.mockStepResult({ name }, kept);
};

/** Keeps these files in BUNDLES as a candidate's bundle of the pool's org, answering its hash. */
export const bundled = (files: Readonly<Record<string, string>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() =>
        writeBundle(
          Object.entries(files).map(([path, text]) => ({
            path,
            bytes: new TextEncoder().encode(text),
          })),
        ),
      );
      return yield* (yield* BundleStore).put(POOL_ORG, bytes);
    }).pipe(Effect.provide(BundleStoreR2(env.BUNDLES))),
  );
