import { BundleRefused, BundleStore, CandidateBundles } from "@keeltown/core/ports";
import { MODE_EXEC, MODE_FILE, MODE_TREE, type ObjectReader } from "@keeltown/gitcore";
import {
  BUNDLE_MANIFEST,
  type BundleFile,
  BundleRefused as WriterRefused,
  writeBundle,
} from "@keeltown/runner-protocol";
import { Effect, Layer } from "effect";
import type { OpenObjects } from "./candidate-composer.ts";

/** Refused while walking the tree, at `path`: the bundle carries regular files only, and never its own manifest. */
class Unbundlable extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every regular file under `tree`, its subtrees read in parallel; a symlink or submodule refuses the bundle. */
async function filesOf(reader: ObjectReader, tree: string, prefix: string): Promise<BundleFile[]> {
  const nested = await Promise.all(
    (await reader.readTree(tree)).map(async (e): Promise<BundleFile[]> => {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.mode === MODE_TREE) return filesOf(reader, e.oid, path);
      if (e.mode !== MODE_FILE && e.mode !== MODE_EXEC)
        throw new Unbundlable(
          path,
          `${path} has mode ${e.mode}: a bundle carries regular files only`,
        );
      if (path === BUNDLE_MANIFEST) throw new Unbundlable(path, `${BUNDLE_MANIFEST} is reserved`);
      return [{ path, bytes: await reader.readBlob(e.oid), executable: e.mode === MODE_EXEC }];
    }),
  );
  return nested.flat();
}

/**
 * CandidateBundles over gitcore's reads: the candidate commit's tree is read
 * from staging through the binding, written with the runner protocol's
 * bundle writer (the one implementation; never a second) and stored by its
 * sha256. Anything the writer or the walk refuses is BundleRefused.
 */
export const CandidateBundlesGitCore = (open: OpenObjects) =>
  Layer.effect(
    CandidateBundles,
    Effect.gen(function* () {
      const store = yield* BundleStore;
      return CandidateBundles.of({
        bundle: (staging, commit) =>
          Effect.acquireUseRelease(
            Effect.promise(() => open(staging)),
            (reader) =>
              Effect.tryPromise({
                try: async () =>
                  writeBundle(await filesOf(reader, (await reader.readCommit(commit)).tree, "")),
                catch: (cause) => cause,
              }).pipe(
                Effect.catch((cause) =>
                  cause instanceof Unbundlable
                    ? Effect.fail(new BundleRefused({ reason: cause.message, path: cause.path }))
                    : cause instanceof WriterRefused
                      ? Effect.fail(new BundleRefused({ reason: cause.message }))
                      : Effect.die(cause),
                ),
                Effect.flatMap(store.put),
              ),
            (reader) => Effect.sync(() => reader[Symbol.dispose]()),
          ),
      });
    }),
  );
