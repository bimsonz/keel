import {
  AGENT_OWNED,
  type Change,
  ChangeNotFound,
  type ChangeState,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseStale,
  PoolExhausted,
  type Preflight,
  SketchNotFound,
  type SubjectKey,
} from "@keeltown/core/domain/coordination";
import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  type ChangeId,
  CommitSha,
  Instant,
  makeId,
  type ProjectId,
  type WorkspaceId,
} from "@keeltown/core/kernel";
import {
  type AgentNotice,
  Changes,
  Inbox,
  Notifier,
  Recall,
  SubjectRegistry,
  type SubjectEntry,
  type SubmissionStatus,
  type WorkspaceGrant,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Duration, Clock as EffectClock, Effect, Layer, Option } from "effect";

const MEMORY_BASE = CommitSha.make("0".repeat(40));

/**
 * Grants workspaces up to `capacity`, then refuses with PoolExhausted. A
 * holder's second grant returns its workspace again with a new token, as the
 * real pool does; every grant's base is `baseSha`.
 */
export function makeWorkspacePoolMemory(
  options: { readonly capacity?: number; readonly baseSha?: CommitSha } = {},
) {
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  const baseSha = options.baseSha ?? MEMORY_BASE;
  const granted = new Map<WorkspaceId, string>();
  const released = new Map<WorkspaceId, string>();
  let counter = 0;
  let tokens = 0;
  return {
    granted,
    released,
    layer: Layer.succeed(
      WorkspacePool,
      WorkspacePool.of({
        grant: (_projectId, holder) =>
          Effect.gen(function* () {
            const held = [...granted].find(([, h]) => h === holder)?.[0];
            if (held === undefined && granted.size >= capacity)
              return yield* new PoolExhausted({ retryAfterMs: 1000 });
            const workspaceId = held ?? makeId("wsp", (counter += 1).toString().padStart(26, "0"));
            granted.set(workspaceId, holder);
            tokens += 1;
            const now = yield* EffectClock.currentTimeMillis;
            return {
              workspaceId,
              remote: `memory://workspaces/${workspaceId}`,
              token: `memws_${tokens}`,
              expiresAt: Instant(now + 7_200_000),
              baseSha,
              repo: { namespace: "memory", name: workspaceId },
            };
          }),
        release: (workspaceId, reason = "withdrawn") =>
          Effect.sync(() => {
            if (granted.delete(workspaceId)) released.set(workspaceId, reason);
          }),
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
        byKey: (projectId, key) =>
          Effect.sync(() => Option.fromNullishOr(subjects.get(scoped(projectId, key)))),
        byAnchor: (projectId, anchor) =>
          Effect.sync(() =>
            [...subjects.entries()]
              .filter(
                ([k, entry]) =>
                  k.startsWith(`${projectId}/`) &&
                  entry.anchors.some((a) => a.path === anchor.path && a.symbol === anchor.symbol),
              )
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
              .map(([, entry]) => ({
                subjectId: entry.id,
                score: words.filter((w) => entry.key.includes(w)).length,
              }))
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
    layer: Layer.succeed(
      Notifier,
      Notifier.of({
        notify: (agentId, notice) => Effect.sync(() => void delivered.push({ agentId, notice })),
      }),
    ),
  };
}

const sequentialId = (n: number) => String(n).padStart(26, "0");

/**
 * Callbacks waiting on a key, each removed when it fires or its wait ends.
 * Both waits below are waiters with a deadline, as the DOs' are; nothing polls.
 */
function makeWaiters<K>() {
  const waiting = new Map<K, Set<() => void>>();
  return {
    wake: (key: K): void => {
      const callbacks = waiting.get(key);
      waiting.delete(key);
      for (const callback of callbacks ?? []) callback();
    },
    /** Resolves on the next `wake(key)`, or after `seconds`, whichever is first. */
    wait: (key: K, seconds: number): Effect.Effect<void> =>
      seconds <= 0
        ? Effect.void
        : Effect.callback<void>((resume) => {
            const callback = () => resume(Effect.void);
            waiting.set(key, new Set([...(waiting.get(key) ?? []), callback]));
            return Effect.sync(() => waiting.get(key)?.delete(callback));
          }).pipe(Effect.timeoutOption(Duration.seconds(seconds)), Effect.asVoid),
  };
}

/**
 * Change DOs as a map, for the isolate's `Changes` port. `declare` opens a
 * change that is `working` (the DO commits ChangeStarted with the declaration),
 * with an active lease and a workspace, idempotent by (agent, Idempotency-Key).
 * `submit` checks the lease and the state, as the Change DO does, and accepts
 * only a commit `push`ed to the change's workspace. `awaitSubmission` waits
 * for `settle` (or a submit) to move the change, up to its deadline.
 * `capacity` bounds the workspaces it will grant.
 */
export function makeChangesMemory(options: { readonly capacity?: number } = {}) {
  const changes = new Map<ChangeId, Change>();
  const commits = new Map<ChangeId, CommitSha>();
  const workspaces = new Map<ChangeId, WorkspaceId>();
  const pushed = new Map<WorkspaceId, Set<string>>();
  const reservations = new Map<
    string,
    { readonly changeId: ChangeId; readonly fingerprint: string }
  >();
  const waiters = makeWaiters<ChangeId>();
  /** A submit replays by its cause, the Idempotency-Key, as the DO's commit does. */
  const submits = new Map<string, Change>();
  let sequence = 0;
  let tokens = 0;
  const grant = (changeId: ChangeId, now: Instant): WorkspaceGrant => {
    const workspaceId = workspaces.get(changeId) ?? makeId("wsp", sequentialId((sequence += 1)));
    workspaces.set(changeId, workspaceId);
    tokens += 1;
    return {
      workspaceId,
      remote: `https://artifacts.invalid/${workspaceId}.git`,
      token: `memory-token-${tokens}`,
      expiresAt: Instant(now + 3_600_000),
      baseSha: MEMORY_BASE,
      repo: { namespace: "memory", name: workspaceId },
    };
  };
  const status = (change: Change): SubmissionStatus => ({
    change,
    commitSha: commits.get(change.id) ?? null,
  });
  /** A commit lands in a workspace, as an agent's `git push` would put it there. */
  const push = (workspaceId: WorkspaceId, sha: CommitSha): void => {
    pushed.set(workspaceId, new Set([...(pushed.get(workspaceId) ?? []), sha]));
  };
  /** The platform moves a change on (a verdict, a landing), waking anyone waiting on it. */
  const settle = (changeId: ChangeId, state: ChangeState): void => {
    const change = changes.get(changeId);
    if (change === undefined) throw new Error(`no change ${changeId}`);
    changes.set(changeId, { ...change, state });
    waiters.wake(changeId);
  };
  return {
    changes,
    commits,
    push,
    settle,
    layer: Layer.succeed(
      Changes,
      Changes.of({
        declare: (principal, input) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const key = `${principal.agentId} ${input.idempotencyKey}`;
            const { idempotencyKey: _key, ...body } = input;
            const fingerprint = JSON.stringify(body);
            const reserved = reservations.get(key);
            if (reserved !== undefined && reserved.fingerprint !== fingerprint) {
              return yield* new IdempotencyConflict({ idempotencyKey: input.idempotencyKey });
            }
            if (input.fromSketch !== undefined)
              return yield* new SketchNotFound({ sketchId: input.fromSketch });
            const existing = reserved === undefined ? undefined : changes.get(reserved.changeId);
            if (
              existing === undefined &&
              options.capacity !== undefined &&
              changes.size >= options.capacity
            ) {
              return yield* new PoolExhausted({ retryAfterMs: 5_000 });
            }
            const change: Change = existing ?? {
              id: makeId("chg", sequentialId((sequence += 1))),
              agentId: principal.agentId,
              origin: "agent",
              state: "working",
              intent: {
                revision: 1,
                goal: input.goal,
                footprint: input.footprint,
                premises: input.premises,
                ...(input.declaredEffects === undefined
                  ? {}
                  : { declaredEffects: input.declaredEffects }),
              },
              lease: {
                id: makeId("lse", sequentialId((sequence += 1))),
                agentId: principal.agentId,
                renewedAt: now,
                state: "active",
              },
              createdAt: now,
            };
            const workspace = grant(change.id, now);
            const stored: Change = { ...change, workspaceId: workspace.workspaceId };
            changes.set(stored.id, stored);
            reservations.set(key, { changeId: stored.id, fingerprint });
            const preflight: Preflight = {
              neighbours: [],
              contradictions: [],
              precedents: [],
              suggestedMove: "proceed",
            };
            return { change: stored, preflight, workspace };
          }),
        submit: (_principal, input) =>
          Effect.gen(function* () {
            const replayed = submits.get(`${input.changeId} ${input.idempotencyKey}`);
            if (replayed !== undefined) return replayed;
            const change = changes.get(input.changeId);
            if (change === undefined)
              return yield* new ChangeNotFound({ changeId: input.changeId });
            if (change.lease.id !== input.lease || change.lease.state !== "active") {
              return yield* new LeaseStale({ changeId: input.changeId, leaseId: input.lease });
            }
            if (!AGENT_OWNED.has(change.state))
              return yield* new ChangeStateRefused({
                changeId: change.id,
                state: change.state,
                command: "submit",
              });
            const workspace = workspaces.get(change.id);
            if (workspace === undefined || pushed.get(workspace)?.has(input.commitSha) !== true) {
              return yield* new CommitNotInWorkspace({
                changeId: change.id,
                commitSha: input.commitSha,
              });
            }
            const submitted: Change = { ...change, state: "submitted" };
            changes.set(change.id, submitted);
            commits.set(change.id, input.commitSha);
            submits.set(`${input.changeId} ${input.idempotencyKey}`, submitted);
            waiters.wake(change.id);
            return submitted;
          }),
        get: (changeId) =>
          Effect.suspend(() => {
            const change = changes.get(changeId);
            return change === undefined
              ? Effect.fail(new ChangeNotFound({ changeId }))
              : Effect.succeed(change);
          }),
        awaitSubmission: (changeId, waitSeconds) =>
          Effect.gen(function* () {
            const before = changes.get(changeId);
            if (before === undefined) return yield* new ChangeNotFound({ changeId });
            yield* waiters.wait(changeId, waitSeconds);
            return status(changes.get(changeId) ?? before);
          }),
      }),
    ),
  };
}

/**
 * Agents' inboxes as lists. `deliver` appends a notice and wakes a waiting
 * read; the cursor is the count already read.
 */
export function makeInboxMemory() {
  const inboxes = new Map<AgentId, AgentNotice[]>();
  const waiters = makeWaiters<AgentId>();
  const deliver = (agentId: AgentId, notice: AgentNotice): void => {
    inboxes.set(agentId, [...(inboxes.get(agentId) ?? []), notice]);
    waiters.wake(agentId);
  };
  const page = (agentId: AgentId, from: number) => {
    const notices = inboxes.get(agentId) ?? [];
    return { notices: notices.slice(from), cursor: String(Math.max(from, notices.length)) };
  };
  return {
    inboxes,
    deliver,
    layer: Layer.succeed(
      Inbox,
      Inbox.of({
        read: (agentId, cursor, waitSeconds) =>
          Effect.gen(function* () {
            const from = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
            if (page(agentId, from).notices.length === 0) yield* waiters.wait(agentId, waitSeconds);
            return page(agentId, from);
          }),
      }),
    ),
  };
}
