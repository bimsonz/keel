import { Effect, Result, Schema } from "effect";
import {
  type Blockers,
  Change,
  type ChangeCommand,
  ChangeBounced,
  ChangeEvent,
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
  type Actor,
  type AgentId,
  agentActor,
  type ChangeId,
  CommitSha,
  type ContentHash,
  contentHashOf,
  type EntityRef,
  type Json,
  type LeaseId,
  type NextAction,
  ProjectId,
  type SketchId,
  type VerdictId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import { VerdictIssued } from "../../domain/verification/index.ts";
import {
  type Clock,
  CodeHost,
  commit,
  type Committed,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  EVERY_TYPE,
  Ids,
  type Stored,
  type SubmissionStatus,
  type Transaction,
  WorkspacePool,
  type WorkspaceGrant,
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

/** The workspace a change holds: Precheck diffs `repo` against `baseSha`, and reads `projectId`'s settings. */
export const HeldWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  repo: Schema.Struct({ namespace: Schema.String, name: Schema.String }),
  baseSha: CommitSha,
  projectId: ProjectId,
});
export type HeldWorkspace = typeof HeldWorkspace.Type;

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

export interface AdoptChange {
  readonly agentId: AgentId;
  readonly idempotencyKey: string;
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

/** The change's submission as it stands: the change, and the commit last submitted for it. */
export const submissionStatus: (
  changeId: ChangeId,
) => Effect.Effect<SubmissionStatus, ChangeNotFound, EntityStore> = Effect.fn(
  "coordination/submissionStatus",
)(function* (changeId: ChangeId) {
  const change = yield* getChange(changeId);
  return { change, commitSha: change.commitSha ?? null };
});

/** The workspace the change holds, for Precheck's diff. ChangeStateRefused before it holds one. */
export const changeWorkspace: (
  changeId: ChangeId,
) => Effect.Effect<HeldWorkspace, ChangeNotFound | ChangeStateRefused, EntityStore> = Effect.fn(
  "coordination/changeWorkspace",
)(function* (changeId: ChangeId) {
  const change = yield* getChange(changeId);
  const held = heldWorkspace(yield* EntityStore, changeId);
  if (held === undefined) return yield* refused(change, "workspace");
  return held;
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
          baseSha: grant.baseSha,
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
 * fences the old token. Both agents hear of it; then only the adopter is subscribed.
 */
export const adopt: (
  changeId: ChangeId,
  command: AdoptChange,
) => Effect.Effect<
  Change,
  ChangeNotFound | ChangeStateRefused | LeaseNotLapsed | IdempotencyConflict,
  Clock | Ids | EntityStore | EventOutbox
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
    (tx) => {
      const before = storedChange(tx.store, changeId);
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
  return yield* settled(changeId, command.idempotencyKey, committed);
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
 * lane is subscribed to ChangeQueued there, so it hears the change it must batch.
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
      { alongside: (tx) => tx.outbox.subscribe(laneId, ["ChangeQueued"]) },
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
