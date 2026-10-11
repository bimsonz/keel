import type { LeasedCall, RebasedChange, Revised } from "@keeltown/core/application/coordination";
import {
  AGENT_OWNED,
  type Change,
  ChangeInOtherProject,
  ChangeNotFound,
  type ChangeState,
  ChangeStateRefused,
  CommitNotInWorkspace,
  isLapsed,
  LeaseNotLapsed,
  LeaseStale,
  lapsesAt,
  PoolExhausted,
  type Intent,
  type Preflight,
  reviseIntent,
  RevisionMismatch,
  SketchNotFound,
  type SubjectKey,
  TERMINAL,
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
  KEEL_TRUNK_REF,
  type SubmissionStatus,
  type ObservedPush,
  type PoolConfig,
  type WorkspaceGrant,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Duration, Clock as EffectClock, Effect, Layer, Option } from "effect";

const MEMORY_BASE = CommitSha.make("0".repeat(40));
/** What a rebase answers: the change on its base, and the workspace branch holding it. */
const rebasedAnswer = (change: Change): RebasedChange => ({
  change,
  ref: KEEL_TRUNK_REF,
  base: change.baseSha ?? MEMORY_BASE,
});
/** The states a rebase is taken in, as the domain's Rebase allows. */
const REBASABLE: ReadonlySet<ChangeState> = new Set(["working", "bounced"]);
/** The states a revision is taken in, as the domain's Revise allows; a rely is taken only while working. */
const REVISABLE: ReadonlySet<ChangeState> = new Set(["working", "drifted", "bounced"]);
const RELIABLE: ReadonlySet<ChangeState> = new Set(["working"]);
/** No live index in memory: preflight finds nothing near. */
const NOTHING_NEAR: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};
/** Trunk's head as the in-memory Trunk DO reports it, which a rebase moves a change onto. */
const MEMORY_TRUNK_HEAD = CommitSha.make("7".repeat(40));

/**
 * Grants workspaces up to `capacity`, then refuses with PoolExhausted. A
 * holder's second grant returns its workspace again with a new token, as the
 * real pool does; every grant's base is `baseSha`.
 */
export function makeWorkspacePoolMemory(
  options: {
    readonly capacity?: number;
    readonly baseSha?: CommitSha;
    /** Records each call in order, beside other adapters', for tests of a sequence. */
    readonly journal?: string[];
  } = {},
) {
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  const baseSha = options.baseSha ?? MEMORY_BASE;
  const granted = new Map<WorkspaceId, string>();
  const released = new Map<WorkspaceId, string>();
  const configured = new Map<ProjectId, PoolConfig>();
  /** Each push recorded, by its push id. */
  const pushed = new Map<string, ObservedPush>();
  let counter = 0;
  let tokens = 0;
  return {
    granted,
    released,
    configured,
    pushed,
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
        release: (_projectId, workspaceId, reason = "withdrawn") =>
          Effect.sync(() => {
            if (granted.delete(workspaceId)) released.set(workspaceId, reason);
          }),
        configure: (projectId, config) =>
          Effect.sync(() => {
            configured.set(projectId, config);
            options.journal?.push(`configure ${projectId}`);
          }),
        observePush: (_projectId, pushId, push) =>
          Effect.sync(() => {
            if (pushed.has(pushId)) return "recorded";
            if (!granted.has(push.workspaceId)) return "ignored";
            pushed.set(pushId, push);
            return "recorded";
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
 * only a commit `push`ed to the change's workspace. `abandon` withdraws it
 * under its lease or as an operator, refused once it has ended or while it
 * is integrating, as the Change machine refuses it. `awaitSubmission` waits
 * for `settle` (or a submit) to move the change, up to its deadline.
 * `capacity` bounds the workspaces it will grant.
 */
/** The project every in-memory change's workspace belongs to, unless a test names another. */
const MEMORY_PROJECT = makeId("prj", "00000000000000000000000000");

export function makeChangesMemory(
  options: {
    readonly capacity?: number;
    readonly projectId?: ProjectId;
    readonly trunkHead?: CommitSha;
  } = {},
) {
  const changes = new Map<ChangeId, Change>();
  /** A rebase replays by its key per change, as the DO's commit does. */
  const rebases = new Map<string, Change>();
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
  /** Each change's project, its declarer's: an adopter from another project is refused. */
  const projects = new Map<ChangeId, ProjectId>();
  /** An adopt replays by its key per change; the same key from another caller is a conflict. */
  const adoptions = new Map<string, { readonly caller: string; readonly change: Change }>();
  /** Changes whose lease has lapsed by `lapse`, as the deadline passing would leave them. */
  const lapsed = new Set<ChangeId>();
  /** A revise or rely replays by its key per change; the same key with another body is a conflict. */
  const amendments = new Map<string, { readonly body: string; readonly answer: Revised }>();
  /**
   * Revises a change's intent under its lease, as the DO decides it: the
   * change, then the lease, then its state, then `check`, then `next`.
   */
  const amend = <E>(
    input: LeasedCall,
    command: "Revise" | "Rely",
    body: unknown,
    states: ReadonlySet<ChangeState>,
    check: (change: Change) => Effect.Effect<void, E>,
    next: (intent: Intent) => Intent,
  ) =>
    Effect.gen(function* () {
      const key = `${input.changeId} ${input.idempotencyKey}`;
      const replayed = amendments.get(key);
      if (replayed !== undefined)
        return replayed.body === JSON.stringify(body)
          ? replayed.answer
          : yield* new IdempotencyConflict({ idempotencyKey: input.idempotencyKey });
      const change = changes.get(input.changeId);
      if (change === undefined) return yield* new ChangeNotFound({ changeId: input.changeId });
      if (change.lease.id !== input.lease || change.lease.state !== "active")
        return yield* new LeaseStale({ changeId: input.changeId, leaseId: input.lease });
      if (!states.has(change.state))
        return yield* new ChangeStateRefused({ changeId: change.id, state: change.state, command });
      yield* check(change);
      const amended: Change = { ...change, intent: next(change.intent) };
      changes.set(change.id, amended);
      const answer: Revised = { change: amended, preflight: NOTHING_NEAR };
      amendments.set(key, { body: JSON.stringify(body), answer });
      return answer;
    });
  /** An abandon replays by its key per change; the same key with another body is a conflict. */
  const withdrawals = new Map<string, string>();
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
  /** The change's lease deadline passes, as time would let it: the next adopt may take it. */
  const lapse = (changeId: ChangeId): void => {
    if (!changes.has(changeId)) throw new Error(`no change ${changeId}`);
    lapsed.add(changeId);
  };
  return {
    changes,
    commits,
    push,
    settle,
    lapse,
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
            projects.set(stored.id, principal.projectId);
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
                command: "Submit",
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
        adopt: (principal, input) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const { changeId, idempotencyKey } = input;
            const caller = `${principal.agentId} ${principal.projectId}`;
            const replayed = adoptions.get(`${changeId} ${idempotencyKey}`);
            if (replayed !== undefined && replayed.caller !== caller)
              return yield* new IdempotencyConflict({ idempotencyKey });
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            const regrant = () =>
              workspaces.has(changeId) ? { workspace: grant(changeId, now) } : {};
            if (replayed !== undefined) return { change, ...regrant() };
            if (projects.get(changeId) !== principal.projectId)
              return yield* new ChangeInOtherProject({ changeId });
            if (TERMINAL.has(change.state))
              return yield* new ChangeStateRefused({
                changeId,
                state: change.state,
                command: "Adopt",
              });
            if (!lapsed.has(changeId) && !isLapsed(change.lease, now))
              return yield* new LeaseNotLapsed({
                changeId,
                lapsesAt: lapsesAt(change.lease),
                nextActions: [
                  {
                    kind: "wait",
                    title: "Wait for the lease to lapse: adoption needs a Lapsed lease",
                    args: { lapsesAt: lapsesAt(change.lease) },
                  },
                ],
              });
            const adopted: Change = {
              ...change,
              agentId: principal.agentId,
              state:
                change.state === "parked"
                  ? workspaces.has(changeId)
                    ? "working"
                    : "declared"
                  : change.state,
              lease: {
                id: makeId("lse", sequentialId((sequence += 1))),
                agentId: principal.agentId,
                renewedAt: now,
                state: "active",
              },
            };
            const { parkReason: _parked, ...unparked } = adopted;
            changes.set(changeId, unparked);
            lapsed.delete(changeId);
            adoptions.set(`${changeId} ${idempotencyKey}`, { caller, change: unparked });
            waiters.wake(changeId);
            return { change: unparked, ...regrant() };
          }),
        abandon: (principal, input) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const { changeId, authority, reason, idempotencyKey } = input;
            const body = JSON.stringify({ agentId: principal.agentId, authority, reason });
            const replayed = withdrawals.get(`${changeId} ${idempotencyKey}`);
            if (replayed !== undefined && replayed !== body)
              return yield* new IdempotencyConflict({ idempotencyKey });
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            if (replayed !== undefined) return change;
            const refused = new ChangeStateRefused({
              changeId,
              state: change.state,
              command: "Withdraw",
            });
            if (TERMINAL.has(change.state)) return yield* refused;
            if (
              authority._tag === "Lease" &&
              (change.lease.id !== authority.leaseId ||
                change.lease.state !== "active" ||
                lapsed.has(changeId) ||
                isLapsed(change.lease, now))
            )
              return yield* new LeaseStale({ changeId, leaseId: authority.leaseId });
            if (change.state === "integrating") return yield* refused;
            const { parkReason: _parked, ...ended } = change;
            const withdrawn: Change = {
              ...ended,
              state: "withdrawn",
              lease: { ...change.lease, state: "released" },
            };
            changes.set(changeId, withdrawn);
            withdrawals.set(`${changeId} ${idempotencyKey}`, body);
            waiters.wake(changeId);
            return withdrawn;
          }),
        workspace: (changeId) =>
          Effect.gen(function* () {
            const change = changes.get(changeId);
            if (change === undefined) return yield* new ChangeNotFound({ changeId });
            const workspaceId = workspaces.get(changeId);
            if (workspaceId === undefined)
              return yield* new ChangeStateRefused({
                changeId,
                state: change.state,
                command: "workspace",
              });
            return {
              workspaceId,
              repo: { namespace: "memory", name: workspaceId },
              baseSha: MEMORY_BASE,
              grantedSha: MEMORY_BASE,
              projectId: options.projectId ?? MEMORY_PROJECT,
            };
          }),
        rebase: (_principal, input) =>
          Effect.gen(function* () {
            const replayed = rebases.get(`${input.changeId} ${input.idempotencyKey}`);
            if (replayed !== undefined) return rebasedAnswer(replayed);
            const change = changes.get(input.changeId);
            if (change === undefined)
              return yield* new ChangeNotFound({ changeId: input.changeId });
            if (change.lease.id !== input.lease || change.lease.state !== "active")
              return yield* new LeaseStale({ changeId: input.changeId, leaseId: input.lease });
            const onto = options.trunkHead ?? MEMORY_TRUNK_HEAD;
            if (
              !REBASABLE.has(change.state) ||
              change.baseSha === undefined ||
              change.baseSha === onto
            )
              return yield* new ChangeStateRefused({
                changeId: change.id,
                state: change.state,
                command: "Rebase",
              });
            const rebased: Change = { ...change, baseSha: onto };
            changes.set(change.id, rebased);
            rebases.set(`${input.changeId} ${input.idempotencyKey}`, rebased);
            return rebasedAnswer(rebased);
          }),
        revise: (_principal, input) => {
          const { idempotencyKey: _key, ...body } = input;
          return amend(
            input,
            "Revise",
            body,
            REVISABLE,
            (change) =>
              change.intent.revision === input.ifMatchRevision
                ? Effect.void
                : Effect.fail(
                    new RevisionMismatch({
                      changeId: change.id,
                      expected: input.ifMatchRevision,
                      actual: change.intent.revision,
                      nextActions: [],
                    }),
                  ),
            (intent) =>
              reviseIntent(intent, {
                revision: intent.revision + 1,
                ...(input.goal === undefined ? {} : { goal: input.goal }),
                ...(input.footprint === undefined ? {} : { footprint: input.footprint }),
                premisesAdded: input.premisesAdded,
                premisesRetracted: input.premisesRetracted,
                ...(input.declaredEffects === undefined
                  ? {}
                  : { declaredEffects: input.declaredEffects }),
              }),
          );
        },
        rely: (_principal, input) =>
          amend(
            input,
            "Rely",
            { premise: input.premise },
            RELIABLE,
            () => Effect.void,
            (intent) =>
              reviseIntent(intent, {
                revision: intent.revision + 1,
                premisesAdded: [input.premise],
                premisesRetracted: [],
              }),
          ),
        nearby: (principal, changeId) =>
          Effect.gen(function* () {
            if (!changes.has(changeId)) return yield* new ChangeNotFound({ changeId });
            if (projects.get(changeId) !== principal.projectId)
              return yield* new ChangeInOtherProject({ changeId });
            return NOTHING_NEAR;
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

/** Notices with the cursor each sits at: the count read once it is. */
const withCursors = (notices: readonly AgentNotice[], from: number) =>
  notices.map((notice, i) => ({ ...notice, cursor: String(from + i + 1) }));

/**
 * Agents' inboxes as lists, read by `Inbox` and piggybacked by `Notifier`.
 * `deliver` appends a notice and wakes a waiting read. A cursor is the count
 * already read; `piggybacked` is the count a tool result carried or a read
 * returned, so a notice rides at most one result and never one after a read.
 */
export function makeInboxMemory() {
  const inboxes = new Map<AgentId, AgentNotice[]>();
  const piggybacked = new Map<AgentId, number>();
  const waiters = makeWaiters<AgentId>();
  const deliver = (agentId: AgentId, notice: AgentNotice): void => {
    inboxes.set(agentId, [...(inboxes.get(agentId) ?? []), notice]);
    waiters.wake(agentId);
  };
  const page = (agentId: AgentId, from: number) => {
    const notices = inboxes.get(agentId) ?? [];
    return {
      notices: withCursors(notices.slice(from), from),
      cursor: String(Math.max(from, notices.length)),
    };
  };
  const markRead = (agentId: AgentId, upTo: number) => {
    const read = Math.min(upTo, inboxes.get(agentId)?.length ?? 0);
    piggybacked.set(agentId, Math.max(piggybacked.get(agentId) ?? 0, read));
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
            const read = page(agentId, from);
            markRead(agentId, Number(read.cursor));
            return read;
          }),
      }),
    ),
    notifier: Layer.succeed(
      Notifier,
      Notifier.of({
        take: (agentId, limit) =>
          Effect.sync(() => {
            const from = piggybacked.get(agentId) ?? 0;
            const taken = (inboxes.get(agentId) ?? []).slice(
              from,
              from + Math.min(Math.max(limit, 0), 3),
            );
            piggybacked.set(agentId, from + taken.length);
            return withCursors(taken, from);
          }),
      }),
    ),
  };
}
