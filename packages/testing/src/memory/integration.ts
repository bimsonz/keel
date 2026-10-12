import {
  CompositionRefused,
  PromotionStateRefused,
  PushRejected,
  UnexpectedHead,
} from "@keeltown/core/domain/integration";
import { type ChangeId, CommitSha, ContentHash, type ProjectId } from "@keeltown/core/kernel";
import {
  BatchVerification,
  BundleRefused,
  CandidateBundles,
  CandidateComposer,
  Lanes,
  PackTooLarge,
  type RepoRef,
  StagingWriter,
  type SyncOutcome,
  TrunkWriter,
  Trunks,
  type VerificationJob,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

const sha1 = async (text: string): Promise<CommitSha> => {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return Schema.decodeUnknownSync(CommitSha)(hex);
};

/**
 * Composes deterministically: each member's commit id is a hash of the base,
 * the batch's time and the members up to it, and the tree a hash of those
 * without the time, so recomposing the same batch gives the same ids.
 * `refuse` lists change ids whose composition is refused, as GitCore refuses
 * when unsure.
 */
export function makeCandidateComposerMemory(options: { readonly refuse?: readonly string[] } = {}) {
  return {
    layer: Layer.succeed(
      CandidateComposer,
      CandidateComposer.of({
        compose: (request) =>
          Effect.gen(function* () {
            const refused = request.members.filter((m) => options.refuse?.includes(m.changeId));
            if (refused.length > 0)
              return yield* new CompositionRefused({ reason: "overlap", paths: [] });
            const commits: { changeId: ChangeId; sha: CommitSha }[] = [];
            let parent: string = request.base;
            for (const m of request.members) {
              const sha = yield* Effect.promise(() =>
                sha1([parent, m.changeId, m.head, m.title, request.at].join("\n")),
              );
              commits.push({ changeId: m.changeId, sha });
              parent = sha;
            }
            const treeSha = yield* Effect.promise(() =>
              sha1([request.base, ...request.members.map((m) => m.head)].join("\n")),
            );
            return {
              treeSha,
              commitSha: commits.at(-1)?.sha ?? request.base,
              commits,
              ref: request.ref ?? `refs/heads/cand/${request.candidateId}`,
              composer: "gitcore" as const,
              tier: 0 as const,
              tierReason: "path-disjoint members",
            };
          }),
      }),
    ),
  };
}

const repoKey = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;

/** The most one relayed pack may weigh, as GitCore's relay caps it. */
const RECEIVE_PACK_CAP_BYTES = 60 * 1024 * 1024;

/**
 * One head. A push from anything but the head is refused, as a fenced writer
 * must refuse it. `sync` copies the head into each target's main, which
 * `synced` reads back (undefined: never synced).
 */
export function makeTrunkWriterMemory(initial: CommitSha) {
  let current = initial;
  let dropping = 0;
  const weights = new Map<CommitSha, number>();
  const targets = new Map<string, CommitSha>();
  const pushes: { readonly from: CommitSha; readonly to: CommitSha }[] = [];
  return {
    head: () => current,
    synced: (repo: RepoRef) => targets.get(repoKey(repo)),
    /** Every push asked for, in order, whatever came of it. */
    pushes: (): readonly { readonly from: CommitSha; readonly to: CommitSha }[] => [...pushes],
    /** Moves trunk behind the writer's back, to exercise the read-back freeze. */
    interfere: (to: CommitSha) => {
      current = to;
    },
    /** The next `n` pushes report success and move nothing: an acknowledgement for a push that was lost. */
    drop: (n: number) => {
      dropping = n;
    },
    /** The pack that carries `to` weighs `bytes`: over the receive-pack cap, its push is PackTooLarge and moves nothing. */
    weigh: (to: CommitSha, bytes: number) => {
      weights.set(to, bytes);
    },
    layer: Layer.succeed(
      TrunkWriter,
      TrunkWriter.of({
        head: Effect.sync(() => current),
        push: (from, to) =>
          Effect.suspend((): Effect.Effect<void, PackTooLarge | UnexpectedHead> => {
            pushes.push({ from, to });
            const bytes = weights.get(to) ?? 0;
            if (bytes > RECEIVE_PACK_CAP_BYTES)
              return Effect.fail(
                new PackTooLarge({
                  repo: { namespace: "memory", name: "trunk" },
                  bytes,
                  limit: RECEIVE_PACK_CAP_BYTES,
                }),
              );
            if (from !== current)
              return Effect.fail(new UnexpectedHead({ expected: from, observed: current }));
            if (dropping > 0) {
              dropping -= 1;
              return Effect.void;
            }
            current = to;
            return Effect.void;
          }),
        sync: (repos) =>
          Effect.sync(() => {
            const outcomes = repos.map((repo): SyncOutcome => {
              if (targets.get(repoKey(repo)) === current) return "unchanged";
              targets.set(repoKey(repo), current);
              return "advanced";
            });
            return { head: current, outcomes };
          }),
      }),
    ),
  };
}

/** Where a memory StagingWriter keeps staging's main: its own cell, or a memory CodeHost's ref. */
export interface MainRef {
  readonly get: () => CommitSha | undefined;
  readonly set: (sha: CommitSha) => void;
}

const cellOf = (initial?: CommitSha): MainRef => {
  let held = initial;
  return {
    get: () => held,
    set: (sha) => {
      held = sha;
    },
  };
};

/**
 * Staging's main, fenced as the GitCore writer fences it: `fastForward`
 * moves it only from `from`; already at `to` is `unchanged`; anywhere else
 * is PushRejected `stale`. `moved` records each advance in order.
 */
export function makeStagingWriterMemory(main: MainRef = cellOf()) {
  const moved: { readonly from: CommitSha; readonly to: CommitSha }[] = [];
  return {
    moved,
    main,
    layer: Layer.succeed(
      StagingWriter,
      StagingWriter.of({
        fastForward: (from, to) =>
          Effect.suspend((): Effect.Effect<SyncOutcome, PushRejected> => {
            const held = main.get();
            if (held === to) return Effect.succeed("unchanged");
            if (held !== from) return Effect.fail(new PushRejected({ reason: "stale" }));
            main.set(to);
            moved.push({ from, to });
            return Effect.succeed("advanced");
          }),
      }),
    ),
  };
}

/**
 * Each project's trunk head once initialized, how often it was synced, and
 * who destroyed it. `journal` records each call in order beside other
 * adapters'; `failSyncOnce` makes the first sync die, as a crash
 * mid-bootstrap would.
 */
export function makeTrunksMemory(
  options: { readonly journal?: string[]; readonly failSyncOnce?: boolean } = {},
) {
  const heads = new Map<ProjectId, CommitSha>();
  const syncs = new Map<ProjectId, number>();
  const destroyed = new Map<ProjectId, string>();
  let failures = options.failSyncOnce === true ? 1 : 0;
  return {
    heads,
    syncs,
    destroyed,
    layer: Layer.succeed(
      Trunks,
      Trunks.of({
        initialize: (projectId, head) =>
          Effect.suspend(() => {
            const held = heads.get(projectId);
            if (held !== undefined && held !== head)
              return Effect.fail(
                new PromotionStateRefused({ projectId, phase: "idle", command: "Initialize" }),
              );
            heads.set(projectId, head);
            options.journal?.push(`initialize ${projectId}`);
            return Effect.void;
          }),
        head: (projectId) =>
          Effect.suspend(() => {
            const head = heads.get(projectId);
            return head === undefined
              ? Effect.die(new Error(`${projectId} has no trunk yet`))
              : Effect.succeed(head);
          }),
        sync: (projectId) =>
          Effect.suspend(() => {
            if (failures > 0) {
              failures -= 1;
              return Effect.die(new Error("the sync crashed"));
            }
            const head = heads.get(projectId);
            if (head === undefined) return Effect.die(new Error(`${projectId} has no trunk yet`));
            syncs.set(projectId, (syncs.get(projectId) ?? 0) + 1);
            options.journal?.push(`sync ${projectId}`);
            return Effect.succeed({ head, staging: head, mirror: head });
          }),
        destroy: (projectId, by) =>
          Effect.sync(() => {
            if (!destroyed.has(projectId)) destroyed.set(projectId, by);
            options.journal?.push(`destroy trunk ${projectId}`);
          }),
      }),
    ),
  };
}

/** Who destroyed each project's lanes. `journal` records each call in order beside other adapters'. */
export function makeLanesMemory(options: { readonly journal?: string[] } = {}) {
  const destroyed = new Map<ProjectId, string>();
  return {
    destroyed,
    layer: Layer.succeed(
      Lanes,
      Lanes.of({
        destroy: (projectId, by) =>
          Effect.sync(() => {
            if (!destroyed.has(projectId)) destroyed.set(projectId, by);
            options.journal?.push(`destroy lanes ${projectId}`);
          }),
      }),
    ),
  };
}

/**
 * Bundles by address only: a commit's bundle is `sha256:` of the staging repo
 * and the commit, so one commit always has one address. `refuse` lists commits
 * whose tree the bundle format cannot carry. `bundled` records each call.
 */
export function makeCandidateBundlesMemory(options: { readonly refuse?: readonly string[] } = {}) {
  const bundled: CommitSha[] = [];
  return {
    bundled,
    layer: Layer.succeed(
      CandidateBundles,
      CandidateBundles.of({
        bundle: (staging, commit) =>
          Effect.gen(function* () {
            bundled.push(commit);
            if (options.refuse?.includes(commit) === true)
              return yield* new BundleRefused({ reason: `symlink in ${commit}` });
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${staging.namespace}/${staging.name} ${commit}`),
              ),
            );
            const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"));
            return Schema.decodeUnknownSync(ContentHash)(`sha256:${hex.join("")}`);
          }),
      }),
    ),
  };
}

/** KeelVerify's starts, by instance id; starting an id again starts nothing new. */
export function makeBatchVerificationMemory() {
  const started = new Map<string, VerificationJob>();
  return {
    started,
    layer: Layer.succeed(
      BatchVerification,
      BatchVerification.of({
        start: (instanceId, job) =>
          Effect.sync(() => {
            if (!started.has(instanceId)) started.set(instanceId, job);
          }),
      }),
    ),
  };
}
