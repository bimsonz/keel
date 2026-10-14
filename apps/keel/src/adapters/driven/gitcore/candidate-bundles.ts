import type { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import { BundleRefused, BundleStore, CandidateBundles } from "@keeltown/core/ports";
import {
  encodeTree,
  hashObject,
  MODE_EXEC,
  MODE_FILE,
  MODE_TREE,
  type ObjectReader,
  type TreeEntry,
} from "@keeltown/gitcore";
import {
  BUNDLE_MANIFEST,
  type BundleFile,
  BundleRefused as WriterRefused,
  readBundle,
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

/**
 * What a past bundle holds, under the ids git gives it: each file's bytes by
 * its blob id, and each directory's files (their paths from that directory)
 * by the tree id they derive. Nothing is stored beside a bundle and nothing
 * here is read from a repo: an id found here names exactly these bytes.
 */
interface Held {
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly trees: ReadonlyMap<string, readonly BundleFile[]>;
}

const NOTHING_HELD: Held = { blobs: new Map(), trees: new Map() };

/**
 * Hashes a bundle's files as git blobs, and derives each directory's tree id
 * from its files. One object at a time: hashing frames a copy of what it
 * hashes, so hashing every blob at once would hold the tree twice.
 */
async function holdingOf(files: readonly BundleFile[]): Promise<Held> {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, readonly BundleFile[]>();
  const blobAt = async (f: BundleFile): Promise<TreeEntry> => {
    const oid = await hashObject("blob", f.bytes);
    blobs.set(oid, f.bytes);
    return { name: f.path, mode: f.executable === true ? MODE_EXEC : MODE_FILE, oid };
  };
  const treeOf = async (under: readonly BundleFile[]): Promise<string> => {
    const here: TreeEntry[] = [];
    const directories = new Map<string, BundleFile[]>();
    for (const f of under) {
      const slash = f.path.indexOf("/");
      if (slash < 0) {
        // oxlint-disable-next-line no-await-in-loop -- one blob at a time, so one framed copy at most
        here.push(await blobAt(f));
        continue;
      }
      const below = directories.get(f.path.slice(0, slash)) ?? [];
      below.push({ ...f, path: f.path.slice(slash + 1) });
      directories.set(f.path.slice(0, slash), below);
    }
    for (const [name, below] of directories)
      // oxlint-disable-next-line no-await-in-loop -- as above, a directory after another
      here.push({ name, mode: MODE_TREE, oid: await treeOf(below) });
    const oid = await hashObject("tree", encodeTree(here));
    trees.set(oid, under);
    return oid;
  };
  await treeOf(files);
  return { blobs, trees };
}

/** `path`, refused when it is where the bundle keeps its own manifest. */
const unreserved = (path: string): string => {
  if (path === BUNDLE_MANIFEST) throw new Unbundlable(path, `${BUNDLE_MANIFEST} is reserved`);
  return path;
};

/**
 * Every regular file under `tree`, its subtrees read in parallel; a symlink
 * or submodule refuses the bundle. A subtree whose id `held` derived is taken
 * whole with no read, and a file whose blob id it holds is not read: the
 * reader is asked only for what the past bundle does not have.
 */
async function filesOf(
  reader: ObjectReader,
  held: Held,
  tree: string,
  prefix: string,
): Promise<BundleFile[]> {
  const under = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
  const whole = held.trees.get(tree);
  if (whole !== undefined) return whole.map((f) => ({ ...f, path: unreserved(under(f.path)) }));
  const nested = await Promise.all(
    (await reader.readTree(tree)).map(async (e): Promise<BundleFile[]> => {
      const path = under(e.name);
      if (e.mode === MODE_TREE) return filesOf(reader, held, e.oid, path);
      if (e.mode !== MODE_FILE && e.mode !== MODE_EXEC)
        throw new Unbundlable(
          path,
          `${path} has mode ${e.mode}: a bundle carries regular files only`,
        );
      return [
        {
          path: unreserved(path),
          bytes: held.blobs.get(e.oid) ?? (await reader.readBlob(e.oid)),
          executable: e.mode === MODE_EXEC,
        },
      ];
    }),
  );
  return nested.flat();
}

/**
 * CandidateBundles over gitcore's reads: the candidate commit's tree is read
 * from staging through the binding, written with the runner protocol's
 * bundle writer (the one implementation; never a second) and stored for the
 * namespace by its sha256. Anything the writer or the walk refuses is BundleRefused.
 * With `from`, that bundle is read back with the protocol's own reader and
 * the walk reads only what it does not hold.
 */
export const CandidateBundlesGitCore = (open: OpenObjects) =>
  Layer.effect(
    CandidateBundles,
    Effect.gen(function* () {
      const store = yield* BundleStore;
      /** What `from` holds, or nothing when it is missing or no bundle: it saves reads and decides nothing. */
      const heldIn = (namespace: NamespaceId, from: ContentHash | undefined) =>
        from === undefined
          ? Effect.succeed(NOTHING_HELD)
          : store.get(namespace, from).pipe(
              Effect.flatMap((bytes) =>
                Effect.tryPromise(async () => holdingOf(await readBundle(bytes))),
              ),
              Effect.catch(() => Effect.succeed(NOTHING_HELD)),
            );
      return CandidateBundles.of({
        bundle: (namespace, staging, commit, from) =>
          Effect.acquireUseRelease(
            Effect.promise(() => open(staging)),
            (reader) =>
              heldIn(namespace, from).pipe(
                Effect.flatMap((held) =>
                  Effect.tryPromise({
                    try: async () =>
                      writeBundle(
                        await filesOf(reader, held, (await reader.readCommit(commit)).tree, ""),
                      ),
                    catch: (cause) => cause,
                  }),
                ),
                Effect.catch((cause) =>
                  cause instanceof Unbundlable
                    ? Effect.fail(new BundleRefused({ reason: cause.message, path: cause.path }))
                    : cause instanceof WriterRefused
                      ? Effect.fail(new BundleRefused({ reason: cause.message }))
                      : Effect.die(cause),
                ),
                Effect.flatMap((bytes) => store.put(namespace, bytes)),
              ),
            (reader) => Effect.sync(() => reader[Symbol.dispose]()),
          ),
      });
    }),
  );
