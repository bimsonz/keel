// A cache in front of the repo reads the HTTP isolate makes. It holds only what
// a git id names, which never changes: a blob, a commit, a commit's tree or one
// of its directories, the diff between two commits, and a commit a repo is
// known to hold. A ref, which moves, is always read from the host, and so is
// every miss and every error: a commit a repo lacks now may be pushed later.
//
// It sits behind the doorway's authorisation, never in front of it: a handler
// decides whether its caller may read the repo before it asks CodeHost for
// anything, so a cached object is only ever served to a caller already
// allowed it. Every key names the repo as well as the id, so an object one
// repo holds is never served as another's.
import { Effect, Layer, Option, Schema } from "effect";
import { CommitSha, Instant } from "@keeltown/core/kernel";
import {
  type CommitInfo,
  CodeHost,
  type RepoRef,
  type TreeChange,
  type TreeEntry,
} from "@keeltown/core/ports";

/** How much one isolate keeps in memory: at most `entries` values, together at most `bytes`. */
export interface MemoryLimits {
  readonly entries: number;
  readonly bytes: number;
}

export const MEMORY_LIMITS: MemoryLimits = { entries: 4096, bytes: 32 * 1024 * 1024 };

/** A value as the memory tier keeps it, with what it weighs. */
interface Held {
  readonly value: unknown;
  readonly bytes: number;
}

/**
 * The isolate's own tier: a least-recently-used map bounded in entries and in
 * bytes. A value heavier than an eighth of the bytes is not kept, so one large
 * blob cannot empty it.
 */
export function makeMemoryTier(limits: MemoryLimits = MEMORY_LIMITS) {
  const held = new Map<string, Held>();
  let weight = 0;
  return {
    get: (key: string): unknown => {
      const found = held.get(key);
      if (found === undefined) return undefined;
      held.delete(key);
      held.set(key, found);
      return found.value;
    },
    set: (key: string, value: unknown, bytes: number) => {
      if (bytes > limits.bytes / 8) return;
      const before = held.get(key);
      if (before !== undefined) {
        held.delete(key);
        weight -= before.bytes;
      }
      held.set(key, { value, bytes });
      weight += bytes;
      for (const [oldest, entry] of held) {
        if (held.size <= limits.entries && weight <= limits.bytes) break;
        held.delete(oldest);
        weight -= entry.bytes;
      }
    },
    /** How many values and bytes it holds. */
    size: () => ({ entries: held.size, bytes: weight }),
  };
}

export type MemoryTier = ReturnType<typeof makeMemoryTier>;

export interface ReadCacheOptions {
  /** This deployment's host, so two deployments sharing a colo's cache never share keys. */
  readonly host: string;
  readonly memory: MemoryTier;
  /** The colo's cache (`caches.default`), behind the memory tier; absent, memory alone. */
  readonly shared?: Cache | undefined;
  /** Runs a write to the shared tier after the response, never in its way (R7). */
  readonly background: (work: Promise<unknown>) => void;
}

/** How long the shared tier keeps a value: what an id names never changes. */
const SHARED_SECONDS = 7 * 24 * 60 * 60;

const Identity = Schema.Struct({ name: Schema.String, email: Schema.String, at: Schema.Number });
const StoredCommit = Schema.Struct({
  sha: CommitSha,
  tree: Schema.String,
  parents: Schema.Array(CommitSha),
  message: Schema.String,
  author: Identity,
  committer: Identity,
});
const StoredEntries = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    mode: Schema.String,
    oid: Schema.String,
    type: Schema.Literals(["blob", "tree", "commit"]),
  }),
);
const StoredChanges = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    change: Schema.Literals(["added", "deleted", "modified", "type-changed"]),
    oldOid: Schema.optionalKey(Schema.String),
    newOid: Schema.optionalKey(Schema.String),
    oldMode: Schema.optionalKey(Schema.String),
    newMode: Schema.optionalKey(Schema.String),
  }),
);

const commitOf = (stored: typeof StoredCommit.Type): CommitInfo => ({
  ...stored,
  author: { ...stored.author, at: Instant(stored.author.at) },
  committer: { ...stored.committer, at: Instant(stored.committer.at) },
});

/** How one kind of read is kept: its value as bytes for the shared tier, and back. */
interface Codec<A> {
  readonly encode: (value: A) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => A | undefined;
  /** Whether a value the memory tier holds is one of this kind (its key already says which). */
  readonly is: (value: unknown) => value is A;
}

const text = new TextEncoder();
const fromText = new TextDecoder();

const parsed = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(fromText.decode(bytes));
  } catch {
    return undefined;
  }
};

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
const isCommit = (value: unknown): value is CommitInfo =>
  typeof value === "object" && value !== null && "sha" in value && "parents" in value;
const isEntries = (value: unknown): value is readonly TreeEntry[] => Array.isArray(value);
const isChanges = (value: unknown): value is readonly TreeChange[] => Array.isArray(value);

const decodeCommit = Schema.decodeUnknownOption(StoredCommit);
const decodeEntries = Schema.decodeUnknownOption(StoredEntries);
const decodeChanges = Schema.decodeUnknownOption(StoredChanges);

const BLOB: Codec<Uint8Array> = { encode: (value) => value, decode: (bytes) => bytes, is: isBytes };
const COMMIT: Codec<CommitInfo> = {
  encode: (value) => text.encode(JSON.stringify(value)),
  decode: (bytes) => Option.getOrUndefined(Option.map(decodeCommit(parsed(bytes)), commitOf)),
  is: isCommit,
};
const ENTRIES: Codec<readonly TreeEntry[]> = {
  encode: (value) => text.encode(JSON.stringify(value)),
  decode: (bytes) => Option.getOrUndefined(decodeEntries(parsed(bytes))),
  is: isEntries,
};
const CHANGES: Codec<readonly TreeChange[]> = {
  encode: (value) => text.encode(JSON.stringify(value)),
  decode: (bytes) => Option.getOrUndefined(decodeChanges(parsed(bytes))),
  is: isChanges,
};
/** Only a yes is kept: a commit a repo lacks now may be pushed later. */
const HELD: Codec<boolean> = {
  encode: () => text.encode("1"),
  decode: () => true,
  is: (value): value is boolean => value === true,
};

/** A key no other deployment, repo or kind of read shares. */
const keyOf = (host: string, kind: string, repo: RepoRef, ids: readonly string[]) =>
  `https://${host}/_cache/code/v1/${kind}/${[repo.namespace, repo.name, ...ids].map(encodeURIComponent).join("/")}`;

/** The shared tier's value under `key`; anything amiss reads as a miss. */
const fromShared = <A>(shared: Cache | undefined, key: string, codec: Codec<A>) =>
  Effect.tryPromise(async () => {
    const found = await shared?.match(key);
    return found === undefined
      ? undefined
      : codec.decode(new Uint8Array(await found.arrayBuffer()));
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Keeps a value read from the host in memory now, and in the shared tier in the background. */
const keep = <A>(options: ReadCacheOptions, key: string, codec: Codec<A>, value: A) => {
  const bytes = codec.encode(value);
  options.memory.set(key, value, bytes.byteLength);
  const shared = options.shared;
  if (shared === undefined) return;
  const response = new Response(bytes, {
    headers: { "cache-control": `public, max-age=${SHARED_SECONDS}, immutable` },
  });
  options.background(shared.put(key, response).catch(() => undefined));
};

/** `read`, unless memory or the shared tier holds its value; a value `worth` keeping is kept. */
const cached = <A, E>(
  options: ReadCacheOptions,
  key: string,
  codec: Codec<A>,
  read: Effect.Effect<A, E>,
  worth: (value: A) => boolean = () => true,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const inMemory = options.memory.get(key);
    if (codec.is(inMemory)) return Effect.succeed(inMemory);
    return Effect.flatMap(fromShared(options.shared, key, codec), (shared) => {
      if (shared !== undefined) {
        options.memory.set(key, shared, codec.encode(shared).byteLength);
        return Effect.succeed(shared);
      }
      return Effect.tap(read, (value) =>
        Effect.sync(() => {
          if (worth(value)) keep(options, key, codec, value);
        }),
      );
    });
  });

/**
 * CodeHost with its reads by id cached: in this isolate's memory first, then
 * in the colo's cache. A value found in neither is read from the host and
 * kept in both, the shared write in the background. A failed read is passed
 * on and kept nowhere, and `hasCommit` keeps only a yes.
 */
export const CodeHostReadCache = (
  options: ReadCacheOptions,
): Layer.Layer<CodeHost, never, CodeHost> => {
  const key = (kind: string, repo: RepoRef, ...ids: readonly string[]) =>
    keyOf(options.host, kind, repo, ids);
  return Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (host) =>
      CodeHost.of({
        ...host,
        readBlob: (repo, oid) =>
          cached(options, key("blob", repo, oid), BLOB, host.readBlob(repo, oid)),
        readCommit: (repo, sha) =>
          cached(options, key("commit", repo, sha), COMMIT, host.readCommit(repo, sha)),
        readTree: (repo, commit) =>
          cached(options, key("tree", repo, commit), ENTRIES, host.readTree(repo, commit)),
        listDir: (repo, commit, path) =>
          cached(
            options,
            key("dir", repo, commit, path),
            ENTRIES,
            host.listDir(repo, commit, path),
          ),
        diffTrees: (repo, base, head) =>
          cached(options, key("diff", repo, base, head), CHANGES, host.diffTrees(repo, base, head)),
        hasCommit: (repo, sha) =>
          cached(options, key("has", repo, sha), HELD, host.hasCommit(repo, sha), (held) => held),
      }),
    ),
  );
};
