import { projectRepos } from "@keeltown/core/application/integration";
import { PushRejected } from "@keeltown/core/domain/integration";
import { CommitSha, Instant, type ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  type CommitInfo,
  type Imported,
  ImportRefused,
  KEEL_TRUNK_REF,
  ObjectNotFound,
  PathNotFound,
  RefNotFound,
  RepoAlreadyExists,
  RepoNotFound,
  type RepoRef,
  RepoServer,
  type SyncOutcome,
  type TreeEntry,
  UPLOAD_PACK_ANSWER_TYPE,
  type UploadPackAnswer,
  type UploadPackRequest,
  WorkspaceRebaser,
  WorkspaceRefresher,
  EditsRefused,
  WORKSPACE_BRANCH,
  WorkspaceHeadMoved,
  WorkspaceWriter,
} from "@keeltown/core/ports";
import {
  applyEdits,
  compareTreeEntries,
  concat,
  EditRefused,
  encodeCommit,
  hashObject,
  dec,
  decodeCommit,
  decodeTree,
  diffTrees,
  FLUSH,
  type GitObject,
  isAncestor,
  MissingObject,
  mainOnly,
  MODE_GITLINK,
  MODE_TREE,
  pkt,
  readPkts,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { Clock as EffectClock, Effect, Layer, Schema } from "effect";
import {
  buildCommit,
  buildTree,
  CodeHostFixture,
  type UpstreamBranch,
  type Upstreams,
} from "../code-host-fixture.ts";

interface MemoryRepo {
  readonly refs: Map<string, CommitSha>;
  readonly objects: Map<string, GitObject>;
  /** The branch the repo's own HEAD names, by full ref name: main unless an import brought another. */
  readonly head?: string;
}

/** What answers at a URL the memory host is asked to import from: a repository, or a refusal. */
type MemoryUpstream =
  | {
      readonly byDefault: string;
      readonly branches: ReadonlyMap<string, CommitSha>;
      readonly objects: ReadonlyMap<string, GitObject>;
    }
  | { readonly refuses: ImportRefused["reason"] };

const BRANCH = "refs/heads/";
const upstreamBranch = (name: string, commit: CommitSha): UpstreamBranch => ({
  name,
  ref: `${BRANCH}${name}`,
  commit,
});
/** The memory host's upstreams: a repository of two branches and a page that is not git; any other URL holds nothing. */
const UPSTREAM_URL = "https://git.memory.test/upstream/repo";
const NOT_GIT_URL = "https://git.memory.test/not/git";
const MISSING_URL = "https://git.memory.test/upstream/none";

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
  const upstreams = new Map<string, MemoryUpstream>([[NOT_GIT_URL, { refuses: "not-git" }]]);
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
        repos.set(repoKey(target), {
          refs: new Map(from.refs),
          objects: new Map(from.objects),
          ...(from.head === undefined ? {} : { head: from.head }),
        });
        return Effect.succeed(target);
      }),
    import: (source, target) =>
      Effect.suspend((): Effect.Effect<Imported, RepoAlreadyExists | ImportRefused> => {
        if (repos.has(repoKey(target))) return Effect.fail(alreadyExists(target));
        const upstream = upstreams.get(source.url) ?? { refuses: "not-found" as const };
        if ("refuses" in upstream)
          return Effect.fail(new ImportRefused({ reason: upstream.refuses }));
        // One branch comes, under its own name: the one named, or the upstream's default.
        const branch = source.ref ?? upstream.byDefault;
        const commit = upstream.branches.get(branch);
        if (commit === undefined) return Effect.fail(new ImportRefused({ reason: "no-branch" }));
        const ref = `${BRANCH}${branch}`;
        // As on the real host, the new repo's HEAD names the branch that came.
        repos.set(repoKey(target), {
          refs: new Map([[ref, commit]]),
          objects: new Map(upstream.objects),
          head: ref,
        });
        return Effect.succeed({ ref, commit });
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
    branches: (repo) =>
      Effect.map(find(repo), (found) =>
        [...found.refs]
          .filter(([ref]) => ref.startsWith(BRANCH))
          .map(([ref, commit]) => ({ ref, commit }))
          .toSorted((a, b) => (a.ref < b.ref ? -1 : 1)),
      ),
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
    upstreams: Effect.promise(async (): Promise<Upstreams> => {
      const objects = new Map<string, GitObject>();
      const commit = async (file: string, parents: readonly string[]) => {
        const built = await buildTree({ "README.md": file });
        const made = await buildCommit(built.tree, parents);
        for (const [id, o] of built.objects) objects.set(id, o);
        objects.set(made.oid, made.object);
        return toCommitSha(made.oid);
      };
      const first = await commit("upstream\n", []);
      const next = await commit("upstream, next\n", [first]);
      upstreams.set(UPSTREAM_URL, {
        byDefault: "trunk",
        branches: new Map([
          ["trunk", first],
          ["next", next],
        ]),
        objects,
      });
      return {
        url: UPSTREAM_URL,
        byDefault: upstreamBranch("trunk", first),
        other: upstreamBranch("next", next),
        missing: MISSING_URL,
        notGit: NOT_GIT_URL,
      };
    }),
  });

  return {
    repos,
    upstreams,
    fixture,
    /**
     * What a relay of `source`'s main into `target` leaves there: the
     * source's objects, and main at the source's. Answers that commit, or
     * nothing (and does nothing) when the host holds no such source, no main
     * in it, or no such target.
     */
    relayMain: (source: RepoRef, target: RepoRef): CommitSha | undefined => {
      const from = repos.get(repoKey(source));
      const to = repos.get(repoKey(target));
      const head = from?.refs.get("refs/heads/main");
      if (from === undefined || to === undefined || head === undefined) return undefined;
      for (const [oid, held] of from.objects) to.objects.set(oid, held);
      to.refs.set("refs/heads/main", head);
      return head;
    },
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

/** gitcore's object reads over a memory repo: a missing object, or one of another type, is MissingObject. */
const memoryReader = (repo: MemoryRepo) => {
  const object = (oid: string, type: GitObject["type"]) => {
    const o = repo.objects.get(oid);
    if (o?.type !== type) throw new MissingObject(oid);
    return o.body;
  };
  return {
    readTree: (oid: string) => Promise.resolve(decodeTree(object(oid, "tree"))),
    readBlob: (oid: string) => Promise.resolve(object(oid, "blob")),
    readCommit: (oid: string) => Promise.resolve(decodeCommit(object(oid, "commit"))),
  };
};

/** A promise, and what settles it from outside. */
function settleable(): { readonly promise: Promise<void>; readonly settle: () => void } {
  const settlers: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settlers.push(resolve);
  });
  return {
    promise,
    settle: () => {
      for (const settle of settlers) settle();
    },
  };
}

/**
 * WorkspaceWriter over a memory code host: the edits are applied to the
 * parent's tree with gitcore, as the real writer does, and the workspace's
 * main moves only if it is at `expectedHead`. A main elsewhere is
 * WorkspaceHeadMoved, unless it already holds this commit's tree on this
 * parent (a retry). `committed` records each commit in order. `holdNext`
 * holds the next commit after main moves and before it answers, as a slow
 * push holds its caller: `held` settles once it is held, `release` lets it go.
 */
export function makeWorkspaceWriterMemory(
  code: Pick<ReturnType<typeof makeCodeHostMemory>, "repos">,
) {
  const committed: { readonly workspace: RepoRef; readonly commit: CommitSha }[] = [];
  let hold: { readonly reached: () => void; readonly released: Promise<void> } | undefined;
  return {
    committed,
    holdNext: () => {
      const held = settleable();
      const released = settleable();
      hold = { reached: held.settle, released: released.promise };
      return { held: held.promise, release: released.settle };
    },
    layer: Layer.succeed(
      WorkspaceWriter,
      WorkspaceWriter.of({
        commit: (workspace, request) =>
          Effect.gen(function* () {
            const target = code.repos.get(repoKey(workspace));
            if (target === undefined)
              return yield* Effect.fail(new RepoNotFound({ repo: plain(workspace) }));
            const read = memoryReader(target);
            const edited = yield* Effect.tryPromise({
              try: async () => {
                const parent = await read.readCommit(request.parent);
                return applyEdits(read, parent.tree, request.edits);
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, EditsRefused | ObjectNotFound> =>
                cause instanceof EditRefused
                  ? Effect.fail(new EditsRefused({ reason: cause.reason, path: cause.path }))
                  : cause instanceof MissingObject
                    ? Effect.fail(new ObjectNotFound({ repo: plain(workspace), oid: cause.oid }))
                    : Effect.die(cause),
              ),
            );
            if (edited.changed === 0)
              return yield* Effect.fail(new EditsRefused({ reason: "nothing-changed", path: "" }));
            const author = {
              name: request.author.handle ?? request.author.agentId,
              email: `${request.author.agentId}@agents.memory`,
              time: Math.floor(request.at / 1000),
            };
            const body = encodeCommit({
              tree: edited.tree,
              parents: [request.parent],
              author,
              committer: { name: "Keel", email: "keel@memory", time: author.time },
              message: request.message,
            });
            const sha = CommitSha.make(yield* Effect.promise(() => hashObject("commit", body)));
            const answer = { commitSha: sha, tree: edited.tree, changed: edited.changed };
            const head = target.refs.get(WORKSPACE_BRANCH) ?? null;
            if (head !== request.expectedHead) {
              const at = head === null ? undefined : target.objects.get(head);
              const same =
                at?.type === "commit" &&
                decodeCommit(at.body).tree === edited.tree &&
                decodeCommit(at.body).parents.join(",") === request.parent;
              if (same && head !== null) return { ...answer, commitSha: head };
              return yield* Effect.fail(
                new WorkspaceHeadMoved({ expected: request.expectedHead, head }),
              );
            }
            for (const [oid, o] of edited.newObjects) target.objects.set(oid, o);
            target.objects.set(sha, { type: "commit", body });
            target.refs.set(WORKSPACE_BRANCH, sha);
            committed.push({ workspace, commit: sha });
            const holding = hold;
            hold = undefined;
            if (holding !== undefined) {
              holding.reached();
              yield* Effect.promise(() => holding.released);
            }
            return answer;
          }),
      }),
    ),
  };
}

/**
 * WorkspaceRefresher over a memory code host: the project's trunk objects are
 * copied into the workspace and its main moved to `to`, as the relay would
 * leave it. A main that is not at `from` refuses with PushRejected `stale`
 * and nothing moves; `from` equal to `to` is `unchanged`; a missing workspace
 * is `RepoNotFound`. `advanced` records each move in order.
 */
/** Whether `tip`'s history in `repo` holds `ancestor`. */
function reaches(repo: MemoryRepo, tip: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const found = repo.objects.get(id);
    if (found?.type === "commit") stack.push(...decodeCommit(found.body).parents);
  }
  return false;
}

export function makeWorkspaceRefresherMemory(
  code: Pick<ReturnType<typeof makeCodeHostMemory>, "repos">,
  trunkOf: (projectId: ProjectId) => RepoRef = (projectId) => projectRepos(projectId).trunk,
) {
  const advanced: {
    readonly workspace: RepoRef;
    readonly from: CommitSha;
    readonly to: CommitSha;
  }[] = [];
  return {
    advanced,
    layer: Layer.succeed(
      WorkspaceRefresher,
      WorkspaceRefresher.of({
        advance: (projectId, workspace, from, to) =>
          Effect.suspend((): Effect.Effect<SyncOutcome, RepoNotFound | PushRejected> => {
            if (from === to) return Effect.succeed("unchanged");
            const target = code.repos.get(repoKey(workspace));
            if (target === undefined)
              return Effect.fail(new RepoNotFound({ repo: plain(workspace) }));
            if (target.refs.get(MAIN) !== from)
              return Effect.fail(new PushRejected({ reason: "stale" }));
            // Behind where main is: a workspace is only ever moved forward.
            if (reaches(target, from, to))
              return Effect.fail(new PushRejected({ reason: "stale" }));
            const trunk = trunkOf(projectId);
            const source = code.repos.get(repoKey(trunk));
            if (source?.objects.get(to)?.type !== "commit")
              return Effect.die(new Error(`trunk ${repoKey(trunk)} does not hold ${to}`));
            for (const [id, o] of source.objects) target.objects.set(id, o);
            target.refs.set(MAIN, to);
            advanced.push({ workspace, from, to });
            return Effect.succeed("advanced");
          }),
      }),
    ),
  };
}

const MAIN = "refs/heads/main";
const UPLOAD_PACK_CAPS = "side-band-64k ofs-delta no-progress agent=keel-memory";
/** The most pack bytes one side-band-64k packet carries after its band byte. */
const BAND_BYTES = 65_515;

/** Every object reachable from `wants` that the repo holds: what a fetch of them with no haves sends. */
function reachable(found: MemoryRepo, wants: readonly string[]): GitObject[] {
  const seen = new Set<string>();
  const out: GitObject[] = [];
  const stack = [...wants];
  for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = found.objects.get(oid);
    if (o === undefined) continue;
    out.push(o);
    if (o.type === "commit") {
      const commit = decodeCommit(o.body);
      stack.push(commit.tree, ...commit.parents);
    } else if (o.type === "tree") {
      for (const e of decodeTree(o.body)) if (e.mode !== MODE_GITLINK) stack.push(e.oid);
    }
  }
  return out;
}

/** A pack in band 1 of a side-band-64k stream, then the flush that ends it. */
function banded(pack: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < pack.length; at += BAND_BYTES)
    out.push(pkt(concat([Uint8Array.of(1), pack.subarray(at, at + BAND_BYTES)])));
  out.push(FLUSH);
  return out;
}

/** A repo's refs as its host lists them: HEAD first, at the branch it names when that branch exists, then each ref by name. */
function listedRefs(found: MemoryRepo): (readonly [sha: string, ref: string])[] {
  const head = found.refs.get(found.head ?? MAIN);
  return [
    ...(head === undefined ? [] : [[head, "HEAD"] as const]),
    ...[...found.refs]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ref, sha]) => [sha, ref] as const),
  ];
}

/** One upload-pack answer over a memory repo as its host gives it, every ref listed, in protocol v0 or (for `version=2`) v2. */
async function uploadPackAnswer(found: MemoryRepo, request: UploadPackRequest) {
  const refs = listedRefs(found);
  const target = found.head ?? MAIN;
  const lines = [...readPkts(request.body ?? new Uint8Array())].flatMap((line) =>
    line === null ? [] : [dec.decode(line).replace(/\n$/, "")],
  );
  const wants = lines.filter((l) => l.startsWith("want ")).map((l) => l.slice(5, 45));
  const packed = async () => await writePack(reachable(found, wants));

  if (request.protocol === "version=2") {
    if (request.service === "advertise")
      return concat([
        pkt("version 2\n"),
        pkt("agent=keel-memory\n"),
        pkt("ls-refs\n"),
        pkt("fetch\n"),
        FLUSH,
      ]);
    const command = lines.find((l) => l.startsWith("command="))?.slice("command=".length);
    if (command === "ls-refs") {
      const prefixes = lines
        .filter((l) => l.startsWith("ref-prefix "))
        .map((l) => l.slice("ref-prefix ".length));
      const symrefs = lines.includes("symrefs");
      return concat([
        ...refs
          .filter(([, ref]) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p)))
          .map(([sha, ref]) =>
            pkt(`${sha} ${ref}${symrefs && ref === "HEAD" ? ` symref-target:${target}` : ""}\n`),
          ),
        FLUSH,
      ]);
    }
    if (command !== "fetch") return pkt(`ERR unknown command ${command ?? ""}\n`);
    if (!lines.includes("done")) return concat([pkt("acknowledgments\n"), pkt("NAK\n"), FLUSH]);
    return concat([pkt("packfile\n"), ...banded(await packed())]);
  }

  if (request.service === "advertise") {
    const caps = `${UPLOAD_PACK_CAPS}${refs[0]?.[1] === "HEAD" ? ` symref=HEAD:${target}` : ""}`;
    return concat([
      pkt("# service=git-upload-pack\n"),
      FLUSH,
      ...(refs.length === 0
        ? [pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`)]
        : refs.map(([sha, ref], i) =>
            pkt(i === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`),
          )),
      FLUSH,
    ]);
  }
  if (!lines.includes("done")) return pkt("NAK\n");
  const pack = await packed();
  const sideband = lines.some((l) => l.startsWith("want ") && l.includes("side-band-64k"));
  return concat([pkt("NAK\n"), ...(sideband ? banded(pack) : [pack])]);
}

/**
 * RepoServer over a memory code host: a small upload-pack that lists the
 * repo's refs as its host would, shown to the client as main alone (gitcore's
 * `mainOnly`, as the real adapter applies it), and answers a fetch with every
 * object reachable from its wants (haves are ignored, which is valid and
 * never thin), in protocol v0 and v2. `served` records each request in order.
 */
export function makeRepoServerMemory(code: Pick<ReturnType<typeof makeCodeHostMemory>, "repos">) {
  const served: {
    readonly repo: RepoRef;
    readonly service: UploadPackRequest["service"];
    readonly protocol: string | null;
  }[] = [];
  return {
    served,
    layer: Layer.succeed(
      RepoServer,
      RepoServer.of({
        uploadPack: (repo, request) =>
          Effect.suspend(() => {
            const found = code.repos.get(repoKey(repo));
            if (found === undefined) return Effect.fail(new RepoNotFound({ repo: plain(repo) }));
            served.push({
              repo: plain(repo),
              service: request.service,
              protocol: request.protocol,
            });
            return Effect.promise(async (): Promise<UploadPackAnswer> => {
              const { request: asked, rewrite } = mainOnly(request);
              const answer = await uploadPackAnswer(found, asked);
              const bytes = rewrite === null ? answer : rewrite(answer);
              if (bytes === null) return { status: 502, contentType: "text/plain", body: null };
              return {
                status: 200,
                contentType: UPLOAD_PACK_ANSWER_TYPE[request.service],
                body: (async function* () {
                  yield bytes;
                })(),
              };
            });
          }),
      }),
    ),
  };
}
