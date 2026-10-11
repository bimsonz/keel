import { CommitSha, Instant } from "@keeltown/core/kernel";
import {
  CodeHost,
  ObjectNotFound,
  RefNotFound,
  RepoAlreadyExists,
  RepoNotFound,
  type RepoRef,
  type TreeEntry,
} from "@keeltown/core/ports";
import {
  advertisedRefs,
  compareTreeEntries,
  diffTrees,
  MissingObject,
  MODE_GITLINK,
  MODE_TREE,
  normaliseMode,
  type TreeReader,
} from "@keeltown/gitcore";
import { Effect, Layer, Schema } from "effect";

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

/** A fork whose target name was taken, carried out of the binding call to become RepoAlreadyExists. */
const TAKEN = Symbol("taken");

/** A ref's commit. The binding's `log` resolves branch names (`main`) but not full ref names, so other refs are read from the advertisement with a minute-long read token. */
async function resolveRef(handle: ArtifactsRepo, ref: string): Promise<string | undefined> {
  if (ref.startsWith(BRANCH))
    return (await handle.log({ ref: ref.slice(BRANCH.length), limit: 1 }))[0]?.hash;
  const [info, token] = await Promise.all([handle.info(), handle.createToken("read", 60)]);
  return (await advertisedRefs({ url: info.remote, token: token.plaintext })).get(ref);
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

/** gitcore's reader over one open repo handle: a tree the repo lacks throws `MissingObject`. */
const readerOf = (handle: ArtifactsRepo): TreeReader => ({
  readTree: async (oid) => {
    const entries = await handle.readTree(oid);
    if (entries === null) throw new MissingObject(oid);
    return entries.map((e) => ({ name: e.name, mode: normaliseMode(e.mode), oid: e.hash }));
  },
});

async function rootTree(handle: ArtifactsRepo, commit: string): Promise<string> {
  const read = await handle.readCommit(commit);
  if (read === null) throw new MissingObject(commit);
  return read.treeHash;
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

/**
 * CodeHost on Artifacts bindings, one per namespace (`keel-core` → ARTIFACTS,
 * `keel-ws-00` → WORKSPACES). Reads go through the binding; gitcore diffs over
 * its tree reads. A repo the binding cannot find is `RepoNotFound`, an object
 * it lacks `ObjectNotFound`; any other binding error is a defect. Nothing here
 * logs a repo's remote: its host carries the account id.
 */
export function CodeHostArtifacts(namespaces: Readonly<Record<string, Artifacts>>) {
  const binding = (repo: RepoRef): Artifacts => {
    const found = namespaces[repo.namespace];
    if (found === undefined)
      throw new Error(`no Artifacts binding serves namespace ${repo.namespace}`);
    return found;
  };

  /** Opens the repo, runs `body`, and releases the handle. Fails with whatever was thrown. */
  const run = <A>(repo: RepoRef, body: (handle: ArtifactsRepo) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await binding(repo).get(repo.name);
        try {
          return await body(handle);
        } finally {
          handle[Symbol.dispose]();
        }
      },
      catch: (e) => e,
    });

  /** A missing repo is `RepoNotFound`; anything else is a defect. */
  const onRepo = <A>(
    repo: RepoRef,
    body: (handle: ArtifactsRepo) => Promise<A>,
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
    body: (handle: ArtifactsRepo) => Promise<A>,
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

  return Layer.succeed(
    CodeHost,
    CodeHost.of({
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
      readTree: (repo, commit) =>
        onObjects(repo, async (handle) =>
          listTree(readerOf(handle), await rootTree(handle, commit), ""),
        ),
      readBlob: (repo, oid) =>
        onObjects(repo, async (handle) => {
          const blob = await handle.readBlob(oid);
          if (blob === null) throw new MissingObject(oid);
          return new Uint8Array(await blob.arrayBuffer());
        }),
      diffTrees: (repo, base, head) =>
        onObjects(repo, async (handle) => {
          const [before, after] = await Promise.all([
            rootTree(handle, base),
            rootTree(handle, head),
          ]);
          return diffTrees(readerOf(handle), before, after);
        }),
      delete: (repo) => Effect.promise(() => binding(repo).delete(repo.name)).pipe(Effect.asVoid),
    }),
  );
}
