import { CommitSha, Instant } from "@keeltown/core/kernel";
import { CodeHost, ObjectNotFound, RefNotFound, RepoNotFound, type RepoRef, type TreeEntry } from "@keeltown/core/ports";
import { decodeCommit, decodeTree, diffTrees, type GitObject, MissingObject, MODE_GITLINK, MODE_TREE } from "@keeltown/gitcore";
import { Clock as EffectClock, Effect, Layer, Schema } from "effect";
import { buildCommit, buildTree, CodeHostFixture } from "../code-host-fixture.ts";

interface MemoryRepo {
  readonly refs: Map<string, CommitSha>;
  readonly objects: Map<string, GitObject>;
}

const repoKey = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;
const plain = (repo: RepoRef) => ({ namespace: repo.namespace, name: repo.name });
const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** Runs a gitcore read; a missing object becomes `ObjectNotFound`, anything else a defect. */
const fromGit = <A>(repo: RepoRef, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (e) => e }).pipe(
    Effect.catch((e) => (e instanceof MissingObject ? Effect.fail(new ObjectNotFound({ repo: plain(repo), oid: e.oid })) : Effect.die(e))),
  );

/**
 * Repositories as real git objects (gitcore's codec) plus refs, so reads and
 * diffs behave as they do on a real host. A repo exists only once created or
 * forked: reads of anything else fail `RepoNotFound`, and `delete` removes it.
 * `CodeHostFixture` writes commits, as a push would.
 */
export function makeCodeHostMemory() {
  const repos = new Map<string, MemoryRepo>();
  let scratch = 0;

  const find = (repo: RepoRef) =>
    Effect.suspend(() => {
      const found = repos.get(repoKey(repo));
      return found === undefined ? Effect.fail(new RepoNotFound({ repo: plain(repo) })) : Effect.succeed(found);
    });

  const object = (repo: RepoRef, found: MemoryRepo, oid: string, type: GitObject["type"]) => {
    const o = found.objects.get(oid);
    return o?.type === type ? Effect.succeed(o) : Effect.fail(new ObjectNotFound({ repo: plain(repo), oid }));
  };

  /** gitcore's reader over one repo's objects. */
  const reader = (found: MemoryRepo) => ({
    readTree: (oid: string) => {
      const o = found.objects.get(oid);
      return o?.type === "tree" ? Promise.resolve(decodeTree(o.body)) : Promise.reject(new MissingObject(oid));
    },
  });
  const rootTree = (repo: RepoRef, found: MemoryRepo, commit: string) =>
    Effect.map(object(repo, found, commit, "commit"), (o) => decodeCommit(o.body).tree);

  const list = (found: MemoryRepo, tree: string, prefix: string, out: TreeEntry[]) => {
    const o = found.objects.get(tree);
    if (o === undefined) throw new MissingObject(tree);
    for (const e of decodeTree(o.body)) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      const type = e.mode === MODE_TREE ? "tree" : e.mode === MODE_GITLINK ? "commit" : "blob";
      out.push({ path, mode: e.mode, oid: e.oid, type });
      if (type === "tree") list(found, e.oid, path, out);
    }
    return out;
  };

  const host = CodeHost.of({
    create: (repo) => Effect.sync(() => (repos.set(repoKey(repo), { refs: new Map(), objects: new Map() }), repo)),
    fork: (source, target) =>
      Effect.map(find(source), (from) => {
        repos.set(repoKey(target), { refs: new Map(from.refs), objects: new Map(from.objects) });
        return target;
      }),
    mintToken: (repo, access, ttlSeconds) =>
      Effect.gen(function* () {
        yield* find(repo);
        const now = yield* EffectClock.currentTimeMillis;
        return { token: `memrepo_${access}_${repoKey(repo)}`, access, expiresAt: Instant(now + ttlSeconds * 1000) };
      }),
    head: (repo, ref) =>
      Effect.flatMap(find(repo), (found) => {
        const sha = found.refs.get(ref);
        return sha === undefined ? Effect.fail(new RefNotFound({ repo: plain(repo), ref })) : Effect.succeed(sha);
      }),
    readTree: (repo, commit) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        const tree = yield* rootTree(repo, found, commit);
        return yield* fromGit(repo, () => Promise.resolve().then(() => list(found, tree, "", [])));
      }),
    readBlob: (repo, oid) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        return (yield* object(repo, found, oid, "blob")).body;
      }),
    diffTrees: (repo, base, head) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        const before = yield* rootTree(repo, found, base);
        const after = yield* rootTree(repo, found, head);
        return yield* fromGit(repo, () => diffTrees(reader(found), before, after));
      }),
    delete: (repo) => Effect.sync(() => void repos.delete(repoKey(repo))),
  });

  const fixture = CodeHostFixture.of({
    scratch: () => {
      scratch += 1;
      return { namespace: "memory", name: `scratch-${scratch}` };
    },
    commit: (repo, ref, files) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        const parent = found.refs.get(ref);
        const { tree, objects } = yield* Effect.promise(() => buildTree(files));
        const { oid, object: commit } = yield* Effect.promise(() => buildCommit(tree, parent === undefined ? [] : [parent]));
        for (const [id, o] of objects) found.objects.set(id, o);
        found.objects.set(oid, commit);
        const sha = toCommitSha(oid);
        found.refs.set(ref, sha);
        return sha;
      }),
  });

  return {
    repos,
    fixture,
    layer: Layer.mergeAll(Layer.succeed(CodeHost, host), Layer.succeed(CodeHostFixture, fixture)),
  };
}
