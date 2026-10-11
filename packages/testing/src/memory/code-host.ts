import { projectRepos } from "@keeltown/core/application/integration";
import { CommitSha, Instant, type ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  type CommitInfo,
  KEEL_TRUNK_REF,
  ObjectNotFound,
  PathNotFound,
  RefNotFound,
  RepoAlreadyExists,
  RepoNotFound,
  type RepoRef,
  type SyncOutcome,
  type TreeEntry,
  WorkspaceRebaser,
} from "@keeltown/core/ports";
import {
  compareTreeEntries,
  decodeCommit,
  decodeTree,
  diffTrees,
  type GitObject,
  isAncestor,
  MissingObject,
  MODE_GITLINK,
  MODE_TREE,
} from "@keeltown/gitcore";
import { Clock as EffectClock, Effect, Layer, Schema } from "effect";
import { buildCommit, buildTree, CodeHostFixture } from "../code-host-fixture.ts";

interface MemoryRepo {
  readonly refs: Map<string, CommitSha>;
  readonly objects: Map<string, GitObject>;
}

const repoKey = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;
const plain = (repo: RepoRef) => ({ namespace: repo.namespace, name: repo.name });
const alreadyExists = (repo: RepoRef) => new RepoAlreadyExists({ repo: plain(repo) });
const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** `Name <email> <unix seconds> <offset>` from a commit header line, as the identity it names. */
function identity(line: string | undefined) {
  const m = /^(.*) <([^<>]*)> (\d+) [+-]\d{4}$/.exec(line ?? "");
  if (m === null) throw new Error(`bad commit identity: ${line}`);
  return { name: m[1] ?? "", email: m[2] ?? "", at: Instant(Number(m[3]) * 1000) };
}

/** A commit object decoded as a host reports it: the message loses one trailing newline. */
function commitInfo(sha: string, body: Uint8Array): CommitInfo {
  const { tree, parents } = decodeCommit(body);
  const text = new TextDecoder().decode(body);
  const split = text.indexOf("\n\n");
  const header = (split < 0 ? text : text.slice(0, split)).split("\n");
  const field = (name: string) =>
    header.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1);
  const message = split < 0 ? "" : text.slice(split + 2);
  return {
    sha: toCommitSha(sha),
    tree,
    parents: parents.map((p) => toCommitSha(p)),
    message: message.endsWith("\n") ? message.slice(0, -1) : message,
    author: identity(field("author")),
    committer: identity(field("committer")),
  };
}

/** Runs a gitcore read; a missing object becomes `ObjectNotFound`, anything else a defect. */
const fromGit = <A>(repo: RepoRef, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (e) => e }).pipe(
    Effect.catch((e) =>
      e instanceof MissingObject
        ? Effect.fail(new ObjectNotFound({ repo: plain(repo), oid: e.oid }))
        : Effect.die(e),
    ),
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
  let tokens = 0;

  const find = (repo: RepoRef) =>
    Effect.suspend(() => {
      const found = repos.get(repoKey(repo));
      return found === undefined
        ? Effect.fail(new RepoNotFound({ repo: plain(repo) }))
        : Effect.succeed(found);
    });

  const object = (repo: RepoRef, found: MemoryRepo, oid: string, type: GitObject["type"]) => {
    const o = found.objects.get(oid);
    return o?.type === type
      ? Effect.succeed(o)
      : Effect.fail(new ObjectNotFound({ repo: plain(repo), oid }));
  };

  /** gitcore's reader over one repo's objects. */
  const reader = (found: MemoryRepo) => ({
    readTree: (oid: string) => {
      const o = found.objects.get(oid);
      return o?.type === "tree"
        ? Promise.resolve(decodeTree(o.body))
        : Promise.reject(new MissingObject(oid));
    },
    readCommit: (oid: string) => {
      const o = found.objects.get(oid);
      return o?.type === "commit"
        ? Promise.resolve(decodeCommit(o.body))
        : Promise.reject(new MissingObject(oid));
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
    create: (repo) =>
      Effect.suspend(() => {
        if (repos.has(repoKey(repo))) return Effect.fail(alreadyExists(repo));
        repos.set(repoKey(repo), { refs: new Map(), objects: new Map() });
        return Effect.succeed(repo);
      }),
    fork: (source, target) =>
      Effect.flatMap(find(source), (from) => {
        if (repos.has(repoKey(target))) return Effect.fail(alreadyExists(target));
        repos.set(repoKey(target), { refs: new Map(from.refs), objects: new Map(from.objects) });
        return Effect.succeed(target);
      }),
    mintToken: (repo, access, ttlSeconds) =>
      Effect.gen(function* () {
        yield* find(repo);
        const now = yield* EffectClock.currentTimeMillis;
        return {
          token: `memrepo_${access}_${repoKey(repo)}_${(tokens += 1)}`,
          access,
          expiresAt: Instant(now + ttlSeconds * 1000),
        };
      }),
    info: (repo) =>
      Effect.map(find(repo), () => ({
        remote: `memory://${repoKey(repo)}.git`,
        defaultBranch: "main",
      })),
    head: (repo, ref) =>
      Effect.flatMap(find(repo), (found) => {
        const sha = found.refs.get(ref);
        return sha === undefined
          ? Effect.fail(new RefNotFound({ repo: plain(repo), ref }))
          : Effect.succeed(sha);
      }),
    hasCommit: (repo, sha) =>
      Effect.map(find(repo), (found) => found.objects.get(sha)?.type === "commit"),
    isAncestor: (repo, ancestor, descendant, stopAt) =>
      Effect.flatMap(find(repo), (found) =>
        fromGit(repo, () => isAncestor(reader(found), ancestor, descendant, { stopAt })),
      ),
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
    listDir: (repo, commit, path) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        let tree = yield* rootTree(repo, found, commit);
        const missing = new PathNotFound({ repo: plain(repo), commit, path });
        for (const name of path === "" ? [] : path.split("/")) {
          const entry = decodeTree((yield* object(repo, found, tree, "tree")).body).find(
            (e) => e.name === name,
          );
          if (entry?.mode !== MODE_TREE) return yield* Effect.fail(missing);
          tree = entry.oid;
        }
        const entries = decodeTree((yield* object(repo, found, tree, "tree")).body);
        return entries.toSorted(compareTreeEntries).map((e): TreeEntry => {
          const type = e.mode === MODE_TREE ? "tree" : e.mode === MODE_GITLINK ? "commit" : "blob";
          return {
            path: path === "" ? e.name : `${path}/${e.name}`,
            mode: e.mode,
            oid: e.oid,
            type,
          };
        });
      }),
    readCommit: (repo, sha) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        return commitInfo(sha, (yield* object(repo, found, sha, "commit")).body);
      }),
    log: (repo, from, limit) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        const out: CommitInfo[] = [];
        let next: string | undefined = from;
        while (next !== undefined && out.length < limit) {
          const commit = commitInfo(next, (yield* object(repo, found, next, "commit")).body);
          out.push(commit);
          next = commit.parents[0];
        }
        return out;
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
    commit: (repo, ref, files, merged = []) =>
      Effect.gen(function* () {
        const found = yield* find(repo);
        const parent = found.refs.get(ref);
        const { tree, objects } = yield* Effect.promise(() => buildTree(files));
        const { oid, object: commit } = yield* Effect.promise(() =>
          buildCommit(tree, [...(parent === undefined ? [] : [parent]), ...merged]),
        );
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

/**
 * WorkspaceRebaser over a memory code host: the project's trunk objects (its
 * trunk found by `trunkOf`, `projectRepos` by default) are copied into
 * the workspace and its `keel/trunk` moved to the head, as the relay would
 * leave it. A ref already at the head is `unchanged`; a missing workspace is
 * `RepoNotFound`. `pushed` records each move in order.
 */
export function makeWorkspaceRebaserMemory(
  code: Pick<ReturnType<typeof makeCodeHostMemory>, "repos">,
  trunkOf: (projectId: ProjectId) => RepoRef = (projectId) => projectRepos(projectId).trunk,
) {
  const pushed: { readonly workspace: RepoRef; readonly to: CommitSha }[] = [];
  return {
    pushed,
    layer: Layer.succeed(
      WorkspaceRebaser,
      WorkspaceRebaser.of({
        pushTrunk: (projectId, workspace, _base, head) =>
          Effect.suspend((): Effect.Effect<SyncOutcome, RepoNotFound> => {
            const target = code.repos.get(repoKey(workspace));
            if (target === undefined)
              return Effect.fail(new RepoNotFound({ repo: plain(workspace) }));
            if (target.refs.get(KEEL_TRUNK_REF) === head) return Effect.succeed("unchanged");
            const trunk = trunkOf(projectId);
            const source = code.repos.get(repoKey(trunk));
            if (source?.objects.get(head)?.type !== "commit")
              return Effect.die(new Error(`trunk ${repoKey(trunk)} does not hold ${head}`));
            for (const [id, o] of source.objects) target.objects.set(id, o);
            target.refs.set(KEEL_TRUNK_REF, head);
            pushed.push({ workspace, to: head });
            return Effect.succeed("advanced");
          }),
      }),
    ),
  };
}
