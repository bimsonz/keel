import { Effect, Option, Result, Schema } from "effect";
import {
  canonicalProposition,
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
  type DerivedEffect,
  evolveChange,
  type FootprintEntry,
  type LeaseNotLapsed,
  type LeaseStale,
  type Intent,
  type IntentRevision,
  type LiveChange,
  type PoolExhausted,
  type PredicatePolicies,
  Preflight,
  type Proposition,
  renew,
  reviseIntent,
  type RevisionMismatch,
  type SubjectKey,
  subjectAncestors,
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
  type ConflictId,
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
import { ConflictProven, VerdictIssued } from "../../domain/verification/index.ts";
import {
  type ChangeRead,
  Clock,
  CodeHost,
  commit,
  type Committed,
  EntityStore,
  type EventDraft,
  EventOutbox,
  EVERY_TYPE,
  Ids,
  LiveChanges,
  type Remedy,
  type Stored,
  type Subscriber,
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
import { submissionStateOf } from "../verification/index.ts";
import { subjectIdOf } from "./hashed-id.ts";
import { blockersOf, hearConflict, partyConflictOf, policyFor } from "./party-conflicts.ts";
import { preflightFor } from "./preflight.ts";

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
  /** The subject of each premise and declared effect of the current intent, each once and without ancestors. */
  readonly subjects: readonly SubjectKey[];
  /** The change's current intent: Precheck derives its effects against what it declared. */
  readonly intent: Intent;
}

/** The subjects an intent's premises and declared effects name, each once: what Precheck compiles the plan's guards against. */
export const intentSubjects = (
  intent: Pick<Intent, "premises" | "declaredEffects">,
): readonly SubjectKey[] => [
  ...new Set(
    [...intent.premises, ...(intent.declaredEffects ?? [])].map(
      (proposition) => proposition.subject,
    ),
  ),
];

/** The lane a project's changes queue on: at L1, one lane per project, for trunk's `main`. */
export const laneOf = (projectId: ProjectId): string => `lane:${projectId}:main`;

/** Precheck starts once per ChangeSubmitted, as `precheck-<eventId>`. */
export const PRECHECK = "workflow:Precheck";
/** The events after which the change's pool collects its workspace. */
export const CHANGE_ENDS = ["ChangeLanded", "ChangeWithdrawn", "ChangeSuperseded"] as const;

/**
 * The events its project's live-change index hears of each change, subscribed
 * at declare: the intent and its effects, each preflight (who has been shown
 * which alternative), an adoption (whose agent hears the change's notices) and
 * the end.
 */
export const LIVE_INDEX_HEARS = [
  "IntentDeclared",
  "IntentRevised",
  "EffectsDerived",
  "PreflightIssued",
  "ChangeAdopted",
  ...CHANGE_ENDS,
] as const;

/** What a Subject DO hears of each change relying on or affecting its key, or a key beneath it. */
export const SUBJECT_HEARS = [
  "IntentDeclared",
  "IntentRevised",
  "EffectsDerived",
  "ChangeAdopted",
  ...CHANGE_ENDS,
] as const;

/** A project's Subject DO for a key. */
export const subjectAddress = (projectId: ProjectId, key: SubjectKey): string =>
  `subj:${projectId}:${key}`;

/**
 * Every subject an intent's premises and declared effects name, with each
 * one's ancestors: the Subject DOs that keep the change. Relying is subscribing.
 */
export function subjectKeysOf(
  intent: Pick<Intent, "premises" | "declaredEffects">,
): readonly SubjectKey[] {
  const keys = new Set<SubjectKey>();
  for (const proposition of [...intent.premises, ...(intent.declaredEffects ?? [])])
    for (const key of [proposition.subject, ...subjectAncestors(proposition.subject)])
      keys.add(key);
  return [...keys];
}
/**
 * What the change's lane hears from it: each queueing, each requeue (the lane
 * re-enqueues only then, never by itself), and a bounce or an end that drops
 * it from the queue.
 */
export const LANE_HEARS = [
  "ChangeQueued",
  "ChangeRequeued",
  "ChangeBounced",
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

/** Add one premise under the lease: a revision of one, and a subscription to its subject. */
export interface RelyChange {
  readonly agentId: AgentId;
  readonly leaseId: LeaseId;
  readonly premise: Proposition;
  readonly idempotencyKey: string;
}

/** Read what is near a change: the reader's project, from its token, must be the change's. */
export interface NearbyChange {
  readonly projectId: ProjectId;
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
  /** Per predicate, what a conflict proven against the change does; absent, or a predicate left out, is `advise`. */
  readonly predicatePolicy?: PredicatePolicies | undefined;
}

/** What Precheck derived from the submission's code: the effects, and its own reference for the derivation. */
export interface DerivedEffects extends PrecheckStep {
  readonly effects: readonly DerivedEffect[];
  readonly derivationRef: string;
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

const decodePreflight = Schema.decodeUnknownSync(Preflight);

/** The preflight a committed declare, revise or rely issued: what its retry answers. */
function issuedPreflight(events: readonly EventEnvelope[]): Preflight {
  const issued = events.find((event) => event.type === "PreflightIssued");
  if (issued === undefined) throw new Error("the commit issued no preflight");
  return decodePreflight(issued.payload);
}

/**
 * Propositions in the canonical form the Change machine commits them in (an
 * ordering written from its lesser event), so the intent a command leaves is
 * preflighted, and its subjects subscribed, as it will be stored.
 */
const canonical = (propositions: readonly Proposition[]): readonly Proposition[] =>
  propositions.map(canonicalProposition);

/** The project's live changes, read once before a command's commit; none for a change that holds no workspace. */
const liveOf = (projectId: ProjectId | undefined) =>
  projectId === undefined
    ? Effect.succeed<readonly LiveChange[]>([])
    : LiveChanges.use((index) => index.of(projectId));

/**
 * Subscribes the Subject DO of every key the intent names (ancestors
 * included) to the change, scoped to it. Subscribing again is a no-op, and a
 * subject the change stops naming keeps hearing it, and drops it.
 */
function subscribeSubjects(
  tx: Transaction,
  changeId: ChangeId,
  intent: Pick<Intent, "premises" | "declaredEffects">,
): void {
  const projectId = heldWorkspace(tx.store, changeId)?.projectId;
  if (projectId === undefined) return;
  for (const key of subjectKeysOf(intent))
    tx.outbox.subscribe(subjectAddress(projectId, key), SUBJECT_HEARS, changeRef(changeId));
}

const readChange = (changeId: ChangeId): NextAction => ({
  kind: "read",
  title: "Read the change for its current state, revision and lease",
  operationId: "change",
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
 * The change with its project, as `Changes.get` answers. Declare records the
 * project with the workspace in the change's own transaction and nothing
 * removes it, so a change without one is a defect.
 */
export const changeRead: (
  changeId: ChangeId,
) => Effect.Effect<ChangeRead, ChangeNotFound, EntityStore> = Effect.fn("coordination/changeRead")(
  function* (changeId: ChangeId) {
    const change = yield* getChange(changeId);
    const projectId = heldWorkspace(yield* EntityStore, changeId)?.projectId;
    if (projectId === undefined) return yield* Effect.die(`${changeId} has no project recorded`);
    return { change, projectId };
  },
);

/** What a waiter on a change's submission hears, once: its next submission, or its end before one. */
export const AWAIT_SUBMISSION_HEARS = [
  "ChangeSubmitted",
  "ChangeWithdrawn",
  "ChangeSuperseded",
] as const;

/** `awaitSubmission`'s answer when there is nothing to read yet: the subscriber will be told. */
export interface AwaitingSubmission {
  readonly waiting: true;
}

/**
 * The change with its project when `submissionStateOf` reads anything but
 * Unsubmitted from it: a current submission, its landing, or its end.
 * Otherwise `waiting`, with `subscriber` subscribed once, in the same
 * transaction as the read, to the change's next ChangeSubmitted,
 * ChangeWithdrawn or ChangeSuperseded: whatever commits after this read
 * notifies it, so nothing falls between a read and a subscribe. The Probe
 * reads the answer with the same rule, so it never waits unsubscribed.
 */
export const awaitSubmission: (
  changeId: ChangeId,
  subscriber: Subscriber,
) => Effect.Effect<ChangeRead | AwaitingSubmission, ChangeNotFound, EntityStore | EventOutbox> =
  Effect.fn("coordination/awaitSubmission")(function* (changeId: ChangeId, subscriber: Subscriber) {
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const found = store.transaction(() => {
      const change = storedChange(store, changeId);
      if (change === undefined) return { _tag: "missing" } as const;
      const projectId = heldWorkspace(store, changeId)?.projectId;
      if (projectId === undefined) return { _tag: "unprojected" } as const;
      if (submissionStateOf(change)._tag !== "Unsubmitted")
        return { _tag: "read", read: { change, projectId } } as const;
      outbox.subscribe(subscriber, AWAIT_SUBMISSION_HEARS, changeRef(changeId), { once: true });
      return { _tag: "waiting" } as const;
    });
    if (found._tag === "missing") return yield* notFound(changeId);
    if (found._tag === "unprojected")
      return yield* Effect.die(`${changeId} has no project recorded`);
    return found._tag === "read" ? found.read : ({ waiting: true } as const);
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
      const { verdictId, conflictId, reasons, nextActions } = decodeBounced(event.payload);
      remedy = {
        ...(verdictId === undefined ? {} : { verdictId }),
        ...(conflictId === undefined ? {} : { conflictId }),
        reasons,
        nextActions: nextActions ?? [],
      };
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
  return {
    ...held,
    baseSha: change.baseSha,
    subjects: intentSubjects(change.intent),
    intent: change.intent,
  };
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
  Clock | Ids | EntityStore | EventOutbox | WorkspacePool | LiveChanges
> = Effect.fn("coordination/declare")(function* (command: DeclareChange) {
  const { changeId } = command;
  const leaseId = yield* (yield* Ids).next("lse");
  const live = yield* liveOf(command.projectId);
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
      const intent: Intent = {
        revision: 1,
        goal: command.goal,
        footprint: command.footprint,
        premises: canonical(command.premises),
        ...(command.declaredEffects === undefined
          ? {}
          : { declaredEffects: canonical(command.declaredEffects) }),
      };
      const { preflight } = preflightFor(changeId, intent, live);
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
            preflight,
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
      tx.outbox.subscribe(`project:${command.projectId}`, LIVE_INDEX_HEARS, changeRef(changeId));
      subscribeSubjects(tx, changeId, intent);
      return Result.succeed(asTransition(decided.success));
    },
  ).pipe(Effect.onError(() => releaseUnheld(changeId, command.projectId, grant)));
  if (!committed.duplicate)
    return { change: committed.value, preflight: issuedPreflight(committed.events), grant };
  yield* releaseUnheld(changeId, command.projectId, grant);
  if (!committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  const change = storedChange(yield* EntityStore, changeId);
  if (change === undefined) return yield* Effect.die(`${changeId} committed but holds no state`);
  // A retry after the change ended (and its workspace was collected) has no workspace to hand back.
  if (heldWorkspace(yield* EntityStore, changeId)?.workspaceId !== grant.workspaceId)
    return yield* refused(change, "Declare");
  return { change, preflight: issuedPreflight(committed.events), grant };
});

/** Revises the intent under the lease, at the revision the caller last read. */
export const revise: (
  changeId: ChangeId,
  command: ReviseChange,
) => Effect.Effect<
  RevisedChange,
  ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | LiveChanges
> = Effect.fn("coordination/revise")(function* (changeId: ChangeId, command: ReviseChange) {
  const live = yield* liveOf(heldWorkspace(yield* EntityStore, changeId)?.projectId);
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("revise", command),
      actor: agentActor(command.agentId),
      ...inProject(yield* EntityStore, changeId),
    },
    (tx) => {
      const after = intentAfter(tx, changeId, {
        ...(command.goal === undefined ? {} : { goal: command.goal }),
        ...(command.footprint === undefined ? {} : { footprint: command.footprint }),
        premisesAdded: command.premisesAdded,
        premisesRetracted: command.premisesRetracted,
        ...(command.declaredEffects === undefined
          ? {}
          : { declaredEffects: command.declaredEffects }),
      });
      const decided = transition(
        tx,
        changeId,
        ["ChangeNotFound", "LeaseStale", "RevisionMismatch", "ChangeStateRefused"],
        [
          {
            _tag: "Revise",
            preflight: preflightOf(changeId, after, live),
            leaseId: command.leaseId,
            ifMatchRevision: command.ifMatchRevision,
            ...(command.goal === undefined ? {} : { goal: command.goal }),
            ...(command.footprint === undefined ? {} : { footprint: command.footprint }),
            premisesAdded: command.premisesAdded,
            premisesRetracted: command.premisesRetracted,
            ...(command.declaredEffects === undefined
              ? {}
              : { declaredEffects: command.declaredEffects }),
          },
        ],
        command.leaseId,
      );
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      if (after !== undefined) subscribeSubjects(tx, changeId, after);
      return Result.succeed(asTransition(decided.success));
    },
  );
  const change = yield* settled(changeId, command.idempotencyKey, committed);
  return { change, preflight: issuedPreflight(committed.events) };
});

/**
 * Adds one premise under the lease: the domain's Rely, a revision of one
 * whose preflight reads the intent it leaves. Relying is subscribing: the
 * premise's subject and its ancestors hear the change from now on.
 */
export const rely: (
  changeId: ChangeId,
  command: RelyChange,
) => Effect.Effect<
  RevisedChange,
  ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | LiveChanges
> = Effect.fn("coordination/rely")(function* (changeId: ChangeId, command: RelyChange) {
  const live = yield* liveOf(heldWorkspace(yield* EntityStore, changeId)?.projectId);
  const committed = yield* commit(
    {
      entity: changeRef(changeId),
      cause: command.idempotencyKey,
      fingerprint: fingerprintOf("rely", command),
      actor: agentActor(command.agentId),
      ...inProject(yield* EntityStore, changeId),
    },
    (tx) => {
      const after = intentAfter(tx, changeId, {
        premisesAdded: [command.premise],
        premisesRetracted: [],
      });
      const decided = transition(
        tx,
        changeId,
        ["ChangeNotFound", "LeaseStale", "ChangeStateRefused"],
        [
          {
            _tag: "Rely",
            leaseId: command.leaseId,
            premise: command.premise,
            preflight: preflightOf(changeId, after, live),
          },
        ],
        command.leaseId,
      );
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      subscribeSubjects(tx, changeId, { premises: canonical([command.premise]) });
      return Result.succeed(asTransition(decided.success));
    },
  );
  const change = yield* settled(changeId, command.idempotencyKey, committed);
  return { change, preflight: issuedPreflight(committed.events) };
});

/**
 * What is near a change now: the preflight of its stored intent against its
 * project's live changes. Read-only: it commits nothing. Only an agent of the
 * change's project may read it.
 */
export const nearby: (
  changeId: ChangeId,
  command: NearbyChange,
) => Effect.Effect<Preflight, ChangeNotFound | ChangeInOtherProject, EntityStore | LiveChanges> =
  Effect.fn("coordination/nearby")(function* (changeId: ChangeId, command: NearbyChange) {
    const store = yield* EntityStore;
    const change = storedChange(store, changeId);
    if (change === undefined) return yield* notFound(changeId);
    const projectId = heldWorkspace(store, changeId)?.projectId;
    if (projectId !== command.projectId) return yield* new ChangeInOtherProject({ changeId });
    return preflightFor(changeId, change.intent, yield* liveOf(projectId)).preflight;
  });

/**
 * The intent a revision would leave: the change's stored intent revised as
 * asked, its propositions canonical as the machine will commit them. Undefined for a change with no state, which the domain refuses
 * before its preflight matters.
 */
function intentAfter(
  tx: Transaction,
  changeId: ChangeId,
  revision: Omit<IntentRevision, "revision">,
): Intent | undefined {
  const change = storedChange(tx.store, changeId);
  if (change === undefined) return undefined;
  return reviseIntent(change.intent, {
    ...revision,
    premisesAdded: canonical(revision.premisesAdded),
    premisesRetracted: canonical(revision.premisesRetracted),
    ...(revision.declaredEffects === undefined
      ? {}
      : { declaredEffects: canonical(revision.declaredEffects) }),
    revision: change.intent.revision + 1,
  });
}

/** The preflight of an intent against the project's live changes; nothing to find for a change with no state. */
const preflightOf = (
  changeId: ChangeId,
  intent: Intent | undefined,
  live: readonly LiveChange[],
): Preflight =>
  intent === undefined
    ? { neighbours: [], contradictions: [], precedents: [], suggestedMove: "proceed" }
    : preflightFor(changeId, intent, live).preflight;

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
 * than the change's current one. `commands` may read the change's store
 * inside the transaction (its blockers). `before` commits ahead of the
 * change's own events in the same transaction (a refusal's verdict);
 * `alongside` runs once the commands are decided, before the events are
 * appended (a subscription); `affected` goes on each of the change's own
 * events.
 */
const precheckCommand = (
  changeId: ChangeId,
  method: string,
  step: PrecheckStep,
  commands: readonly ChangeCommand[] | ((store: Store) => readonly ChangeCommand[]),
  {
    before = [],
    alongside,
    affected,
  }: {
    readonly before?: readonly EventDraft[];
    readonly alongside?: (tx: Transaction) => void;
    readonly affected?: readonly EntityRef[];
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
          transition(
            tx,
            changeId,
            ["ChangeNotFound", "ChangeStateRefused"],
            typeof commands === "function" ? commands(tx.store) : commands,
          ),
          (decided) => {
            alongside?.(tx);
            const own =
              affected === undefined
                ? decided.drafts
                : decided.drafts.map((draft) => ({ ...draft, affected }));
            return { value: decided.change, drafts: [...before, ...own] };
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
 * Precheck derived the submission's effects from its code: commits
 * EffectsDerived, once per Precheck pass (a second derivation in the pass is
 * ChangeStateRefused, and a replay of this one answers the change as it
 * stands). The event names each derived effect's subject as affected, and in
 * the same transaction the change subscribes those subjects and their
 * ancestors, scoped to itself: a subject the intent never named hears this
 * very event, and judges the effect against the premises it holds.
 */
export const effectsDerived: (
  changeId: ChangeId,
  derived: DerivedEffects,
) => Effect.Effect<Change, ChangeNotFound | ChangeStateRefused, Clock | EntityStore | EventOutbox> =
  Effect.fn("coordination/effectsDerived")(function* (changeId: ChangeId, derived: DerivedEffects) {
    const project = heldWorkspace(yield* EntityStore, changeId)?.projectId;
    const effects = derived.effects.map((effect) => ({
      ...effect,
      proposition: canonicalProposition(effect.proposition),
    }));
    const named = { premises: [], declaredEffects: effects.map((effect) => effect.proposition) };
    const recorded = yield* precheckCommand(
      changeId,
      "effectsDerived",
      derived,
      [{ _tag: "DeriveEffects", effects, derivationRef: derived.derivationRef }],
      {
        affected:
          project === undefined
            ? []
            : intentSubjects(named).map((key) => ({
                kind: "subject",
                id: subjectIdOf(project, key),
              })),
        alongside: (tx) => subscribeSubjects(tx, changeId, named),
      },
    );
    return recorded.change;
  });

/**
 * A bounce citing the first, by id, of the proven conflicts that block the
 * change, and naming them all; the domain gives it that conflict's next
 * actions. Undefined when nothing blocks.
 */
const conflictBounce = (blocking: readonly ConflictId[]): ChangeCommand | undefined => {
  const [conflictId] = blocking.toSorted();
  return conflictId === undefined
    ? undefined
    : {
        _tag: "Bounce",
        conflictId,
        reasons: [
          `Proven against this change, whose plan blocks on its predicate: ${blocking.toSorted().join(", ")}.`,
        ],
        nextActions: [],
      };
};

/**
 * Precheck passed and compiled the Verification Plan: commits PlanCompiled,
 * which keeps the plan's predicate policy on the change, then, since L1 has
 * no step between the plan and the queue, ChangeQueued on the project's lane
 * in the same transaction. A conflict proven against the change under the
 * plan's `block` policy bounces it instead, citing the conflict. The lane is
 * subscribed there to ChangeQueued, ChangeRequeued, ChangeBounced and the
 * change's ends, so it hears the change it must batch, re-enqueue or drop.
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
      ...(plan.predicatePolicy === undefined ? {} : { predicatePolicy: plan.predicatePolicy }),
    };
    // A change with no workspace was never declared: CompilePlan alone refuses it.
    if (project === undefined)
      return (yield* precheckCommand(changeId, "planCompiled", plan, [compile])).change;
    const laneId = laneOf(project);
    const compiled = yield* precheckCommand(
      changeId,
      "planCompiled",
      plan,
      (store) => {
        const blockers = blockersOf(store, plan.predicatePolicy);
        const bounce = conflictBounce(blockers.openProvenConflicts);
        return [compile, bounce ?? { _tag: "Queue", laneId, blockers }];
      },
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
    verdictId:
      (bounce === undefined ? undefined : decodeBounced(bounce.payload).verdictId) ?? minted,
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

/** Where a conflict proven against the change can still bounce it: past its plan, and not yet in a batch. */
const CONFLICT_BOUNCEABLE: ReadonlySet<Change["state"]> = new Set([
  "deriving",
  "verifying",
  "queued",
]);

const decodeProven = Schema.decodeUnknownOption(ConflictProven);

/**
 * A conflict proven against the change, under the predicate policy its latest
 * plan compiled: `block` bounces it citing the conflict while it is deriving,
 * verifying or queued; `advise` and `annotate` note it, with the probe as its
 * evidence (an annotation notifies no one). Under `block` a change already in
 * a batch lands: the batch formed past its blockers, and the domain never
 * bounces a member for a conflict, so the proof is only logged here. A
 * conflict it never heard open has no predicate to note it by.
 */
const provenAgainst = (
  store: Store,
  change: Change,
  event: EventEnvelope,
): { readonly command?: ChangeCommand; readonly problem?: string } | undefined => {
  const proven = decodeProven(event.payload);
  if (Option.isNone(proven)) return undefined;
  const { conflictId, evidence } = proven.value;
  const predicate = partyConflictOf(store, conflictId)?.predicate;
  const policy = policyFor(change.predicatePolicy, predicate);
  if (policy === "block") {
    const bounce = conflictBounce([conflictId]);
    if (bounce !== undefined && CONFLICT_BOUNCEABLE.has(change.state)) return { command: bounce };
    return change.state === "integrating"
      ? {
          problem: `${conflictId} was proven against ${change.id} while it integrates in ${change.batchId}; it lands`,
        }
      : undefined;
  }
  if (predicate === undefined)
    return { problem: `${conflictId} was proven against ${change.id} unheard` };
  return {
    command: {
      _tag: "NoteConflict",
      conflictId,
      predicate,
      policy,
      ...(evidence._tag === "probe" ? { evidenceRef: `probe:${evidence.probeId}` } : {}),
    },
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
): { readonly command?: ChangeCommand; readonly problem?: string } | undefined => {
  const ours = (batchId: string) => change.batchId !== undefined && batchId === change.batchId;
  switch (event.type) {
    case "BatchFormed": {
      const formed = decodeFormed(event.payload);
      return Option.isSome(formed) && formed.value.members.includes(change.id)
        ? {
            command: {
              _tag: "Batch",
              batchId: formed.value.batchId,
              blockers: blockersOf(store, change.predicatePolicy),
            },
          }
        : undefined;
    }
    case "ConflictProven":
      hearConflict(store, event);
      return provenAgainst(store, change, event);
    case "ConflictSuspected":
    case "ConflictDismissed":
    case "ConflictEscalated":
    case "ConflictResolved":
      // The change keeps the conflicts it is a party to; its queue and batch read them as blockers.
      hearConflict(store, event);
      return undefined;
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
  if (reacting.command === undefined)
    return { drafts: [], ...(reacting.problem === undefined ? {} : { problem: reacting.problem }) };
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
