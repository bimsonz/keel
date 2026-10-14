import type { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import { BundleRefused, BundleStore, CandidateBundles } from "@keeltown/core/ports";
import {
  encodeTree,
  hashObject,
  MODE_EXEC,
  MODE_FILE,
  MODE_TREE,
  MissingObject,
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
import { Cause, Effect, Layer } from "effect";
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

/** How much of a path a failed read names, from its end. */
const PATH_TAIL = 80;

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * How the walk paces its reads of the code host. Artifacts takes 2,000
 * requests in 10 s for one repo, and as many for one namespace, which every
 * project's staging shares; a large tree read all at once (Keel's own: about
 * 5,400 reads) overran it and every read after failed. The walk keeps a few
 * reads in flight, starts at most `perSecond` in a second (a quarter of the
 * namespace's rate), and retries a read the code host failed after each of
 * `retries`; an object the repo lacks is not retried.
 */
export interface ReadPace {
  readonly inFlight: number;
  readonly perSecond: number;
  readonly retries: readonly number[];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const READ_PACE: ReadPace = {
  inFlight: 8,
  perSecond: 50,
  retries: [1_000, 2_000, 4_000, 8_000],
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A read of the walk that the code host failed: which read, of which object
 * at which path, and how far the walk had got (the reads asked so far, those
 * in flight with it, and how many tries it had), so a bundle step that fails
 * says what it was doing. Led by what is read, since the Lane keeps a step's
 * error short.
 */
class BundleReadFailed extends Error {
  override readonly name = "BundleReadFailed";
}

/** A path as a failed read names it: its end, and the root as `/`. */
const at = (path: string) => (path === "" ? "/" : path.slice(-PATH_TAIL));

/** The walk's reads of `reader`, paced and counted, each failure a BundleReadFailed. */
interface CountedReads {
  readonly commit: (oid: string) => ReturnType<ObjectReader["readCommit"]>;
  readonly tree: (oid: string, path: string) => ReturnType<ObjectReader["readTree"]>;
  readonly blob: (oid: string, path: string) => ReturnType<ObjectReader["readBlob"]>;
}

function counted(reader: ObjectReader, pace: ReadPace): CountedReads {
  let asked = 0;
  let inFlight = 0;
  let nextStart = 0;
  const waiting: (() => void)[] = [];
  /** A slot among `pace.inFlight`: taken at once, or handed over by a read that ends. */
  const slot = async () => {
    if (inFlight < pace.inFlight) inFlight += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const free = () => {
    const next = waiting.shift();
    if (next === undefined) inFlight -= 1;
    else next();
  };
  /** Waits for this read's turn: starts are kept `1000 / perSecond` ms apart. */
  const turn = async () => {
    const now = pace.now();
    const start = Math.max(now, nextStart);
    nextStart = start + 1_000 / pace.perSecond;
    if (start > now) await pace.sleep(start - now);
  };
  const read = async <A>(what: string, call: () => Promise<A>): Promise<A> => {
    asked += 1;
    const nth = asked;
    await slot();
    try {
      for (let tries = 1; ; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a retry waits its turn, after the one before failed
        await turn();
        try {
          // oxlint-disable-next-line no-await-in-loop -- as above
          return await call();
        } catch (error) {
          const wait = pace.retries[tries - 1];
          if (error instanceof MissingObject || wait === undefined)
            throw new BundleReadFailed(
              `${what} failed as read ${nth} of ${asked}, ${inFlight} in flight, after ${tries} tries: ${messageOf(error)}`,
              { cause: error },
            );
          // oxlint-disable-next-line no-await-in-loop -- as above
          await pace.sleep(wait);
        }
      }
    } finally {
      free();
    }
  };
  return {
    commit: (oid) => read(`readCommit ${oid}`, () => reader.readCommit(oid)),
    tree: (oid, path) => read(`readTree ${at(path)} ${oid}`, () => reader.readTree(oid)),
    blob: (oid, path) => read(`readBlob ${at(path)} ${oid}`, () => reader.readBlob(oid)),
  };
}

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
  reads: CountedReads,
  held: Held,
  tree: string,
  prefix: string,
): Promise<BundleFile[]> {
  const under = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
  const whole = held.trees.get(tree);
  if (whole !== undefined) return whole.map((f) => ({ ...f, path: unreserved(under(f.path)) }));
  const nested = await Promise.all(
    (await reads.tree(tree, prefix)).map(async (e): Promise<BundleFile[]> => {
      const path = under(e.name);
      if (e.mode === MODE_TREE) return filesOf(reads, held, e.oid, path);
      if (e.mode !== MODE_FILE && e.mode !== MODE_EXEC)
        throw new Unbundlable(
          path,
          `${path} has mode ${e.mode}: a bundle carries regular files only`,
        );
      return [
        {
          path: unreserved(path),
          bytes: held.blobs.get(e.oid) ?? (await reads.blob(e.oid, path)),
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
 * the walk reads only what it does not hold. The walk's reads are paced
 * (`ReadPace`), so a large tree stays inside Artifacts' request rate.
 */
export const CandidateBundlesGitCore = (open: OpenObjects, pace: ReadPace = READ_PACE) =>
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
                    try: async () => {
                      const reads = counted(reader, pace);
                      return writeBundle(
                        await filesOf(reads, held, (await reads.commit(commit)).tree, ""),
                      );
                    },
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
                Effect.flatMap((bytes) =>
                  store.put(namespace, bytes).pipe(
                    // Said as the put's, so a step that fails here is not taken for a read.
                    Effect.catchCause((cause) =>
                      Effect.die(
                        new Error(
                          `BundleStore.put of ${bytes.length} B failed: ${messageOf(Cause.squash(cause))}`,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            (reader) => Effect.sync(() => reader[Symbol.dispose]()),
          ),
      });
    }),
  );
