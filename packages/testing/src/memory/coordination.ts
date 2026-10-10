import { PoolExhausted, type SubjectKey } from "@keeltown/core/domain/coordination";
import { type AgentId, type CommitSha, Instant, makeId, type ProjectId, type WorkspaceId } from "@keeltown/core/kernel";
import {
  type AgentNotice,
  CodeHost,
  Notifier,
  Recall,
  type RepoRef,
  SubjectRegistry,
  type SubjectEntry,
  type TreeEntry,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option } from "effect";

const repoKey = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;

/** Repositories as maps of refs, trees and blobs. `seed` writes what a push would have. */
export function makeCodeHostMemory() {
  const repos = new Map<string, { refs: Map<string, CommitSha>; trees: Map<string, TreeEntry[]>; blobs: Map<string, Uint8Array> }>();
  const ensure = (repo: RepoRef) => {
    let entry = repos.get(repoKey(repo));
    if (entry === undefined) {
      entry = { refs: new Map(), trees: new Map(), blobs: new Map() };
      repos.set(repoKey(repo), entry);
    }
    return entry;
  };
  return {
    repos,
    seed: (repo: RepoRef, ref: string, commit: CommitSha, tree: TreeEntry[], blobs: Record<string, Uint8Array> = {}) => {
      const entry = ensure(repo);
      entry.refs.set(ref, commit);
      entry.trees.set(commit, tree);
      for (const [oid, bytes] of Object.entries(blobs)) entry.blobs.set(oid, bytes);
    },
    layer: Layer.succeed(
      CodeHost,
      CodeHost.of({
        create: (repo) => Effect.sync(() => (ensure(repo), repo)),
        fork: (source, target) =>
          Effect.sync(() => {
            const from = ensure(source);
            repos.set(repoKey(target), { refs: new Map(from.refs), trees: new Map(from.trees), blobs: new Map(from.blobs) });
            return target;
          }),
        mintToken: (repo, access, ttlSeconds) =>
          Effect.map(EffectClock.currentTimeMillis, (now) => ({
            token: `memrepo_${access}_${repoKey(repo)}`,
            access,
            expiresAt: Instant(now + ttlSeconds * 1000),
          })),
        head: (repo, ref) =>
          Effect.suspend(() => {
            const sha = ensure(repo).refs.get(ref);
            return sha === undefined ? Effect.die(new Error(`no ref ${ref} in ${repoKey(repo)}`)) : Effect.succeed(sha);
          }),
        readTree: (repo, commit) => Effect.sync(() => ensure(repo).trees.get(commit) ?? []),
        readBlob: (repo, oid) =>
          Effect.suspend(() => {
            const bytes = ensure(repo).blobs.get(oid);
            return bytes === undefined ? Effect.die(new Error(`no blob ${oid}`)) : Effect.succeed(bytes);
          }),
      }),
    ),
  };
}

/** Grants workspaces up to `capacity`, then refuses with PoolExhausted. */
export function makeWorkspacePoolMemory(options: { readonly capacity?: number } = {}) {
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  const granted = new Map<WorkspaceId, string>();
  let counter = 0;
  return {
    granted,
    layer: Layer.succeed(
      WorkspacePool,
      WorkspacePool.of({
        grant: (_projectId, holder) =>
          Effect.gen(function* () {
            if (granted.size >= capacity) return yield* new PoolExhausted({ retryAfterMs: 1000 });
            counter += 1;
            const workspaceId = makeId("wsp", counter.toString().padStart(26, "0"));
            granted.set(workspaceId, holder);
            const now = yield* EffectClock.currentTimeMillis;
            return { workspaceId, remote: `memory://workspaces/${workspaceId}`, token: `memws_${workspaceId}`, expiresAt: Instant(now + 7_200_000) };
          }),
        release: (workspaceId) => Effect.sync(() => void granted.delete(workspaceId)),
      }),
    ),
  };
}

const scoped = (projectId: ProjectId, key: SubjectKey) => `${projectId}/${key}`;

export function makeSubjectRegistryMemory() {
  const subjects = new Map<string, SubjectEntry>();
  let counter = 0;
  return {
    subjects,
    layer: Layer.succeed(
      SubjectRegistry,
      SubjectRegistry.of({
        byKey: (projectId, key) => Effect.sync(() => Option.fromNullishOr(subjects.get(scoped(projectId, key)))),
        byAnchor: (projectId, anchor) =>
          Effect.sync(() =>
            [...subjects.entries()]
              .filter(([k, entry]) => k.startsWith(`${projectId}/`) && entry.anchors.some((a) => a.path === anchor.path && a.symbol === anchor.symbol))
              .map(([, entry]) => entry),
          ),
        mint: (projectId, entry) =>
          Effect.sync(() => {
            counter += 1;
            const minted = { ...entry, id: makeId("sub", counter.toString().padStart(26, "0")) };
            subjects.set(scoped(projectId, entry.key), minted);
            return minted;
          }),
      }),
    ),
  };
}

/** Scores subjects by how many query words their key contains. Routing only, never gating. */
export function makeRecallMemory(registry: ReturnType<typeof makeSubjectRegistryMemory>) {
  return {
    layer: Layer.succeed(
      Recall,
      Recall.of({
        nearest: (projectId, text, k) =>
          Effect.sync(() => {
            const words = text.toLowerCase().split(/\W+/).filter(Boolean);
            return [...registry.subjects.entries()]
              .filter(([key]) => key.startsWith(`${projectId}/`))
              .map(([, entry]) => ({ subjectId: entry.id, score: words.filter((w) => entry.key.includes(w)).length }))
              .filter((hit) => hit.score > 0)
              .toSorted((a, b) => b.score - a.score)
              .slice(0, k);
          }),
      }),
    ),
  };
}

export function makeNotifierMemory() {
  const delivered: { readonly agentId: AgentId; readonly notice: AgentNotice }[] = [];
  return {
    delivered,
    layer: Layer.succeed(Notifier, Notifier.of({ notify: (agentId, notice) => Effect.sync(() => void delivered.push({ agentId, notice })) })),
  };
}
