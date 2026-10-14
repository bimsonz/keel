import { mainLane, projectRepos } from "@keeltown/core/application/integration";
import {
  CompositionRefused,
  type PromotionState,
  PromotionStateRefused,
  PushRejected,
  type TrunkOrigin,
  UnexpectedHead,
} from "@keeltown/core/domain/integration";
import type { QuotaExceeded } from "@keeltown/core/domain/identity";
import {
  type ChangeId,
  CommitSha,
  ContentHash,
  type NamespaceId,
  type ProjectId,
  Instant,
} from "@keeltown/core/kernel";
import {
  BatchVerification,
  BundleRefused,
  CandidateBundles,
  ImportTooLarge,
  CandidateComposer,
  type CandidateRequest,
  Lanes,
  PackTooLarge,
  RELAY_PACK_CAP_BYTES,
  RepoNotFound,
  type RepoRef,
  StagingWriter,
  type SyncOutcome,
  type TakenTrunk,
  TrunkWriter,
  Trunks,
  type InstanceStanding,
  type VerificationJob,
} from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

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
 * when unsure, for `reason` (`overlap` unless given), with `detail` when given.
 */
export function makeCandidateComposerMemory(
  options: {
    readonly refuse?: readonly string[];
    readonly reason?: string;
    readonly detail?: string;
  } = {},
) {
  /** Every request composed or refused, in order: what a lane named for each member. */
  const requests: CandidateRequest[] = [];
  return {
    requests,
    layer: Layer.succeed(
      CandidateComposer,
      CandidateComposer.of({
        compose: (request) =>
          Effect.gen(function* () {
            requests.push(request);
            const refused = request.members.filter((m) => options.refuse?.includes(m.changeId));
            if (refused.length > 0)
              return yield* new CompositionRefused({
                reason: options.reason ?? "overlap",
                paths: [],
                ...(options.detail === undefined ? {} : { detail: options.detail }),
              });
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

/** The most one relayed pack may weigh, as the port says it. */
const RECEIVE_PACK_CAP_BYTES = RELAY_PACK_CAP_BYTES;

/** A pack of no objects: its 12-byte header and 20-byte trailer. A candidate nobody weighed adds nothing to trunk. */
const EMPTY_PACK_BYTES = 32;

const overTheCap = (bytes: number) =>
  new PackTooLarge({
    repo: { namespace: "memory", name: "trunk" },
    bytes,
    limit: RECEIVE_PACK_CAP_BYTES,
  });

/** The commit a memory TrunkWriter answers as an empty trunk's first, whatever the name and the time. */
export const MEMORY_SEED = Schema.decodeUnknownSync(CommitSha)("5eed".repeat(10));

/**
 * One head. A push from anything but the head is refused, as a fenced writer
 * must refuse it. `adopt`, `seed` and `take` set the head and are recorded. `sync` copies the head into each target's main, which
 * `synced` reads back (undefined: never synced).
 */
export function makeTrunkWriterMemory(initial: CommitSha) {
  let current = initial;
  const adopted: CommitSha[] = [];
  const seeds: { readonly name: string; readonly at: Instant }[] = [];
  const sources = new Map<string, { readonly commit: CommitSha; readonly bytes: number }>();
  const taken: RepoRef[] = [];
  let dropping = 0;
  const weights = new Map<CommitSha, number>();
  const histories = new Map<CommitSha, number>();
  const historiesWeighed: CommitSha[] = [];
  const weighed: { readonly from: CommitSha; readonly to: CommitSha }[] = [];
  const targets = new Map<string, CommitSha>();
  const pushes: { readonly from: CommitSha; readonly to: CommitSha }[] = [];
  return {
    head: () => current,
    /** Every commit trunk's main was made at with `adopt`, in order. */
    adopted: (): readonly CommitSha[] => [...adopted],
    /** Every first commit asked for with `seed`, in order; each answered `MEMORY_SEED`. */
    seeds: (): readonly { readonly name: string; readonly at: Instant }[] => [...seeds],
    /**
     * `source` is a repo whose main is at `commit` and whose whole history
     * weighs `bytes` (an empty pack's 32 when not said): what `take` relays
     * from it, and answers. Over the receive-pack cap the take is PackTooLarge
     * and moves nothing; a source never offered is RepoNotFound. A take after
     * one that took is a retry: it answers trunk's head and sends nothing.
     */
    offers: (source: RepoRef, commit: CommitSha, bytes: number = EMPTY_PACK_BYTES) => {
      sources.set(repoKey(source), { commit, bytes });
    },
    /** Every source whose history `take` brought in, in order. */
    taken: (): readonly RepoRef[] => [...taken],
    synced: (repo: RepoRef) => targets.get(repoKey(repo)),
    /** Every push that was sent (its pack under the cap and admitted), in order, whatever came of it. */
    pushes: (): readonly { readonly from: CommitSha; readonly to: CommitSha }[] => [...pushes],
    /** Moves trunk behind the writer's back, to exercise the read-back freeze. */
    interfere: (to: CommitSha) => {
      current = to;
    },
    /** The next `n` pushes report success and move nothing: an acknowledgement for a push that was lost. */
    drop: (n: number) => {
      dropping = n;
    },
    /**
     * The pack that carries `to` weighs `bytes`, which is what `packBytes`
     * answers for it and what a push gives its `admit` (an empty pack's 32
     * when never weighed): over the receive-pack cap, weighing it and pushing
     * it are PackTooLarge, and the push moves nothing.
     */
    weigh: (to: CommitSha, bytes: number) => {
      weights.set(to, bytes);
    },
    /** Every pack weighed apart with `packBytes`, in order: a push weighs its own and is not here. */
    weighed: (): readonly { readonly from: CommitSha; readonly to: CommitSha }[] => [...weighed],
    /** Every commit whose whole history was weighed with `historyBytes`, in order. */
    historiesWeighed: (): readonly CommitSha[] => [...historiesWeighed],
    /** Trunk's whole history at `at` weighs `bytes`, which is what `historyBytes` answers for it (an empty pack's 32 otherwise). */
    holds: (at: CommitSha, bytes: number) => {
      histories.set(at, bytes);
    },
    layer: Layer.succeed(
      TrunkWriter,
      TrunkWriter.of({
        head: Effect.sync(() => current),
        adopt: (commit) =>
          Effect.sync(() => {
            adopted.push(commit);
            current = commit;
          }),
        seed: (name, at) =>
          Effect.sync(() => {
            seeds.push({ name, at });
            current = MEMORY_SEED;
            return MEMORY_SEED;
          }),
        take: (source) =>
          Effect.suspend((): Effect.Effect<TakenTrunk, RepoNotFound | PackTooLarge> => {
            if (taken.length > 0) return Effect.succeed({ head: current });
            const offered = sources.get(repoKey(source));
            if (offered === undefined) return Effect.fail(new RepoNotFound({ repo: source }));
            if (offered.bytes > RECEIVE_PACK_CAP_BYTES)
              return Effect.fail(overTheCap(offered.bytes));
            taken.push(source);
            current = offered.commit;
            return Effect.succeed({ head: offered.commit, bytes: offered.bytes });
          }),
        push: (from, to, admit) =>
          Effect.gen(function* () {
            const bytes = weights.get(to) ?? EMPTY_PACK_BYTES;
            if (bytes > RECEIVE_PACK_CAP_BYTES) return yield* Effect.fail(overTheCap(bytes));
            yield* admit(bytes);
            pushes.push({ from, to });
            if (from !== current)
              return yield* Effect.fail(new UnexpectedHead({ expected: from, observed: current }));
            if (dropping > 0) dropping -= 1;
            else current = to;
            return undefined;
          }),
        historyBytes: (at) =>
          Effect.sync(() => {
            historiesWeighed.push(at);
            return histories.get(at) ?? EMPTY_PACK_BYTES;
          }),
        packBytes: (from, to) =>
          Effect.suspend((): Effect.Effect<number, PackTooLarge> => {
            weighed.push({ from, to });
            const bytes = weights.get(to) ?? EMPTY_PACK_BYTES;
            return bytes > RECEIVE_PACK_CAP_BYTES
              ? Effect.fail(overTheCap(bytes))
              : Effect.succeed(bytes);
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

/** A first write asked of a trunk that has its head: the caller's defect, as it is the Trunk's own. */
const afterItsHead = (projectId: ProjectId, write: string) =>
  Effect.die(new Error(`trunk ${projectId} is initialized: ${write} is a first write`));

/**
 * Each project's trunk head once initialized, how often it was synced, and
 * who destroyed it. `journal` records each call in order beside other
 * adapters'; `failSyncOnce` makes the first sync die, as a crash
 * mid-bootstrap would. A trunk is shown idle and moved when it was
 * initialized, until `advance` or `stand` says otherwise. A `take` answers
 * the head the source's trunk has here; given a memory code host as `host`
 * it relays there as the real writer does instead, and answers the main the
 * source's repo holds.
 */
export function makeTrunksMemory(
  options: {
    readonly journal?: string[];
    readonly failSyncOnce?: boolean;
    readonly host?: {
      readonly relayMain: (source: RepoRef, target: RepoRef) => CommitSha | undefined;
    };
  } = {},
) {
  const heads = new Map<ProjectId, CommitSha>();
  const origins = new Map<ProjectId, TrunkOrigin>();
  const refusals = new Map<ProjectId, QuotaExceeded | ImportTooLarge>();
  const adopted = new Map<ProjectId, CommitSha>();
  const seeded = new Map<ProjectId, { readonly name: string; readonly at: Instant }>();
  const taken = new Map<ProjectId, ProjectId>();
  const overCap = new Set<ProjectId>();
  const syncs = new Map<ProjectId, number>();
  const destroyed = new Map<ProjectId, string>();
  const standings = new Map<
    ProjectId,
    { readonly phase: PromotionState; readonly advancedAt: Instant }
  >();
  let failures = options.failSyncOnce === true ? 1 : 0;
  return {
    heads,
    /** Moves an initialized trunk to `head` at `at`, as a promotion's advance does. */
    advance: (projectId: ProjectId, head: CommitSha, at: Instant) => {
      heads.set(projectId, head);
      standings.set(projectId, {
        phase: standings.get(projectId)?.phase ?? "idle",
        advancedAt: at,
      });
    },
    /** Puts an initialized trunk's promotion in `phase`: a freeze, or its release. */
    stand: (projectId: ProjectId, phase: PromotionState) => {
      const standing = standings.get(projectId);
      if (standing !== undefined) standings.set(projectId, { ...standing, phase });
    },
    /** Where each project's trunk started, as its first `initialize` said. */
    origins,
    /** The project's trunk refuses its `initialize` with `refusal` from here on, and gets no head. */
    refuse: (projectId: ProjectId, refusal: QuotaExceeded | ImportTooLarge) => {
      refusals.set(projectId, refusal);
    },
    /** The commit each project's main was made at with `adopt`. */
    adopted,
    /** What each project's first commit was asked to be made of with `seed`; each answered `MEMORY_SEED`. */
    seeded,
    /** The project each trunk took its history from with `take`: its source's head here is what it answered. */
    taken,
    /** `source`'s history is over what one relay carries from here on: a `take` from it is ImportTooLarge. */
    outgrow: (source: ProjectId) => {
      overCap.add(source);
    },
    syncs,
    destroyed,
    layer: Layer.succeed(
      Trunks,
      Trunks.of({
        initialize: (projectId, head, _by, origin) =>
          Effect.suspend(
            (): Effect.Effect<void, PromotionStateRefused | QuotaExceeded | ImportTooLarge> => {
              const held = heads.get(projectId);
              if (held !== undefined && held !== head)
                return Effect.fail(
                  new PromotionStateRefused({ projectId, phase: "idle", command: "Initialize" }),
                );
              if (origin.kind !== "empty" && origin.commit !== head)
                return Effect.die(
                  new Error(
                    `trunk ${projectId} starts at ${head}, and its origin names ${origin.commit}`,
                  ),
                );
              const refusal = refusals.get(projectId);
              if (held === undefined && refusal !== undefined) return Effect.fail(refusal);
              if (held === undefined) {
                origins.set(projectId, origin);
                standings.set(projectId, { phase: "idle", advancedAt: Instant(Date.now()) });
              }
              heads.set(projectId, head);
              options.journal?.push(`initialize ${projectId}`);
              return Effect.void;
            },
          ),
        adopt: (projectId, commit) =>
          Effect.suspend(() => {
            if (heads.has(projectId)) return afterItsHead(projectId, "adopt");
            adopted.set(projectId, commit);
            options.journal?.push(`adopt ${projectId}`);
            return Effect.void;
          }),
        seed: (projectId, name, at) =>
          Effect.suspend(() => {
            if (heads.has(projectId)) return afterItsHead(projectId, "seed");
            seeded.set(projectId, { name, at });
            options.journal?.push(`seed ${projectId}`);
            return Effect.succeed(MEMORY_SEED);
          }),
        take: (projectId, source) =>
          Effect.suspend((): Effect.Effect<CommitSha, RepoNotFound | ImportTooLarge> => {
            if (heads.has(projectId)) return afterItsHead(projectId, "take");
            const from = projectRepos(source).trunk;
            if (overCap.has(source))
              return Effect.fail(
                new ImportTooLarge({
                  projectId,
                  bytes: RELAY_PACK_CAP_BYTES + 1,
                  limit: RELAY_PACK_CAP_BYTES,
                }),
              );
            const head =
              options.host === undefined
                ? heads.get(source)
                : options.host.relayMain(from, projectRepos(projectId).trunk);
            if (head === undefined) return Effect.fail(new RepoNotFound({ repo: from }));
            taken.set(projectId, source);
            options.journal?.push(`take ${projectId}`);
            return Effect.succeed(head);
          }),
        origin: (projectId) => Effect.sync(() => Option.fromUndefinedOr(origins.get(projectId))),
        head: (projectId) =>
          Effect.suspend(() => {
            const head = heads.get(projectId);
            return head === undefined
              ? Effect.die(new Error(`${projectId} has no trunk yet`))
              : Effect.succeed(head);
          }),
        view: (projectId) =>
          Effect.sync(() => {
            const head = heads.get(projectId);
            const standing = standings.get(projectId);
            return head === undefined || standing === undefined
              ? Option.none()
              : Option.some({ head, ...standing });
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

/**
 * Who destroyed each project's lanes, and each report that a lane's KeelVerify
 * instance ended. `journal` records each destroy in order beside other
 * adapters'. A project's one lane holds nothing until `hold` says how many
 * changes it has queued and in flight.
 */
export function makeLanesMemory(options: { readonly journal?: string[] } = {}) {
  const destroyed = new Map<ProjectId, string>();
  const ended: { readonly laneId: string; readonly instanceId: string }[] = [];
  const held = new Map<ProjectId, { readonly queued: number; readonly inFlight: number }>();
  return {
    destroyed,
    ended,
    /** What the project's lane is shown holding from here on. */
    hold: (
      projectId: ProjectId,
      counts: { readonly queued: number; readonly inFlight: number },
    ) => {
      held.set(projectId, counts);
    },
    layer: Layer.succeed(
      Lanes,
      Lanes.of({
        destroy: (projectId, by) =>
          Effect.sync(() => {
            if (!destroyed.has(projectId)) destroyed.set(projectId, by);
            options.journal?.push(`destroy lanes ${projectId}`);
          }),
        view: (projectId) =>
          Effect.sync(() => [
            { id: mainLane(projectId), ...(held.get(projectId) ?? { queued: 0, inFlight: 0 }) },
          ]),
        verificationEnded: (laneId, instanceId) =>
          Effect.sync(() => {
            ended.push({ laneId, instanceId });
          }),
      }),
    ),
  };
}

/**
 * Bundles by address only: a commit's bundle is `sha256:` of the staging repo
 * and the commit, so one commit always has one address. `refuse` lists commits
 * whose tree the bundle format cannot carry. `bundled` records each call,
 * `namespaces` the namespace each was bundled for, and `froms` the bundle each
 * was told to take unchanged files from.
 */
export function makeCandidateBundlesMemory(options: { readonly refuse?: readonly string[] } = {}) {
  const bundled: CommitSha[] = [];
  const namespaces: NamespaceId[] = [];
  const froms: (ContentHash | undefined)[] = [];
  return {
    bundled,
    namespaces,
    froms,
    layer: Layer.succeed(
      CandidateBundles,
      CandidateBundles.of({
        bundle: (namespace, staging, commit, from) =>
          Effect.gen(function* () {
            bundled.push(commit);
            namespaces.push(namespace);
            froms.push(from);
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

/**
 * KeelVerify's starts, by instance id; starting an id again starts nothing
 * new. A started instance stands Running until `end` says how it ended, one
 * never started is `missing`, and `stopped` lists the instances stopped while
 * they ran, in order: each then stands terminated. `looked` lists every
 * instance whose standing was read.
 */
export function makeBatchVerificationMemory() {
  const started = new Map<string, VerificationJob>();
  const ended = new Map<string, InstanceStanding>();
  const stopped: string[] = [];
  const looked: string[] = [];
  const standingOf = (instanceId: string): InstanceStanding =>
    ended.get(instanceId) ??
    (started.has(instanceId) ? { _tag: "Running" } : { _tag: "Failed", status: "missing" });
  return {
    started,
    stopped,
    looked,
    /** Ends an instance as the platform would report it from here on. */
    end: (instanceId: string, standing: InstanceStanding) => {
      ended.set(instanceId, standing);
    },
    layer: Layer.succeed(
      BatchVerification,
      BatchVerification.of({
        start: (instanceId, job) =>
          Effect.sync(() => {
            if (!started.has(instanceId)) started.set(instanceId, job);
          }),
        standing: (instanceId) =>
          Effect.sync(() => {
            looked.push(instanceId);
            return standingOf(instanceId);
          }),
        stop: (instanceId) =>
          Effect.sync(() => {
            if (standingOf(instanceId)._tag !== "Running") return;
            stopped.push(instanceId);
            ended.set(instanceId, { _tag: "Failed", status: "terminated" });
          }),
      }),
    ),
  };
}
