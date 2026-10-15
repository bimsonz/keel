import { gitRemote } from "../gitcore/remote.ts";
import { CommitSha, Instant } from "@keeltown/core/kernel";
import {
  CodeHost,
  type CommitInfo,
  type Imported,
  ImportRefused,
  ObjectNotFound,
  PathNotFound,
  RefNotFound,
  RepoAlreadyExists,
  RepoNotFound,
  type RepoRef,
  type TreeEntry,
} from "@keeltown/core/ports";
import {
  advertisedRefs,
  advertisement,
  compareTreeEntries,
  diffTrees,
  isAncestor,
  MissingObject,
  MODE_GITLINK,
  MODE_TREE,
  PackTooLarge,
  relayPack,
  relaySend,
  type TreeEntry as GitTreeEntry,
  type TreeReader,
} from "@keeltown/gitcore";
import { Effect, Layer, Result, Schema } from "effect";
import { objectsOf } from "./objects.ts";
import { type HandleReads, refreshingReads } from "./refreshing-handle.ts";

const toCommitSha = Schema.decodeUnknownSync(CommitSha);
const plain = (repo: RepoRef) => ({ namespace: repo.namespace, name: repo.name });

/**
 * A binding's "no such repo". On the edge it is an `ArtifactsError` with code
 * `NOT_FOUND`; through wrangler's remote-binding proxy (the live tests) the
 * code is lost and only the message survives, so both are recognised.
 */
const isRepoNotFound = (e: unknown): boolean =>
  e instanceof Error &&
  ((e as Error & { readonly code?: unknown }).code === "NOT_FOUND" ||
    /^(ArtifactsError: )?Repository not found\b/.test(e.message));

const repoMissing = (repo: RepoRef, e: unknown) =>
  isRepoNotFound(e) && new RepoNotFound({ repo: plain(repo) });

/** `ALREADY_EXISTS` on the edge; through wrangler's proxy, which drops `code`, the message alone (live, 11 Oct). */
const isRepoAlreadyExists = (e: unknown): boolean =>
  e instanceof Error &&
  ((e as Error & { readonly code?: unknown }).code === "ALREADY_EXISTS" ||
    /^(ArtifactsError: )?repo already exists\b/i.test(e.message));

/** A create or fork onto a taken name, typed; anything else from the call dies. */
const unlessTaken = (repo: RepoRef) => (e: unknown) =>
  isRepoAlreadyExists(e)
    ? Effect.fail(new RepoAlreadyExists({ repo: plain(repo) }))
    : Effect.die(e);

const BRANCH = "refs/heads/";

/**
 * Why the binding imported nothing, as the port says it. On the edge the
 * error carries a `code`; through wrangler's remote-binding proxy only the
 * message survives (each read live, 13 Oct), so both are recognised. A
 * missing branch is told by its message first, since its code is not
 * documented; a repository that asks for a credential is private or absent,
 * and reads as not found. Over the memory limit has no measured message.
 */
const importRefusal = (e: unknown): ImportRefused["reason"] | undefined => {
  if (!(e instanceof Error)) return undefined;
  const code = (e as Error & { readonly code?: unknown }).code;
  const says = (pattern: RegExp) => pattern.test(e.message);
  if (says(/^(ArtifactsError: )?Branch not found\b/)) return "no-branch";
  if (code === "REMOTE_AUTH_REQUIRED" || says(/ requires authentication \(HTTP 401\)/))
    return "not-found";
  if (code === "NOT_FOUND" || says(/^(ArtifactsError: )?Repository ".*" was not found\b/))
    return "not-found";
  if (code === "INVALID_URL" || says(/\bdoes not point to a git repository\b/)) return "not-git";
  if (code === "UPSTREAM_UNAVAILABLE" || says(/\bupstream service is unavailable\b/))
    return "unreachable";
  return code === "MEMORY_LIMIT" ? "too-large" : undefined;
};

/** The repo's branches from its own advertisement, in name order, read with a minute-long token that is revoked once read. */
async function advertisedBranches(
  handle: Pick<ArtifactsRepo, "info" | "createToken" | "revokeToken">,
): Promise<Imported[]> {
  const [info, token] = await Promise.all([handle.info(), handle.createToken("read", 60)]);
  try {
    const refs = await advertisedRefs(gitRemote(info.remote, token.plaintext));
    return [...refs]
      .filter(([ref]) => ref.startsWith(BRANCH))
      .map(([ref, hash]) => ({ ref, commit: toCommitSha(hash) }))
      .toSorted((a, b) => (a.ref < b.ref ? -1 : 1));
  } finally {
    await handle.revokeToken(token.plaintext);
  }
}

/**
 * An import by relay, for one Artifacts answered as unavailable: its own
 * import gives up after about 65 s, which a repository of about 20 MB already
 * takes (live, 14 Oct). The branch named, else the one the upstream's HEAD
 * names, is read from the upstream's own advertisement with no credential,
 * and its whole history is relayed into a new, empty repo under the target's
 * name, after whatever the failed import left there is deleted. An upstream
 * that does not answer is `unreachable` still; a relay that does not land
 * deletes the repo it made, so a refused import leaves none.
 */
async function relayImport(
  namespace: Artifacts,
  name: string,
  source: { readonly url: string; readonly ref?: string | undefined },
): Promise<void> {
  const upstream = gitRemote(source.url);
  const advertised = await advertisement(upstream).catch(() => {
    throw new ImportRefused({ reason: "unreachable" });
  });
  const ref = source.ref === undefined ? advertised.head : `${BRANCH}${source.ref}`;
  const to = ref === undefined ? undefined : advertised.refs.get(ref);
  if (ref === undefined || to === undefined) throw new ImportRefused({ reason: "no-branch" });
  const move = { ref, from: null, to };
  const pack = await relayPack(upstream, move).catch((e: unknown) => {
    throw new ImportRefused({ reason: e instanceof PackTooLarge ? "too-large" : "unreachable" });
  });
  await namespace.delete(name);
  const made = await namespace.create(name);
  try {
    const sent = await relaySend(gitRemote(made.remote, made.token), move, pack);
    if (sent.kind !== "advanced") throw new Error(`an import's relay was ${sent.kind}`);
  } catch (e) {
    // Its tokens go with it.
    await namespace.delete(name);
    throw e;
  }
  await revoke(namespace, name, made.token);
}

/** What a body run on a repo calls on its handle. */
type RepoHandle = HandleReads &
  Pick<ArtifactsRepo, "info" | "log" | "createToken" | "revokeToken" | "fork">;

/** A fork whose target name was taken, carried out of the binding call to become RepoAlreadyExists. */
const TAKEN = Symbol("taken");

/** A ref's commit. The binding's `log` resolves branch names (`main`) but not full ref names, so other refs are read from the advertisement with a minute-long read token. */
async function resolveRef(handle: RepoHandle, ref: string): Promise<string | undefined> {
  if (ref.startsWith(BRANCH))
    return (await handle.log({ ref: ref.slice(BRANCH.length), limit: 1 }))[0]?.hash;
  const [info, token] = await Promise.all([handle.info(), handle.createToken("read", 60)]);
  return (await advertisedRefs(gitRemote(info.remote, token.plaintext))).get(ref);
}

/** Revokes a token on a repo, through a handle opened for the purpose. */
async function revoke(namespace: Artifacts, name: string, token: string): Promise<void> {
  const handle = await namespace.get(name);
  try {
    await handle.revokeToken(token);
  } finally {
    handle[Symbol.dispose]();
  }
}

async function rootTree(handle: HandleReads, commit: string): Promise<string> {
  const read = await handle.readCommit(commit);
  if (read === null) throw new MissingObject(commit);
  return read.treeHash;
}

/**
 * Tree objects already read, by repo and id. What a git id names never
 * changes, and each key names the repo as well as the id, so one repo's tree
 * is never served as another's. Past `limit` trees the one least recently
 * read goes. Only a tree that was read whole is kept, never a read under way.
 */
function treeCache(limit: number) {
  const held = new Map<string, readonly GitTreeEntry[]>();
  return (repo: RepoRef, reader: TreeReader): TreeReader => ({
    readTree: async (oid) => {
      const key = JSON.stringify([repo.namespace, repo.name, oid]);
      const found = held.get(key);
      if (found !== undefined) {
        held.delete(key);
        held.set(key, found);
        return found;
      }
      const entries = await reader.readTree(oid);
      held.set(key, entries);
      for (const oldest of held.keys()) {
        if (held.size <= limit) break;
        held.delete(oldest);
      }
      return entries;
    },
  });
}

/** The whole tree under `tree`, in git order, each tree before what it holds; subtrees are read in parallel. */
async function listTree(reader: TreeReader, tree: string, prefix: string): Promise<TreeEntry[]> {
  const entries = (await reader.readTree(tree)).toSorted(compareTreeEntries);
  const nested = await Promise.all(
    entries.map(async (e): Promise<TreeEntry[]> => {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      const type = e.mode === MODE_TREE ? "tree" : e.mode === MODE_GITLINK ? "commit" : "blob";
      const self: TreeEntry = { path, mode: e.mode, oid: e.oid, type };
      return type === "tree" ? [self, ...(await listTree(reader, e.oid, path))] : [self];
    }),
  );
  return nested.flat();
}

/** The binding's commit metadata as the port's commit; its timestamps are Unix seconds. */
const commitInfo = (c: ArtifactsCommitMetadata): CommitInfo => ({
  sha: toCommitSha(c.hash),
  tree: c.treeHash,
  parents: c.parents.map((p) => toCommitSha(p)),
  message: c.message,
  author: { name: c.author.name, email: c.author.email, at: Instant(c.authoredAt * 1000) },
  committer: {
    name: c.committer.name,
    email: c.committer.email,
    at: Instant(c.committedAt * 1000),
  },
});

/** A path absent from the commit, or naming something other than a directory. */
const NO_DIRECTORY = Symbol("no-directory");

/** The directory at `path` under the root tree `root`, walked one tree read per segment. */
async function directory(
  reader: TreeReader,
  root: string,
  path: string,
): Promise<TreeEntry[] | typeof NO_DIRECTORY> {
  let tree = root;
  for (const name of path === "" ? [] : path.split("/")) {
    const entry = (await reader.readTree(tree)).find((e) => e.name === name);
    if (entry?.mode !== MODE_TREE) return NO_DIRECTORY;
    tree = entry.oid;
  }
  const entries = await reader.readTree(tree);
  return entries.toSorted(compareTreeEntries).map((e) => {
    const type = e.mode === MODE_TREE ? "tree" : e.mode === MODE_GITLINK ? "commit" : "blob";
    return { path: path === "" ? e.name : `${path}/${e.name}`, mode: e.mode, oid: e.oid, type };
  });
}

/** How many blobs `readBlobs` reads at once through its one handle. */
const BLOB_READS = 8;

/** What a CodeHost on Artifacts is built with beside its bindings. */
export interface CodeHostOptions {
  /**
   * Keep up to this many tree objects once read, so a later walk through the
   * same layer reads only the trees no earlier walk did. For a layer that
   * lives one run; absent, every walk reads every tree.
   */
  readonly trees?: number | undefined;
}

/**
 * Precheck's tree cap, per run. A run holds the trees it walked anyway, so
 * the cache adds little to that: a repo of fewer trees is kept whole (Keel's
 * own and a 10 MB import, 468 trees, many times over), and a larger one costs
 * at most what one walk of 8,192 trees holds.
 */
export const PRECHECK_TREES = 8192;

/**
 * CodeHost on Artifacts bindings, one per namespace (`keel-core` → ARTIFACTS,
 * `keel-ws-00` → WORKSPACES). Reads go through the binding; gitcore diffs over
 * its tree reads. A repo the binding cannot find is `RepoNotFound`, an object
 * it lacks `ObjectNotFound`; any other binding error is a defect. Nothing here
 * logs a repo's remote: its host carries the account id.
 *
 * With `options.trees`, the layer keeps the tree objects its walks read
 * (`readTree`, `listDir`, `diffTrees`), each layer built its own, so the cache
 * lives as long as the runtime that built it.
 */
export function CodeHostArtifacts(
  namespaces: Readonly<Record<string, Artifacts>>,
  options: CodeHostOptions = {},
) {
  const binding = (repo: RepoRef): Artifacts => {
    const found = namespaces[repo.namespace];
    if (found === undefined)
      throw new Error(`no Artifacts binding serves namespace ${repo.namespace}`);
    return found;
  };

  /**
   * Opens the repo, runs `body`, and releases the handle. Its reads go on
   * through a fresh handle past one handle's reads (`refreshingReads`), and
   * every other call goes to the handle read through now. Fails with
   * whatever was thrown.
   */
  const run = <A>(repo: RepoRef, body: (handle: RepoHandle) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        const reads = refreshingReads(await binding(repo).get(repo.name), () =>
          binding(repo).get(repo.name),
        );
        try {
          return await body({
            readTree: reads.readTree,
            readBlob: reads.readBlob,
            readCommit: reads.readCommit,
            info: () => reads.use((handle) => handle.info()),
            log: (...args) => reads.use((handle) => handle.log(...args)),
            createToken: (...args) => reads.use((handle) => handle.createToken(...args)),
            revokeToken: (...args) => reads.use((handle) => handle.revokeToken(...args)),
            fork: (...args) => reads.use((handle) => handle.fork(...args)),
          });
        } finally {
          reads[Symbol.dispose]();
        }
      },
      catch: (e) => e,
    });

  /** A missing repo is `RepoNotFound`; anything else is a defect. */
  const onRepo = <A>(
    repo: RepoRef,
    body: (handle: RepoHandle) => Promise<A>,
  ): Effect.Effect<A, RepoNotFound> =>
    run(repo, body).pipe(
      Effect.catch((e): Effect.Effect<never, RepoNotFound> => {
        const missing = repoMissing(repo, e);
        return missing ? Effect.fail(missing) : Effect.die(e);
      }),
    );

  /** Also maps an object the repo lacks (`MissingObject`) to `ObjectNotFound`. */
  const onObjects = <A>(
    repo: RepoRef,
    body: (handle: RepoHandle) => Promise<A>,
  ): Effect.Effect<A, RepoNotFound | ObjectNotFound> =>
    run(repo, body).pipe(
      Effect.catch((e): Effect.Effect<never, RepoNotFound | ObjectNotFound> => {
        const missing = repoMissing(repo, e);
        if (missing) return Effect.fail(missing);
        return e instanceof MissingObject
          ? Effect.fail(new ObjectNotFound({ repo: plain(repo), oid: e.oid }))
          : Effect.die(e);
      }),
    );

  return Layer.sync(CodeHost, () => {
    const kept = options.trees === undefined ? undefined : treeCache(options.trees);
    /** The handle's tree reads, through this layer's cache when it keeps one. */
    const treesOf = (repo: RepoRef, handle: HandleReads): TreeReader =>
      kept === undefined ? objectsOf(handle) : kept(repo, objectsOf(handle));
    return CodeHost.of({
      // create() and fork() each return a day-long write token Keel never uses: revoke it at once, so no pooled repo carries a standing credential.
      create: (repo) =>
        Effect.tryPromise({
          try: async () => {
            const created = await binding(repo).create(repo.name);
            await revoke(binding(repo), repo.name, created.token);
            return repo;
          },
          catch: (e) => e,
        }).pipe(Effect.catch(unlessTaken(repo))),
      fork: (source, target) =>
        source.namespace === target.namespace
          ? onRepo(source, async (handle) => {
              try {
                const forked = await handle.fork(target.name, { defaultBranchOnly: true });
                await revoke(binding(target), target.name, forked.token);
                return target;
              } catch (e) {
                if (isRepoAlreadyExists(e)) return TAKEN;
                throw e;
              }
            }).pipe(
              Effect.flatMap((forked) =>
                forked === TAKEN
                  ? Effect.fail(new RepoAlreadyExists({ repo: plain(target) }))
                  : Effect.succeed(forked),
              ),
            )
          : Effect.die(
              new Error("a fork lands in its source's namespace; the target names another"),
            ),
      // The binding reports `main` as an imported repo's default branch whatever came (live, 13 Oct): the repo's own advertisement names the branch.
      import: (source, target) =>
        Effect.tryPromise({
          try: async () => {
            try {
              const made = await binding(target).import({
                source: {
                  url: source.url,
                  ...(source.ref === undefined ? {} : { branch: source.ref }),
                },
                target: { name: target.name },
              });
              await revoke(binding(target), target.name, made.token);
            } catch (e) {
              if (importRefusal(e) !== "unreachable") throw e;
              await relayImport(binding(target), target.name, source);
            }
            const handle = await binding(target).get(target.name);
            try {
              return await advertisedBranches(handle);
            } finally {
              handle[Symbol.dispose]();
            }
          },
          catch: (e) => e,
        }).pipe(
          Effect.catch((e): Effect.Effect<never, RepoAlreadyExists | ImportRefused> => {
            if (e instanceof ImportRefused) return Effect.fail(e);
            const reason = importRefusal(e);
            return reason === undefined
              ? unlessTaken(target)(e)
              : Effect.fail(new ImportRefused({ reason }));
          }),
          Effect.flatMap((came): Effect.Effect<Imported, ImportRefused> => {
            const [branch, ...others] = came;
            if (branch !== undefined && others.length === 0) return Effect.succeed(branch);
            // An upstream with no commit imports as a repo with no branch: nothing to start a trunk from.
            return came.length === 0
              ? Effect.promise(() => binding(target).delete(target.name)).pipe(
                  Effect.andThen(Effect.fail(new ImportRefused({ reason: "no-branch" }))),
                )
              : Effect.die(new Error(`an import brought ${came.length} branches, not one`));
          }),
        ),
      branches: (repo) => onRepo(repo, advertisedBranches),
      mintToken: (repo, access, ttlSeconds) =>
        onRepo(repo, (handle) => handle.createToken(access, ttlSeconds)).pipe(
          Effect.map((t) => ({
            token: t.plaintext,
            access,
            expiresAt: Instant(Date.parse(t.expiresAt)),
          })),
        ),
      info: (repo) =>
        onRepo(repo, (handle) => handle.info()).pipe(
          Effect.map((i) => ({ remote: i.remote, defaultBranch: i.defaultBranch })),
        ),
      head: (repo, ref) =>
        onRepo(repo, (handle) => resolveRef(handle, ref)).pipe(
          Effect.flatMap((hash) =>
            hash === undefined
              ? Effect.fail(new RefNotFound({ repo: plain(repo), ref }))
              : Effect.succeed(toCommitSha(hash)),
          ),
        ),
      hasCommit: (repo, sha) =>
        onRepo(repo, async (handle) => (await handle.readCommit(sha)) !== null),
      isAncestor: (repo, ancestor, descendant, stopAt) =>
        onObjects(repo, (handle) =>
          isAncestor(objectsOf(handle), ancestor, descendant, { stopAt }),
        ),
      readTree: (repo, commit) =>
        onObjects(repo, async (handle) =>
          listTree(treesOf(repo, handle), await rootTree(handle, commit), ""),
        ),
      readBlob: (repo, oid) =>
        onObjects(repo, async (handle) => {
          const blob = await handle.readBlob(oid);
          if (blob === null) throw new MissingObject(oid);
          return new Uint8Array(await blob.arrayBuffer());
        }),
      readBlobs: (repo, oids) =>
        onRepo(repo, async (handle) => {
          const read = async (oid: string): Promise<Result.Result<Uint8Array, ObjectNotFound>> => {
            const blob = await handle.readBlob(oid);
            return blob === null
              ? Result.fail(new ObjectNotFound({ repo: plain(repo), oid }))
              : Result.succeed(new Uint8Array(await blob.arrayBuffer()));
          };
          // A few readers take the next blob from one queue, all through this one handle.
          const queue = oids.entries();
          const answers: Result.Result<Uint8Array, ObjectNotFound>[] = [];
          const reader = async (): Promise<void> => {
            for (const [at, oid] of queue) answers[at] = await read(oid);
          };
          await Promise.all(Array.from({ length: BLOB_READS }, reader));
          return answers;
        }),
      listDir: (repo, commit, path) =>
        onObjects(repo, async (handle) =>
          directory(treesOf(repo, handle), await rootTree(handle, commit), path),
        ).pipe(
          Effect.flatMap((entries) =>
            entries === NO_DIRECTORY
              ? Effect.fail(new PathNotFound({ repo: plain(repo), commit, path }))
              : Effect.succeed(entries),
          ),
        ),
      readCommit: (repo, sha) =>
        onObjects(repo, async (handle) => {
          const read = await handle.readCommit(sha);
          if (read === null) throw new MissingObject(sha);
          return commitInfo(read);
        }),
      // The binding's log takes a commit id as its ref (live, 11 Oct) and answers [] for one it lacks.
      log: (repo, from, limit) =>
        limit < 1
          ? Effect.succeed([])
          : onObjects(repo, async (handle) => {
              const chain = await handle.log({ ref: from, limit });
              if (chain[0]?.hash !== from) throw new MissingObject(from);
              return chain.map(commitInfo);
            }),
      diffTrees: (repo, base, head) =>
        onObjects(repo, async (handle) => {
          const [before, after] = await Promise.all([
            rootTree(handle, base),
            rootTree(handle, head),
          ]);
          return diffTrees(treesOf(repo, handle), before, after);
        }),
      delete: (repo) => Effect.promise(() => binding(repo).delete(repo.name)).pipe(Effect.asVoid),
    });
  });
}
