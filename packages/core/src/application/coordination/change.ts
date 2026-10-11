import { Effect, Option, Result, Schema } from "effect";
import {
  type Blockers,
  Change,
  type ChangeCommand,
  ChangeBounced,
  ChangeEvent,
  ChangeInOtherProject,
  ChangeNotFound,
  type ChangeOrigin,
  type ChangeRejection,
  ChangeStateRefused,
  type CommitNotInWorkspace,
  decideChange,
  evolveChange,
  type FootprintEntry,
  type LeaseNotLapsed,
  type LeaseStale,
  type PoolExhausted,
  type Preflight,
  type Proposition,
  renew,
  type RevisionMismatch,
  type WithdrawAuthority,
} from "../../domain/coordination/index.ts";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  BatchFailed,
  BatchFormed,
  CandidateBisected,
  CandidateInvalidated,
  type PushRejected,
  TrunkAdvanced,
} from "../../domain/integration/index.ts";
import {
  type Actor,
  type AgentId,
  agentActor,
  type ChangeId,
  CommitSha,
  type ContentHash,
  contentHashOf,
  type EntityRef,
  type EventEnvelope,
  type Json,
  type LeaseId,
  NextAction,
  ProjectId,
  type SketchId,
  type VerdictId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import { VerdictIssued } from "../../domain/verification/index.ts";
import {
  Clock,
  CodeHost,
  commit,
  type Committed,
  EntityStore,
  type EventDraft,
  EventOutbox,
  EVERY_TYPE,
  Ids,
  type Remedy,
  type Stored,
  type SubmissionStatus,
  type Transaction,
  type Transition,
  KEEL_TRUNK_REF,
  type PackTooLarge,
  Trunks,
  WorkspacePool,
  type WorkspaceGrant,
  WorkspaceRebaser,
} from "../ports/index.ts";

/**
 * The Change DO's use-cases (`change:<ULID>`). Each takes what it must look up
 * first (an id, a grant, whether a commit is in the workspace), then commits:
 * inside one transaction the domain's `decideChange` decides at `tx.at`,
 * `evolveChange` folds the events into the state that is written, and the
 * events are appended. The lease is authorised there and only there.
 */

/** Where the Change DO keeps its change in its EntityStore, keyed by the change id. */
export const CHANGE = "change";
/** Where it keeps the workspace the change holds, beside the change and outside the domain's Change. */
export const CHANGE_WORKSPACE = "change-workspace";

/**
 * The workspace a change holds, the commit it was granted at, and its
 * project. `grantedSha` is the fork point and never moves; the change's base
 * is the domain Change's `baseSha`, which a rebase moves. It is stored under
 * `baseSha`, its name before rebases existed, so changes already stored decode.
 */
export const HeldWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  repo: Schema.Struct({ namespace: Schema.String, name: Schema.String }),
  grantedSha: CommitSha,
  projectId: ProjectId,
}).pipe(Schema.encodeKeys({ grantedSha: "baseSha" }));
export type HeldWorkspace = typeof HeldWorkspace.Type;

/**
 * What Precheck and the Lane read of a change's workspace: Precheck diffs
 * `repo` against `baseSha` (the change's base), stops an ancestry walk at
 * `grantedSha`, and reads `projectId`'s settings.
 */
export interface WorkspaceView extends HeldWorkspace {
  readonly baseSha: CommitSha;
}

/** At L1 no premise is compared yet, so preflight finds nothing and suggests proceeding. */
export const L1_PREFLIGHT: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};

/** At L1 nothing blocks a change: conflicts and drift arrive with L2, and Precheck refuses guard edits itself. */
export const L1_UNBLOCKED: Blockers = {
  openProvenConflicts: [],
  failingGuards: [],
  unresolvedHighDrift: [],
};

/** The lane a project's changes queue on: at L1, one lane per project, for trunk's `main`. */
export const laneOf = (projectId: ProjectId): string => `lane:${projectId}:main`;

/** Precheck starts once per ChangeSubmitted, as `precheck-<eventId>`. */
export const PRECHECK = "workflow:Precheck";
/** The events after which the change's pool collects its workspace. */
export const CHANGE_ENDS = ["ChangeLanded", "ChangeWithdrawn", "ChangeSuperseded"] as const;
/**
 * What the change's lane hears from it: each queueing, each requeue (the lane
 * re-enqueues only then, never by itself), and an end that drops it from the queue.
 */
export const LANE_HEARS = [
  "ChangeQueued",
  "ChangeRequeued",
  "ChangeWithdrawn",
  "ChangeSuperseded",
] as const;
/** Where the Change DO keeps the verdicts it heard on its batch, by verdict id, until BatchFailed names one. */
export const CHANGE_BATCH_VERDICT = "change-batch-verdict";

export interface DeclareChange {
  /** The id the agent's AgentSession reserved for `idempotencyKey`. */
  readonly changeId: ChangeId;
  readonly agentId: AgentId;
  readonly projectId: ProjectId;
  readonly origin: ChangeOrigin;
  readonly goal: string;
  readonly footprint: readonly FootprintEntry[];
  readonly premises: readonly Proposition[];
  readonly declaredEffects?: readonly Proposition[] | undefined;
  readonly sketchId?: SketchId | undefined;
  readonly idempotencyKey: string;
  /** A hash of the request body, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

export interface DeclaredChange {
  readonly change: Change;
  readonly preflight: Preflight;
  readonly grant: WorkspaceGrant;
}

export interface ReviseChange {
  readonly agentId: AgentId;
  readonly leaseId: LeaseId;
  readonly ifMatchRevision: number;
  readonly goal?: string | undefined;
  readonly footprint?: readonly FootprintEntry[] | undefined;
  readonly premisesAdded: readonly Proposition[];
  readonly premisesRetracted: readonly Proposition[];
  readonly declaredEffects?: readonly Proposition[] | undefined;
  readonly idempotencyKey: string;
}

export interface RevisedChange {
  readonly change: Change;
  readonly preflight: Preflight;
}

export interface SubmitChange {
  readonly agentId: AgentId;
  readonly leaseId: LeaseId;
  readonly commitSha: CommitSha;
  readonly idempotencyKey: string;
}

export interface AbandonChange {
  readonly agentId: AgentId;
  readonly authority: WithdrawAuthority;
  readonly reason?: string | undefined;
  readonly idempotencyKey: string;
}

export interface RebaseChange {
  readonly agentId: AgentId;
  readonly leaseId: LeaseId;
  readonly idempotencyKey: string;
}

/** What rebasing answers: the change on its new base, and the workspace branch holding that base, to fetch and merge. */
export interface RebasedChange {
  readonly change: Change;
  readonly ref: typeof KEEL_TRUNK_REF;
  readonly base: CommitSha;
}

export interface AdoptChange {
  readonly agentId: AgentId;
  /** The adopter's project, from its token. */
  readonly projectId: ProjectId;
  readonly idempotencyKey: string;
}

/** What adopting answers: the change under its new lease, and a fresh token for the workspace it holds. */
export interface AdoptedChange {
  readonly change: Change;
  readonly grant?: WorkspaceGrant;
}

/** A Precheck step's call: the revision it checked, and its Workflow instance. */
export interface PrecheckStep {
  readonly revision: number;
  readonly instanceId: string;
}

/** Precheck refused the submission: why, and what the agent can do about it (never empty). */
export interface PrecheckRefusal extends PrecheckStep {
  readonly reasons: readonly string[];
  readonly nextActions: readonly NextAction[];
}

export interface CompiledPlan extends PrecheckStep {
  readonly planHash: ContentHash;
  readonly steps: number;
  readonly costEstimate: number;
}

type Store = Transaction["store"];
type Tag = ChangeRejection["_tag"];
type Refusal<T extends Tag> = Extract<ChangeRejection, { readonly _tag: T }>;

const decodeChange = Schema.decodeUnknownSync(Change);
const encodeChange = Schema.encodeSync(Change);
const decodeHeld = Schema.decodeUnknownSync(HeldWorkspace);
const encodeHeld = Schema.encodeSync(HeldWorkspace);
const encodeEvent = Schema.encodeSync(ChangeEvent);
const encodeVerdict = Schema.encodeSync(VerdictIssued);
const decodeBounced = Schema.decodeUnknownSync(ChangeBounced);

/** As stored: JSON, without the keys an absent optional field leaves undefined. */
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });

const storedChange = (store: Store, changeId: ChangeId): Change | undefined => {
  const value = store.get(CHANGE, changeId);
  return value === undefined ? undefined : decodeChange(value);
};

const heldWorkspace = (store: Store, changeId: ChangeId): HeldWorkspace | undefined => {
  const value = store.get(CHANGE_WORKSPACE, changeId);
  return value === undefined ? undefined : decodeHeld(value);
};

/** The change's project, for its events' envelopes: recorded with its workspace at declare. */
const inProject = (store: Store, changeId: ChangeId): { readonly project?: ProjectId } => {
  const project = heldWorkspace(store, changeId)?.projectId;
  return project === undefined ? {} : { project };
};

const readChange = (changeId: ChangeId): NextAction => ({
  kind: "read",
  title: "Read the change for its current state, revision and lease",
  operationId: "Changes_getChange",
  args: { changeId },
});

const notFound = (changeId: ChangeId) =>
  new ChangeNotFound({
    changeId,
    nextActions: [
      { kind: "call", title: "Declare the change before acting on it", operationId: "declare" },
    ],
  });

const refused = (change: Change, command: string) =>
  new ChangeStateRefused({
    changeId: change.id,
    state: change.state,
    command,
    nextActions: [readChange(change.id)],
  });

/** A hash of a command that carries no fingerprint of its own, so a reused key is told apart from a retry. */
const fingerprintOf = (method: string, command: object): string => {
  const json: Json = JSON.parse(JSON.stringify({ method, command }));
  return contentHashOf(json);
};

const isOneOf = <T extends Tag>(
  tags: readonly T[],
  rejection: ChangeRejection,
): rejection is Refusal<T> => tags.some((tag) => tag === rejection._tag);

/**
 * Decides `commands` in turn on the stored change at `tx.at`, folds each one's
 * events in with `evolveChange`, and writes the result. A refusal of any
 * command refuses them all. A refusal outside `tags` is one the caller's
 * contract cannot carry: it is thrown, rolling the transaction back as a defect.
 * `renewing` is the lease an authorised call renews: `renewedAt` is state, not an event.
 */
const transition = <T extends Tag>(
  tx: Transaction,
  changeId: ChangeId,
  tags: readonly T[],
  commands: readonly ChangeCommand[],
  renewing?: LeaseId,
): Result.Result<
  { readonly change: Change; readonly drafts: readonly EventDraft[] },
  Refusal<T>
> => {
  let state = storedChange(tx.store, changeId);
  const drafts: EventDraft[] = [];
  for (const command of commands) {
    const decided = decideChange(state, command, { now: tx.at, changeId });
    if (Result.isFailure(decided)) {
      if (isOneOf(tags, decided.failure)) return Result.fail(decided.failure);
      throw new Error(`${command._tag} was refused with ${decided.failure._tag}`, {
        cause: decided.failure,
      });
    }
    for (const payload of decided.success) {
      state = evolveChange(state, { at: tx.at, payload });
      drafts.push({ payload: payloadOf(encodeEvent(payload)) });
    }
  }
  if (state === undefined) throw new Error(`${changeId} has no state after its commands`);
  const decided = state;
  const renewed =
    renewing === undefined
      ? decided
      : Result.getOrElse(renew(decided, renewing, tx.at), () => decided);
  tx.store.put(CHANGE, changeId, asStored(encodeChange(renewed)));
  return Result.succeed({ change: renewed, drafts });
};

const asTransition = (decided: {
  readonly change: Change;
  readonly drafts: readonly EventDraft[];
}) => ({
  value: decided.change,
  drafts: decided.drafts,
});

/** What a call answers: the change it committed; for a retry, the change as it stands; for a reused key, a conflict. */
const settled = (changeId: ChangeId, idempotencyKey: string, committed: Committed<Change>) =>
  committed.duplicate
    ? committed.sameCommand
      ? getChange(changeId)
      : Effect.fail(new IdempotencyConflict({ idempotencyKey }))
    : Effect.succeed(committed.value);

/** What a command without a fingerprint answers: the change it committed, or for a replay the change as it stands. */
const current = (changeId: ChangeId, committed: Committed<Change>) =>
  committed.duplicate ? getChange(changeId) : Effect.succeed(committed.value);

/** The change as the Change DO holds it. */
export const getChange: (changeId: ChangeId) => Effect.Effect<Change, ChangeNotFound, EntityStore> =
  Effect.fn("coordination/getChange")(function* (changeId: ChangeId) {
    const change = storedChange(yield* EntityStore, changeId);
    if (change === undefined) return yield* notFound(changeId);
    return change;
  });

/**
 * The remedy still owed on a change, from its log: its latest ChangeBounced
 * after its latest ChangeSubmitted. A resubmission answers it, so it clears;
 * a lapse and a park leave it standing.
 */
export const remedyOf = (log: readonly EventEnvelope[]): Remedy | undefined => {
  let remedy: Remedy | undefined;
  for (const event of log) {
    if (event.type === "ChangeSubmitted") remedy = undefined;
    if (event.type === "ChangeBounced") {
      const { verdictId, reasons, nextActions } = decodeBounced(event.payload);
      remedy = { verdictId, reasons, nextActions: nextActions ?? [] };
    }
  }
  return remedy;
};

/** The change's submission as it stands: the change, the commit last submitted for it, and any remedy owed. */
export const submissionStatus: (
  changeId: ChangeId,
) => Effect.Effect<SubmissionStatus, ChangeNotFound, EntityStore | EventOutbox> = Effect.fn(
  "coordination/submissionStatus",
)(function* (changeId: ChangeId) {
  const change = yield* getChange(changeId);
  const remedy = remedyOf((yield* EventOutbox).log(changeRef(changeId)));
  return {
    change,
    commitSha: change.commitSha ?? null,
    ...(remedy === undefined ? {} : { remedy }),
  };
});

/** The workspace the change holds, for Precheck's diff. ChangeStateRefused before it holds one. */
export const changeWorkspace: (
  changeId: ChangeId,
) => Effect.Effect<WorkspaceView, ChangeNotFound | ChangeStateRefused, EntityStore> = Effect.fn(
  "coordination/changeWorkspace",
)(function* (changeId: ChangeId) {
  const change = yield* getChange(changeId);
  const held = heldWorkspace(yield* EntityStore, changeId);
  if (held === undefined || change.baseSha === undefined)
    return yield* refused(change, "workspace");
  return { ...held, baseSha: change.baseSha };
});

/** Gives a grant back unless the change holds it: `grant` is idempotent per holder, so a live change's own workspace stays. */
const releaseUnheld = (changeId: ChangeId, projectId: ProjectId, grant: WorkspaceGrant) =>
  Effect.gen(function* () {
    if (heldWorkspace(yield* EntityStore, changeId)?.workspaceId === grant.workspaceId) return;
    yield* (yield* WorkspacePool).release(projectId, grant.workspaceId, "withdrawn");
  });

/**
 * Declares the change: mints its lease, takes its workspace, then commits
 * IntentDeclared, PreflightIssued and ChangeStarted in one transaction, so the
 * change is Working on its base when declare answers. The agent hears every
 * event, Precheck starts on each submission, and the pool collects the
 * workspace when the change ends. A refused declare gives back a grant the
 * change does not hold.
 */
export const declare: (
  command: DeclareChange,
) => Effect.Effect<
  DeclaredChange,
  ChangeStateRefused | PoolExhausted | IdempotencyConflict,
  Clock | Ids | EntityStore | EventOutbox | WorkspacePool
> = Effect.fn("coordination/declare")(function* (command: DeclareChange) {
  const { changeId } = command;
  const leaseId = yield* (yield* Ids).next("lse");
  const grant = yield* (yield* WorkspacePool).grant(command.projectId, changeId);
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: command.fingerprint,
      actor: agentActor(command.agentId),
      project: command.projectId,
    },
    (tx) => {
      const decided = transition(
        tx,
        changeId,
        ["ChangeStateRefused"],
        [
          {
            _tag: "Declare",
            changeId,
            agentId: command.agentId,
            origin: command.origin,
            ...(command.sketchId === undefined ? {} : { sketchId: command.sketchId }),
            goal: command.goal,
            footprint: command.footprint,
            premises: command.premises,
            ...(command.declaredEffects === undefined
              ? {}
              : { declaredEffects: command.declaredEffects }),
            leaseId,
            preflight: L1_PREFLIGHT,
          },
          { _tag: "Start", workspaceId: grant.workspaceId, baseSha: grant.baseSha },
        ],
      );
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      tx.store.put(
        CHANGE_WORKSPACE,
        changeId,
        encodeHeld({
          workspaceId: grant.workspaceId,
          repo: { namespace: grant.repo.namespace, name: grant.repo.name },
          grantedSha: grant.baseSha,
          projectId: command.projectId,
        }),
      );
      tx.outbox.subscribe(`agent:${command.agentId}`, EVERY_TYPE);
      tx.outbox.subscribe(PRECHECK, ["ChangeSubmitted"]);
      tx.outbox.subscribe(`pool:${command.projectId}`, CHANGE_ENDS);
      return Result.succeed(asTransition(decided.success));
    },
  ).pipe(Effect.onError(() => releaseUnheld(changeId, command.projectId, grant)));
  if (!committed.duplicate) return { change: committed.value, preflight: L1_PREFLIGHT, grant };
  yield* releaseUnheld(changeId, command.projectId, grant);
  if (!committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  const change = storedChange(yield* EntityStore, changeId);
  if (change === undefined) return yield* Effect.die(`${changeId} committed but holds no state`);
  // A retry after the change ended (and its workspace was collected) has no workspace to hand back.
  if (heldWorkspace(yield* EntityStore, changeId)?.workspaceId !== grant.workspaceId)
    return yield* refused(change, "Declare");
  return { change, preflight: L1_PREFLIGHT, grant };
});

/** Revises the intent under the lease, at the revision the caller last read. */
export const revise: (
  changeId: ChangeId,
  command: ReviseChange,
) => Effect.Effect<
  RevisedChange,
  ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox
> = Effect.fn("coordination/revise")(function* (changeId: ChangeId, command: ReviseChange) {
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("revise", command),
      actor: agentActor(command.agentId),
      ...inProject(yield* EntityStore, changeId),
    },
    (tx) =>
      Result.map(
        transition(
          tx,
          changeId,
          ["ChangeNotFound", "LeaseStale", "RevisionMismatch", "ChangeStateRefused"],
          [
            {
              _tag: "Revise",
              leaseId: command.leaseId,
              ifMatchRevision: command.ifMatchRevision,
              ...(command.goal === undefined ? {} : { goal: command.goal }),
              ...(command.footprint === undefined ? {} : { footprint: command.footprint }),
              premisesAdded: command.premisesAdded,
              premisesRetracted: command.premisesRetracted,
              ...(command.declaredEffects === undefined
                ? {}
                : { declaredEffects: command.declaredEffects }),
              preflight: L1_PREFLIGHT,
            },
          ],
          command.leaseId,
        ),
        asTransition,
      ),
  );
  const change = yield* settled(changeId, command.idempotencyKey, committed);
  return { change, preflight: L1_PREFLIGHT };
});

/**
 * Submits a commit under the lease. Whether the commit is in the change's
 * workspace is looked up first, and the domain weighs it after the lease.
 * Commits ChangeSubmitted, which starts Precheck.
 */
export const submit: (
  changeId: ChangeId,
  command: SubmitChange,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | CodeHost
> = Effect.fn("coordination/submit")(function* (changeId: ChangeId, command: SubmitChange) {
  const held = heldWorkspace(yield* EntityStore, changeId);
  // A live change's own workspace repo always exists: its absence is a defect, never the agent's fault.
  const inWorkspace =
    held === undefined
      ? false
      : yield* Effect.orDie((yield* CodeHost).hasCommit(held.repo, command.commitSha));
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("submit", command),
      actor: agentActor(command.agentId),
      ...(held === undefined ? {} : { project: held.projectId }),
    },
    (tx) =>
      Result.map(
        transition(
          tx,
          changeId,
          ["ChangeNotFound", "LeaseStale", "ChangeStateRefused", "CommitNotInWorkspace"],
          [
            {
              _tag: "Submit",
              leaseId: command.leaseId,
              commitSha: command.commitSha,
              inWorkspace,
            },
          ],
          command.leaseId,
        ),
        asTransition,
      ),
  );
  return yield* settled(changeId, command.idempotencyKey, committed);
});

/** Who withdraws: the agent under its lease, or an operator by name. */
const withdrawnBy = (command: AbandonChange): Actor =>
  command.authority._tag === "Operator"
    ? `operator:${command.authority.by}`
    : agentActor(command.agentId);

/** Withdraws the change, under its lease or as an operator. The pool collects its workspace by event. */
export const abandon: (
  changeId: ChangeId,
  command: AbandonChange,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox
> = Effect.fn("coordination/abandon")(function* (changeId: ChangeId, command: AbandonChange) {
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("abandon", command),
      actor: withdrawnBy(command),
      ...inProject(yield* EntityStore, changeId),
    },
    (tx) =>
      Result.map(
        transition(
          tx,
          changeId,
          ["ChangeNotFound", "LeaseStale", "ChangeStateRefused"],
          [
            {
              _tag: "Withdraw",
              authority: command.authority,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
            },
          ],
        ),
        asTransition,
      ),
  );
  return yield* settled(changeId, command.idempotencyKey, committed);
});

/**
 * Adopts a change whose lease has lapsed: a new lease under the same Change-Id
 * fences the old token. Both agents hear of it; then only the adopter is
 * subscribed. The adopter holds no lease yet, so its project is checked
 * against the change's. The answer carries a fresh token for the workspace
 * the change holds (the pool's grant is idempotent per holder), on a replay too,
 * since the first answer's token may have been lost.
 */
export const adopt: (
  changeId: ChangeId,
  command: AdoptChange,
) => Effect.Effect<
  AdoptedChange,
  ChangeNotFound | ChangeStateRefused | LeaseNotLapsed | ChangeInOtherProject | IdempotencyConflict,
  Clock | Ids | EntityStore | EventOutbox | WorkspacePool
> = Effect.fn("coordination/adopt")(function* (changeId: ChangeId, command: AdoptChange) {
  const leaseId = yield* (yield* Ids).next("lse");
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("adopt", command),
      actor: agentActor(command.agentId),
      ...inProject(yield* EntityStore, changeId),
    },
    (
      tx,
    ): Result.Result<
      Transition<Change>,
      ChangeNotFound | ChangeStateRefused | LeaseNotLapsed | ChangeInOtherProject
    > => {
      const before = storedChange(tx.store, changeId);
      const held = heldWorkspace(tx.store, changeId);
      if (before !== undefined && held !== undefined && held.projectId !== command.projectId)
        return Result.fail(new ChangeInOtherProject({ changeId }));
      const decided = transition(
        tx,
        changeId,
        ["ChangeNotFound", "ChangeStateRefused", "LeaseNotLapsed"],
        [
          {
            _tag: "Adopt",
            agentId: command.agentId,
            leaseId,
            // L1's brief is the change itself, as the adopter reads it.
            briefRef: `change:${changeId}@r${before?.intent.revision ?? 0}`,
          },
        ],
      );
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      tx.outbox.subscribe(`agent:${command.agentId}`, EVERY_TYPE);
      const previous = before?.agentId;
      return Result.succeed({
        ...asTransition(decided.success),
        after: (after: Transaction) => {
          if (previous !== undefined && previous !== command.agentId)
            after.outbox.unsubscribe(`agent:${previous}`);
        },
      });
    },
  );
  const change = yield* settled(changeId, command.idempotencyKey, committed);
  const held = heldWorkspace(yield* EntityStore, changeId);
  if (held === undefined) return { change };
  // The pool finds the workspace this change holds and only mints a token: it cannot run out.
  const grant = yield* (yield* WorkspacePool).grant(held.projectId, changeId).pipe(Effect.orDie);
  return { change, grant };
});

/**
 * Moves a change onto trunk's head, so an agent bounced on a textual conflict
 * can merge the trunk it must now build on. The domain decides Rebase first,
 * without committing (the lease, the state, `from` == the change's base), so
 * a refused call pushes nothing. Only then is trunk's head (from the Trunk
 * DO, never the mirror, which lags) put on the workspace's `keel/trunk`, and
 * ChangeRebased committed. A retry of a committed key pushes nothing again.
 */
export const rebase: (
  changeId: ChangeId,
  command: RebaseChange,
) => Effect.Effect<
  RebasedChange,
  | ChangeNotFound
  | LeaseStale
  | ChangeStateRefused
  | IdempotencyConflict
  | PushRejected
  | PackTooLarge,
  Clock | EntityStore | EventOutbox | Trunks | WorkspaceRebaser
> = Effect.fn("coordination/rebase")(function* (changeId: ChangeId, command: RebaseChange) {
  const fingerprint = fingerprintOf("rebase", command);
  const answer = (change: Change): Effect.Effect<RebasedChange, ChangeStateRefused> =>
    change.baseSha === undefined
      ? refused(change, "rebase")
      : Effect.succeed({ change, ref: KEEL_TRUNK_REF, base: change.baseSha });
  const prior = (yield* EventOutbox).committed(changeRef(changeId), command.idempotencyKey);
  if (prior !== undefined)
    return yield* prior.fingerprint === fingerprint
      ? Effect.flatMap(getChange(changeId), answer)
      : Effect.fail(new IdempotencyConflict({ idempotencyKey: command.idempotencyKey }));

  const change = yield* getChange(changeId);
  const held = heldWorkspace(yield* EntityStore, changeId);
  if (held === undefined || change.baseSha === undefined) return yield* refused(change, "rebase");
  const from = change.baseSha;
  const onto = yield* (yield* Trunks).head(held.projectId);
  const rebasing: ChangeCommand = { _tag: "Rebase", leaseId: command.leaseId, from, onto };
  const decided = decideChange(change, rebasing, { now: yield* (yield* Clock).now, changeId });
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    if (isOneOf(["ChangeNotFound", "LeaseStale", "ChangeStateRefused"], refusal))
      return yield* Effect.fail(refusal);
    return yield* Effect.die(
      new Error(`Rebase was refused with ${refusal._tag}`, { cause: refusal }),
    );
  }

  // A live change's own workspace repo always exists: its absence is a defect.
  yield* (yield* WorkspaceRebaser)
    .pushTrunk(held.projectId, held.repo, from, onto)
    .pipe(Effect.catchTag("RepoNotFound", Effect.die));
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint,
      actor: agentActor(command.agentId),
      project: held.projectId,
    },
    (tx) =>
      Result.map(
        transition(
          tx,
          changeId,
          ["ChangeNotFound", "LeaseStale", "ChangeStateRefused"],
          [rebasing],
          command.leaseId,
        ),
        asTransition,
      ),
  );
  return yield* answer(yield* settled(changeId, command.idempotencyKey, committed));
});

/**
 * The lease's deadline came: commits LeaseLapsed (and parks an agent-owned
 * change) if the lease is still the change's, active, and unrenewed for 15
 * minutes; otherwise commits nothing. `cause` is the alarm's `<reason>@<at>`.
 */
export const lapseLease: (
  changeId: ChangeId,
  leaseId: LeaseId,
  cause: string,
) => Effect.Effect<Change, ChangeNotFound | ChangeStateRefused, Clock | EntityStore | EventOutbox> =
  Effect.fn("coordination/lapseLease")(function* (
    changeId: ChangeId,
    leaseId: LeaseId,
    cause: string,
  ) {
    const spec = { entity: changeRef(changeId), cause, ...inProject(yield* EntityStore, changeId) };
    const committed = yield* commit(spec, (tx) =>
      Result.map(
        transition(
          tx,
          changeId,
          ["ChangeNotFound", "ChangeStateRefused"],
          [{ _tag: "Lapse", leaseId }],
        ),
        asTransition,
      ),
    );
    return yield* current(changeId, committed);
  });

/**
 * One of Precheck's commands: idempotent by `instanceId` (the cause is
 * `<instanceId>:<method>`), and refused when Precheck checked a revision other
 * than the change's current one. `before` commits ahead of the change's own
 * events in the same transaction (a refusal's verdict); `alongside` runs once
 * the commands are decided, before the events are appended (a subscription).
 */
const precheckCommand = (
  changeId: ChangeId,
  method: string,
  step: PrecheckStep,
  commands: readonly ChangeCommand[],
  {
    before = [],
    alongside,
  }: {
    readonly before?: readonly EventDraft[];
    readonly alongside?: (tx: Transaction) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const committed = yield* commit(
      {
        entity: changeRef(changeId),
        cause: `${step.instanceId}:${method}`,
        ...inProject(yield* EntityStore, changeId),
      },
      (tx) => {
        const stored = storedChange(tx.store, changeId);
        if (stored !== undefined && stored.intent.revision !== step.revision)
          return Result.fail(refused(stored, method));
        return Result.map(
          transition(tx, changeId, ["ChangeNotFound", "ChangeStateRefused"], commands),
          (decided) => {
            alongside?.(tx);
            return { value: decided.change, drafts: [...before, ...decided.drafts] };
          },
        );
      },
    );
    return { events: committed.events, change: yield* current(changeId, committed) };
  });

/** Precheck has started on the submission: commits PrecheckStarted. */
export const precheckStarted: (
  changeId: ChangeId,
  step: PrecheckStep,
) => Effect.Effect<Change, ChangeNotFound | ChangeStateRefused, Clock | EntityStore | EventOutbox> =
  Effect.fn("coordination/precheckStarted")(function* (changeId: ChangeId, step: PrecheckStep) {
    const started = yield* precheckCommand(changeId, "precheckStarted", step, [
      { _tag: "StartPrecheck", instanceId: step.instanceId },
    ]);
    return started.change;
  });

/**
 * Precheck passed and compiled the Verification Plan: commits PlanCompiled,
 * then, since L1 has no step between the plan and the queue, ChangeQueued on
 * the project's lane in the same transaction, under the machine's guards. The
 * lane is subscribed there to ChangeQueued, ChangeRequeued and the change's
 * ends, so it hears the change it must batch, re-enqueue or drop.
 */
export const planCompiled: (
  changeId: ChangeId,
  plan: CompiledPlan,
) => Effect.Effect<Change, ChangeNotFound | ChangeStateRefused, Clock | EntityStore | EventOutbox> =
  Effect.fn("coordination/planCompiled")(function* (changeId: ChangeId, plan: CompiledPlan) {
    const project = heldWorkspace(yield* EntityStore, changeId)?.projectId;
    const compile: ChangeCommand = {
      _tag: "CompilePlan",
      drift: [],
      planHash: plan.planHash,
      steps: plan.steps,
      costEstimate: plan.costEstimate,
    };
    // A change with no workspace was never declared: CompilePlan alone refuses it.
    if (project === undefined)
      return (yield* precheckCommand(changeId, "planCompiled", plan, [compile])).change;
    const laneId = laneOf(project);
    const compiled = yield* precheckCommand(
      changeId,
      "planCompiled",
      plan,
      [compile, { _tag: "Queue", laneId, blockers: L1_UNBLOCKED }],
      { alongside: (tx) => tx.outbox.subscribe(laneId, LANE_HEARS) },
    );
    return compiled.change;
  });

/**
 * Precheck refused the submission: issues a ruling-class verdict on its own
 * entity (outcome `bounce`, Precheck's reasons as its evidence, and no plan
 * hash, because no plan was compiled) and bounces the change naming it, in one
 * transaction. A replay answers the verdict the first commit issued.
 */
export const precheckRefused: (
  changeId: ChangeId,
  refusal: PrecheckRefusal,
) => Effect.Effect<
  { readonly change: Change; readonly verdictId: VerdictId },
  ChangeNotFound | ChangeStateRefused,
  Clock | Ids | EntityStore | EventOutbox
> = Effect.fn("coordination/precheckRefused")(function* (
  changeId: ChangeId,
  refusal: PrecheckRefusal,
) {
  const minted = yield* (yield* Ids).next("vrd");
  const verdict = VerdictIssued.make({
    verdictId: minted,
    subject: changeId,
    outcome: "bounce",
    evidence: refusal.reasons,
  });
  const bounced = yield* precheckCommand(
    changeId,
    "precheckRefused",
    refusal,
    [
      {
        _tag: "Bounce",
        verdictId: minted,
        reasons: refusal.reasons,
        nextActions: refusal.nextActions,
      },
    ],
    {
      before: [
        { entity: { kind: "verdict", id: minted }, payload: payloadOf(encodeVerdict(verdict)) },
      ],
    },
  );
  // A replay finds the cause's events on the change, whose ChangeBounced names the verdict it issued.
  const bounce = bounced.events.find((event) => event.type === "ChangeBounced");
  return {
    change: bounced.change,
    verdictId: bounce === undefined ? minted : decodeBounced(bounce.payload).verdictId,
  };
});

/** A verdict the change heard on its batch: its evidence, and what to do about it when the issuer said. */
const BatchVerdict = Schema.Struct({
  evidence: Schema.Array(Schema.String),
  nextActions: Schema.optional(Schema.Array(NextAction)),
});

const decodeBatchVerdict = Schema.decodeUnknownSync(BatchVerdict);
const encodeBatchVerdict = Schema.encodeSync(BatchVerdict);
const decodeFormed = Schema.decodeUnknownOption(BatchFormed);
const decodeFailed = Schema.decodeUnknownOption(BatchFailed);
const decodeBisected = Schema.decodeUnknownOption(CandidateBisected);
const decodeInvalidated = Schema.decodeUnknownOption(CandidateInvalidated);
const decodeVerdict = Schema.decodeUnknownOption(VerdictIssued);
const decodeAdvanced = Schema.decodeUnknownOption(TrunkAdvanced);

/** Every refusal a reaction may meet: none crosses as a defect, which would be redelivered forever. */
const REACTION_REFUSALS: readonly Tag[] = [
  "ChangeNotFound",
  "ChangeStateRefused",
  "ChangeBlocked",
  "LeaseStale",
  "LeaseNotLapsed",
  "RevisionMismatch",
  "CommitNotInWorkspace",
];

/** The bounce a failed batch attributed to this change: the reasons and next actions of the verdict it heard. */
const bounceFor = (
  store: Store,
  failed: typeof BatchFailed.Type,
): { readonly command: ChangeCommand; readonly problem?: string } => {
  const stored = store.get(CHANGE_BATCH_VERDICT, failed.verdictId);
  const verdict = stored === undefined ? undefined : decodeBatchVerdict(stored);
  return {
    command: {
      _tag: "Bounce",
      verdictId: failed.verdictId,
      reasons: verdict?.evidence ?? [`verdict ${failed.verdictId}`],
      // Empty: the machine's own "fix and submit" is the fallback.
      nextActions: verdict?.nextActions ?? [],
      batchId: failed.batchId,
    },
    ...(verdict === undefined
      ? {
          problem: `batch ${failed.batchId} failed naming verdict ${failed.verdictId}, never heard`,
        }
      : {}),
  };
};

/**
 * What the change does about an event on its batch or trunk, given the change
 * it is. A VerdictIssued on its batch is kept for the BatchFailed that follows
 * it in the same commit (delivered in commit order); a TrunkAdvanced lands it
 * from its own landing, never another member's; every other event maps to the
 * machine's command, or to nothing.
 */
const commandFor = (
  store: Store,
  change: Change,
  event: EventEnvelope,
): { readonly command: ChangeCommand; readonly problem?: string } | undefined => {
  const ours = (batchId: string) => change.batchId !== undefined && batchId === change.batchId;
  switch (event.type) {
    case "BatchFormed": {
      const formed = decodeFormed(event.payload);
      return Option.isSome(formed) && formed.value.members.includes(change.id)
        ? { command: { _tag: "Batch", batchId: formed.value.batchId, blockers: L1_UNBLOCKED } }
        : undefined;
    }
    case "VerdictIssued": {
      const verdict = decodeVerdict(event.payload);
      if (Option.isNone(verdict) || !ours(verdict.value.subject)) return undefined;
      const { verdictId, evidence, nextActions } = verdict.value;
      store.put(
        CHANGE_BATCH_VERDICT,
        verdictId,
        asStored(
          encodeBatchVerdict({
            evidence,
            ...(nextActions === undefined ? {} : { nextActions }),
          }),
        ),
      );
      return undefined;
    }
    case "BatchFailed": {
      const failed = decodeFailed(event.payload);
      if (Option.isNone(failed) || !ours(failed.value.batchId)) return undefined;
      if (failed.value.attribution === change.id) return bounceFor(store, failed.value);
      if (failed.value.attribution === "infra")
        return {
          command: { _tag: "Requeue", batchId: failed.value.batchId, reason: "infra-failure" },
        };
      // Another member, or not yet attributed: bisection or the lane moves the change next.
      return undefined;
    }
    case "CandidateBisected": {
      const bisected = decodeBisected(event.payload);
      return Option.isSome(bisected) && ours(bisected.value.batchId)
        ? { command: { _tag: "Requeue", batchId: bisected.value.batchId, reason: "bisection" } }
        : undefined;
    }
    case "CandidateInvalidated": {
      const invalidated = decodeInvalidated(event.payload);
      return Option.isSome(invalidated) && ours(invalidated.value.batchId)
        ? {
            command: { _tag: "Requeue", batchId: invalidated.value.batchId, reason: "invalidated" },
          }
        : undefined;
    }
    case "TrunkAdvanced": {
      const advanced = decodeAdvanced(event.payload);
      if (Option.isNone(advanced)) return undefined;
      const landing = advanced.value.landings.find((each) => each.changeId === change.id);
      return landing === undefined
        ? undefined
        : {
            command: {
              _tag: "Land",
              commitSha: landing.commitSha,
              trunkSha: advanced.value.to,
              candidateId: landing.candidateId,
              proofId: landing.proofId,
            },
          };
    }
    default:
      return undefined;
  }
};

/** What a reaction to the change's batch commits, and anything wrong with it worth an alert. */
export interface BatchReaction {
  readonly drafts: readonly EventDraft[];
  readonly project?: ProjectId;
  readonly problem?: string;
}

/**
 * The Change DO's reaction to its batch's events, inside the
 * transaction that records the delivery: BatchFormed naming it → ChangeBatched;
 * BatchFailed attributed to it → ChangeBounced with the verdict's reasons and
 * next actions; BatchFailed `infra`, CandidateBisected or CandidateInvalidated
 * → ChangeRequeued. The cause is the delivery's dedupe key, so a redelivery is
 * a no-op. A refusal by the machine commits nothing and is reported as a
 * `problem`: a reaction never fails the delivery, which would be redelivered
 * forever. Undefined when the event is none of these.
 */
export const reactToBatch = (
  changeId: ChangeId,
  event: EventEnvelope,
  tx: Transaction,
): BatchReaction | undefined => {
  const change = storedChange(tx.store, changeId);
  if (change === undefined) return undefined;
  const reacting = commandFor(tx.store, change, event);
  if (reacting === undefined) return { drafts: [] };
  const decided = transition(tx, changeId, REACTION_REFUSALS, [reacting.command]);
  if (Result.isFailure(decided))
    return {
      drafts: [],
      problem: `${event.type} refused with ${decided.failure._tag} in state ${change.state}`,
    };
  return {
    drafts: decided.success.drafts,
    ...inProject(tx.store, changeId),
    ...(reacting.problem === undefined ? {} : { problem: reacting.problem }),
  };
};
