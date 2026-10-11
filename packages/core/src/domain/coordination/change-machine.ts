import { Result, Schema } from "effect";
import {
  type AgentId,
  type BatchId,
  type CandidateId,
  type ChangeId,
  type CommitSha,
  type Committed,
  type ConflictId,
  type ContentHash,
  type DecisionId,
  type EscalationId,
  type GuardId,
  IllegalTransition,
  type Instant,
  type LeaseId,
  type NextAction,
  type SketchId,
  type VerdictId,
  type WorkspaceId,
} from "../kernel/index.ts";
import {
  type Change,
  type ChangeOrigin,
  type ChangeState,
  isAgentOwned,
  TERMINAL,
} from "./change.ts";
import type { DerivedEffect, Drift } from "./derivation.ts";
import {
  ChangeBlocked,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseNotLapsed,
  type LeaseStale,
  RevisionMismatch,
} from "./errors.ts";
import {
  ChangeAdopted,
  ChangeBatched,
  ChangeBounced,
  ChangeDrifted,
  ChangeLanded,
  ChangeParked,
  ChangeQueued,
  ChangeRequeued,
  ChangeResumed,
  ChangeStarted,
  ChangeSubmitted,
  ChangeSuperseded,
  ChangeWithdrawn,
  DriftDetected,
  EffectsDerived,
  IntentDeclared,
  IntentRevised,
  LeaseLapsed,
  PlanCompiled,
  PrecheckStarted,
  PreflightIssued,
} from "./events.ts";
import { reviseIntent } from "./intent.ts";
import { checkLease, isLapsed, lapsesAt } from "./lease.ts";
import type { Preflight } from "./preflight.ts";
import type { FootprintEntry, Proposition } from "./proposition.ts";

/** The events a Change DO commits for a change and its lease, in the order `evolve` folds them. */
export const ChangeEvent = Schema.Union([
  IntentDeclared,
  PreflightIssued,
  IntentRevised,
  ChangeStarted,
  ChangeSubmitted,
  PrecheckStarted,
  EffectsDerived,
  DriftDetected,
  ChangeDrifted,
  PlanCompiled,
  ChangeQueued,
  ChangeBatched,
  ChangeRequeued,
  ChangeLanded,
  ChangeBounced,
  ChangeParked,
  ChangeResumed,
  ChangeAdopted,
  ChangeWithdrawn,
  ChangeSuperseded,
  LeaseLapsed,
]);
export type ChangeEvent = typeof ChangeEvent.Type;

/** What stops a change being queued, or batched once queued. Looked up by the Change DO before deciding. */
export interface Blockers {
  readonly openProvenConflicts: readonly ConflictId[];
  readonly failingGuards: readonly GuardId[];
  readonly unresolvedHighDrift: readonly Drift[];
}

/** Who withdraws a change: the holder of its lease, or an operator (the doorway checks the scope). */
export type WithdrawAuthority =
  | { readonly _tag: "Lease"; readonly leaseId: LeaseId }
  | { readonly _tag: "Operator"; readonly by: string };

/**
 * A command on a change: an agent's call (carrying its lease), a Workflow
 * step, or another entity's event the Change DO reacts to. Ids and every
 * looked-up fact arrive in the command; the time arrives in `ChangeFacts`.
 */
export type ChangeCommand =
  | {
      readonly _tag: "Declare";
      readonly changeId: ChangeId;
      readonly agentId: AgentId;
      readonly origin: ChangeOrigin;
      readonly sketchId?: SketchId;
      readonly goal: string;
      readonly footprint: readonly FootprintEntry[];
      readonly premises: readonly Proposition[];
      readonly declaredEffects?: readonly Proposition[];
      readonly leaseId: LeaseId;
      readonly preflight: Preflight;
    }
  | { readonly _tag: "Start"; readonly workspaceId: WorkspaceId; readonly baseSha: CommitSha }
  | {
      readonly _tag: "Revise";
      readonly leaseId: LeaseId;
      readonly ifMatchRevision: number;
      readonly goal?: string;
      readonly footprint?: readonly FootprintEntry[];
      readonly premisesAdded: readonly Proposition[];
      readonly premisesRetracted: readonly Proposition[];
      readonly declaredEffects?: readonly Proposition[];
      readonly preflight: Preflight;
    }
  | {
      readonly _tag: "Rely";
      readonly leaseId: LeaseId;
      readonly premise: Proposition;
      readonly preflight: Preflight;
    }
  | {
      readonly _tag: "Submit";
      readonly leaseId: LeaseId;
      readonly commitSha: CommitSha;
      readonly inWorkspace: boolean;
    }
  | { readonly _tag: "StartPrecheck"; readonly instanceId: string }
  | { readonly _tag: "Drift"; readonly blocking: readonly Drift[] }
  | {
      readonly _tag: "CompilePlan";
      /** Absent until Precheck derives effects; then `EffectsDerived` is committed first. */
      readonly derivation?: {
        readonly effects: readonly DerivedEffect[];
        readonly derivationRef: string;
      };
      readonly drift: readonly Drift[];
      readonly planHash: ContentHash;
      readonly steps: number;
      readonly costEstimate: number;
    }
  | { readonly _tag: "Queue"; readonly laneId: string; readonly blockers: Blockers }
  | { readonly _tag: "Park"; readonly escalationId: EscalationId }
  | { readonly _tag: "Batch"; readonly batchId: BatchId; readonly blockers: Blockers }
  | {
      readonly _tag: "Requeue";
      readonly batchId: BatchId;
      readonly reason: "infra-failure" | "bisection" | "invalidated";
    }
  | {
      readonly _tag: "Bounce";
      readonly verdictId: VerdictId;
      readonly reasons: readonly string[];
      readonly nextActions: readonly NextAction[];
      /** The failed batch, when the bounce comes from Integrating. */
      readonly batchId?: BatchId;
    }
  | {
      /** TrunkAdvanced's landing for this change, with the head trunk advanced to. */
      readonly _tag: "Land";
      /** Its commit on trunk, carrying its trailers: not the commit it was submitted as. */
      readonly commitSha: CommitSha;
      readonly trunkSha: CommitSha;
      readonly candidateId: CandidateId;
      readonly proofId: string;
    }
  | { readonly _tag: "Resume"; readonly decisionId: DecisionId }
  | {
      readonly _tag: "Adopt";
      readonly agentId: AgentId;
      readonly leaseId: LeaseId;
      readonly briefRef: string;
    }
  | { readonly _tag: "Lapse"; readonly leaseId: LeaseId }
  | { readonly _tag: "Withdraw"; readonly authority: WithdrawAuthority; readonly reason?: string }
  | { readonly _tag: "Supersede"; readonly by: ChangeId; readonly decisionId?: DecisionId };

/** Facts from I/O that every decision may read: the time, and the change this DO holds (its key). */
export interface ChangeFacts {
  readonly now: Instant;
  readonly changeId: ChangeId;
}

export type ChangeRejection =
  | ChangeNotFound
  | ChangeStateRefused
  | LeaseStale
  | LeaseNotLapsed
  | RevisionMismatch
  | CommitNotInWorkspace
  | ChangeBlocked;

type Decision = Result.Result<readonly ChangeEvent[], ChangeRejection>;

const readChange = (changeId: ChangeId): NextAction => ({
  kind: "read",
  title: "Read the change for its current state, revision and lease",
  operationId: "Changes_getChange",
  args: { changeId },
});

const refuse = (change: Change, command: ChangeCommand): Decision =>
  Result.fail(
    new ChangeStateRefused({
      changeId: change.id,
      state: change.state,
      command: command._tag,
      nextActions: [readChange(change.id)],
    }),
  );

const blocked = (change: Change, blockers: Blockers): Decision | undefined =>
  blockers.openProvenConflicts.length +
    blockers.failingGuards.length +
    blockers.unresolvedHighDrift.length ===
  0
    ? undefined
    : Result.fail(
        new ChangeBlocked({
          changeId: change.id,
          conflicts: [...blockers.openProvenConflicts],
          guards: [...blockers.failingGuards],
          drift: [...blockers.unresolvedHighDrift],
          nextActions: [
            {
              kind: "read",
              title: "Read the conflicts open against the change",
              operationId: "Conflicts_listConflicts",
              args: { changeId: change.id },
            },
          ],
        }),
      );

const defaultBounceActions = (changeId: ChangeId): readonly NextAction[] => [
  {
    kind: "call",
    title: "Fix the change, then submit it again",
    operationId: "submit",
    args: { changeId },
  },
];

/**
 * A transition from a platform-owned state into an agent-owned one. If the
 * lease lapsed while the platform held the change, the change parks for
 * adoption in the same transaction, so no change is left orphaned.
 */
const intoAgentOwned = (change: Change, now: Instant, event: ChangeEvent): Decision =>
  Result.succeed(
    !isAgentOwned(change.state) && isLapsed(change.lease, now)
      ? [event, ChangeParked.make({ changeId: change.id, reason: "lease-lapsed" })]
      : [event],
  );

const preflightIssued = (changeId: ChangeId, revision: number, preflight: Preflight) =>
  PreflightIssued.make({ changeId, revision, ...preflight });

/** The commands an agent makes while holding the lease: refused outright on a stale or lapsed token. */
const leaseOf = (command: ChangeCommand): LeaseId | undefined => {
  switch (command._tag) {
    case "Revise":
    case "Rely":
    case "Submit":
      return command.leaseId;
    case "Withdraw":
      return command.authority._tag === "Lease" ? command.authority.leaseId : undefined;
    default:
      return undefined;
  }
};

const declare = (command: Extract<ChangeCommand, { _tag: "Declare" }>): Decision =>
  Result.succeed([
    IntentDeclared.make({
      changeId: command.changeId,
      agentId: command.agentId,
      origin: command.origin,
      ...(command.sketchId === undefined ? {} : { sketchId: command.sketchId }),
      revision: 1,
      goal: command.goal,
      footprint: command.footprint,
      premises: command.premises,
      ...(command.declaredEffects === undefined
        ? {}
        : { declaredEffects: command.declaredEffects }),
      leaseId: command.leaseId,
    }),
    preflightIssued(command.changeId, 1, command.preflight),
  ]);

/**
 * Decides a command on a change (docs/domain/state-machines.md § Change and §
 * Lease). Pure: the time is `facts.now`, every id is minted by the caller.
 */
export const decideChange = (
  state: Change | undefined,
  command: ChangeCommand,
  facts: ChangeFacts,
): Decision => {
  if (state === undefined) {
    return command._tag === "Declare"
      ? declare(command)
      : Result.fail(
          new ChangeNotFound({
            changeId: facts.changeId,
            nextActions: [
              {
                kind: "call",
                title: "Declare the change before acting on it",
                operationId: "declare",
              },
            ],
          }),
        );
  }
  const change = state;
  const { now } = facts;
  if (TERMINAL.has(change.state) || command._tag === "Declare") return refuse(change, command);

  const leaseId = leaseOf(command);
  if (leaseId !== undefined) {
    const lease = checkLease(change, leaseId, now);
    if (Result.isFailure(lease)) return Result.fail(lease.failure);
  }

  const at = (...states: readonly ChangeState[]): boolean => states.includes(change.state);
  const id = change.id;
  const revision = change.intent.revision;

  switch (command._tag) {
    case "Start":
      return at("declared")
        ? Result.succeed([
            ChangeStarted.make({
              changeId: id,
              workspaceId: command.workspaceId,
              baseSha: command.baseSha,
            }),
          ])
        : refuse(change, command);

    case "Revise": {
      if (!at("working", "drifted", "bounced")) return refuse(change, command);
      if (command.ifMatchRevision !== revision) {
        return Result.fail(
          new RevisionMismatch({
            changeId: id,
            expected: command.ifMatchRevision,
            actual: revision,
            nextActions: [readChange(id)],
          }),
        );
      }
      return Result.succeed([
        IntentRevised.make({
          changeId: id,
          revision: revision + 1,
          ...(command.goal === undefined ? {} : { goal: command.goal }),
          ...(command.footprint === undefined ? {} : { footprint: command.footprint }),
          premisesAdded: command.premisesAdded,
          premisesRetracted: command.premisesRetracted,
          ...(command.declaredEffects === undefined
            ? {}
            : { declaredEffects: command.declaredEffects }),
        }),
        preflightIssued(id, revision + 1, command.preflight),
      ]);
    }

    case "Rely":
      return at("working")
        ? Result.succeed([
            IntentRevised.make({
              changeId: id,
              revision: revision + 1,
              premisesAdded: [command.premise],
              premisesRetracted: [],
            }),
            preflightIssued(id, revision + 1, command.preflight),
          ])
        : refuse(change, command);

    case "Submit": {
      if (!at("working", "bounced") || change.workspaceId === undefined)
        return refuse(change, command);
      if (!command.inWorkspace) {
        return Result.fail(
          new CommitNotInWorkspace({
            changeId: id,
            commitSha: command.commitSha,
            nextActions: [
              {
                kind: "call",
                title: "Push the commit to the change's workspace, then submit it",
                operationId: "submit",
                args: { changeId: id },
              },
            ],
          }),
        );
      }
      return Result.succeed([
        ChangeSubmitted.make({
          changeId: id,
          revision,
          commitSha: command.commitSha,
          workspaceId: change.workspaceId,
        }),
      ]);
    }

    case "StartPrecheck":
      return at("submitted")
        ? Result.succeed([
            PrecheckStarted.make({ changeId: id, revision, instanceId: command.instanceId }),
          ])
        : refuse(change, command);

    case "Drift":
      return at("deriving")
        ? intoAgentOwned(
            change,
            now,
            ChangeDrifted.make({ changeId: id, revision, blocking: command.blocking }),
          )
        : refuse(change, command);

    case "CompilePlan":
      return at("deriving")
        ? Result.succeed([
            ...(command.derivation === undefined
              ? []
              : [
                  EffectsDerived.make({
                    changeId: id,
                    revision,
                    effects: command.derivation.effects,
                    derivationRef: command.derivation.derivationRef,
                  }),
                ]),
            ...(command.drift.length === 0
              ? []
              : [DriftDetected.make({ changeId: id, revision, drift: command.drift })]),
            PlanCompiled.make({
              changeId: id,
              revision,
              planHash: command.planHash,
              steps: command.steps,
              costEstimate: command.costEstimate,
            }),
          ])
        : refuse(change, command);

    case "Queue":
      if (!at("verifying")) return refuse(change, command);
      return (
        blocked(change, command.blockers) ??
        Result.succeed([ChangeQueued.make({ changeId: id, laneId: command.laneId })])
      );

    case "Park":
      return at("verifying")
        ? Result.succeed([
            ChangeParked.make({
              changeId: id,
              reason: "awaiting-ruling",
              escalationId: command.escalationId,
            }),
          ])
        : refuse(change, command);

    case "Batch":
      if (!at("queued")) return refuse(change, command);
      return (
        blocked(change, command.blockers) ??
        Result.succeed([ChangeBatched.make({ changeId: id, batchId: command.batchId })])
      );

    case "Requeue":
      return at("integrating") && command.batchId === change.batchId
        ? Result.succeed([
            ChangeRequeued.make({ changeId: id, batchId: command.batchId, reason: command.reason }),
          ])
        : refuse(change, command);

    case "Bounce": {
      const awaitingRuling = at("parked") && change.parkReason === "awaiting-ruling";
      const fromBatch = at("integrating") && command.batchId === change.batchId;
      if (!(at("deriving", "verifying", "queued") || fromBatch || awaitingRuling))
        return refuse(change, command);
      const nextActions =
        command.nextActions.length > 0 ? command.nextActions : defaultBounceActions(id);
      return intoAgentOwned(
        change,
        now,
        ChangeBounced.make({
          changeId: id,
          verdictId: command.verdictId,
          reasons: command.reasons,
          nextActions,
        }),
      );
    }

    case "Land":
      return at("integrating")
        ? Result.succeed([
            ChangeLanded.make({
              changeId: id,
              commitSha: command.commitSha,
              trunkSha: command.trunkSha,
              candidateId: command.candidateId,
              proofId: command.proofId,
            }),
          ])
        : refuse(change, command);

    case "Resume":
      return at("parked") && change.parkReason === "awaiting-ruling"
        ? Result.succeed([ChangeResumed.make({ changeId: id, decisionId: command.decisionId })])
        : refuse(change, command);

    case "Adopt":
      if (!isLapsed(change.lease, now)) {
        return Result.fail(
          new LeaseNotLapsed({
            changeId: id,
            lapsesAt: lapsesAt(change.lease),
            nextActions: [
              {
                kind: "wait",
                title: "Wait for the lease to lapse: adoption needs a Lapsed lease",
                args: { lapsesAt: lapsesAt(change.lease) },
              },
            ],
          }),
        );
      }
      return Result.succeed([
        ChangeAdopted.make({
          changeId: id,
          previousAgentId: change.agentId,
          agentId: command.agentId,
          leaseId: command.leaseId,
          briefRef: command.briefRef,
        }),
      ]);

    case "Lapse": {
      // An alarm with nothing to make visible commits nothing; the DO re-arms only while the lease is active.
      if (
        command.leaseId !== change.lease.id ||
        change.lease.state !== "active" ||
        !isLapsed(change.lease, now)
      )
        return Result.succeed([]);
      const lapsed = LeaseLapsed.make({
        changeId: id,
        leaseId: change.lease.id,
        renewedAt: change.lease.renewedAt,
      });
      return Result.succeed(
        isAgentOwned(change.state)
          ? [lapsed, ChangeParked.make({ changeId: id, reason: "lease-lapsed" })]
          : [lapsed],
      );
    }

    case "Withdraw":
      return at("integrating")
        ? refuse(change, command)
        : Result.succeed([
            ChangeWithdrawn.make({
              changeId: id,
              by: command.authority._tag === "Lease" ? change.agentId : command.authority.by,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
            }),
          ]);

    case "Supersede":
      return at("integrating")
        ? refuse(change, command)
        : Result.succeed([
            ChangeSuperseded.make({
              changeId: id,
              by: command.by,
              ...(command.decisionId === undefined ? {} : { decisionId: command.decisionId }),
            }),
          ]);

    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Change | undefined, event: ChangeEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a change in ${state === undefined ? "no state" : state.state}`,
  );
};

type Optional = "parkReason" | "escalationId" | "batchId" | "laneId";

/** The change in `next`, without the fields that only hold in the state it leaves. */
const moveTo = (change: Change, next: ChangeState, drop: readonly Optional[] = []): Change => {
  const moved: { -readonly [K in keyof Change]: Change[K] } = { ...change, state: next };
  for (const key of drop) delete moved[key];
  return moved;
};

const released = (change: Change, next: ChangeState): Change => ({
  ...moveTo(change, next, ["parkReason", "escalationId", "batchId", "laneId"]),
  lease: { ...change.lease, state: "released" },
});

/**
 * Folds one committed event into the change. It keeps its own table of which
 * state each event leaves from, independent of `decideChange`, and throws
 * `IllegalTransition` on an event its state cannot take.
 */
export const evolveChange = (
  state: Change | undefined,
  committed: Committed<ChangeEvent>,
): Change => {
  const event = committed.payload;
  if (state === undefined) {
    if (event._tag !== "IntentDeclared") return illegal(state, event);
    return {
      id: event.changeId,
      agentId: event.agentId,
      origin: event.origin,
      state: "declared",
      intent: {
        revision: event.revision,
        goal: event.goal,
        footprint: event.footprint,
        premises: event.premises,
        ...(event.declaredEffects === undefined ? {} : { declaredEffects: event.declaredEffects }),
      },
      lease: {
        id: event.leaseId,
        agentId: event.agentId,
        renewedAt: committed.at,
        state: "active",
      },
      ...(event.sketchId === undefined ? {} : { fromSketch: event.sketchId }),
      createdAt: committed.at,
    };
  }
  const change = state;
  const from = (...states: readonly ChangeState[]): boolean => states.includes(change.state);
  if (TERMINAL.has(change.state)) return illegal(change, event);

  switch (event._tag) {
    case "IntentDeclared":
      return illegal(change, event);
    case "PreflightIssued":
      return from("declared", "working") && event.revision === change.intent.revision
        ? change
        : illegal(change, event);
    case "IntentRevised":
      return from("working", "drifted", "bounced") && event.revision === change.intent.revision + 1
        ? { ...moveTo(change, "working"), intent: reviseIntent(change.intent, event) }
        : illegal(change, event);
    case "ChangeStarted":
      return from("declared")
        ? {
            ...moveTo(change, "working"),
            workspaceId: event.workspaceId,
            ...(event.baseSha === undefined ? {} : { baseSha: event.baseSha }),
          }
        : illegal(change, event);
    case "ChangeSubmitted":
      return from("working", "bounced")
        ? { ...moveTo(change, "submitted"), commitSha: event.commitSha }
        : illegal(change, event);
    case "PrecheckStarted":
      return from("submitted") ? moveTo(change, "deriving") : illegal(change, event);
    case "EffectsDerived":
    case "DriftDetected":
      return from("deriving") ? change : illegal(change, event);
    case "ChangeDrifted":
      return from("deriving") ? moveTo(change, "drifted") : illegal(change, event);
    case "PlanCompiled":
      return from("deriving") ? moveTo(change, "verifying") : illegal(change, event);
    case "ChangeQueued":
      return from("verifying")
        ? { ...moveTo(change, "queued"), laneId: event.laneId }
        : illegal(change, event);
    case "ChangeBatched":
      return from("queued")
        ? { ...moveTo(change, "integrating"), batchId: event.batchId }
        : illegal(change, event);
    case "ChangeRequeued":
      return from("integrating") && event.batchId === change.batchId
        ? moveTo(change, "queued", ["batchId"])
        : illegal(change, event);
    case "ChangeLanded":
      return from("integrating") ? released(change, "landed") : illegal(change, event);
    case "ChangeBounced":
      return from("deriving", "verifying", "queued", "integrating") ||
        (from("parked") && change.parkReason === "awaiting-ruling")
        ? moveTo(change, "bounced", ["parkReason", "escalationId", "batchId", "laneId"])
        : illegal(change, event);
    case "ChangeParked":
      if (event.reason === "awaiting-ruling") {
        return from("verifying")
          ? {
              ...moveTo(change, "parked"),
              parkReason: "awaiting-ruling",
              ...(event.escalationId === undefined ? {} : { escalationId: event.escalationId }),
            }
          : illegal(change, event);
      }
      return isAgentOwned(change.state)
        ? {
            ...moveTo(change, "parked"),
            parkReason: "lease-lapsed",
            lease: { ...change.lease, state: "lapsed" },
          }
        : illegal(change, event);
    case "ChangeResumed":
      return from("parked") && change.parkReason === "awaiting-ruling"
        ? moveTo(change, "verifying", ["parkReason", "escalationId"])
        : illegal(change, event);
    case "ChangeAdopted": {
      if (!isLapsed(change.lease, committed.at)) return illegal(change, event);
      const adopted: Change = {
        ...change,
        agentId: event.agentId,
        lease: {
          id: event.leaseId,
          agentId: event.agentId,
          renewedAt: committed.at,
          state: "active",
        },
      };
      if (!(from("parked") && change.parkReason === "lease-lapsed")) return adopted;
      // Back to work; a change parked before its workspace was granted is still waiting for one.
      return moveTo(adopted, change.workspaceId === undefined ? "declared" : "working", [
        "parkReason",
      ]);
    }
    case "ChangeWithdrawn":
      return from("integrating") ? illegal(change, event) : released(change, "withdrawn");
    case "ChangeSuperseded":
      return from("integrating") ? illegal(change, event) : released(change, "superseded");
    case "LeaseLapsed":
      return change.lease.state === "active" &&
        event.leaseId === change.lease.id &&
        committed.at >= lapsesAt(change.lease)
        ? { ...change, lease: { ...change.lease, state: "lapsed" } }
        : illegal(change, event);

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a change from its events in `seq` order. */
export const replayChange = (events: readonly Committed<ChangeEvent>[]): Change | undefined =>
  events.reduce<Change | undefined>((state, event) => evolveChange(state, event), undefined);
