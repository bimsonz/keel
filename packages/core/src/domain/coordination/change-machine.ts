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
  type RunRef,
  type SketchId,
  type UserId,
  type VerdictId,
  type WorkspaceId,
} from "../kernel/index.ts";
import {
  type Change,
  type ChangeOrigin,
  type ChangeState,
  isAgentOwned,
  type PushRefusedReason,
  TERMINAL,
} from "./change.ts";
import { canonicalProposition } from "./claim.ts";
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
  ChangeRebased,
  ChangeRequeued,
  ChangeResumed,
  ChangeStarted,
  ChangeSubmitted,
  ChangeSuperseded,
  ChangeWithdrawn,
  ConflictNoted,
  DriftDetected,
  EffectsDerived,
  IntentDeclared,
  IntentRevised,
  LeaseLapsed,
  PlanCompiled,
  PrecheckStarted,
  PreflightIssued,
  type RequeueReason,
} from "./events.ts";
import { reviseIntent } from "./intent.ts";
import { checkLease, isLapsed, lapsesAt } from "./lease.ts";
import type { Preflight } from "./preflight.ts";
import type { FootprintEntry, Predicate, PredicatePolicies, Proposition } from "./proposition.ts";

/** The events a Change DO commits for a change and its lease, in the order `evolve` folds them. */
export const ChangeEvent = Schema.Union([
  IntentDeclared,
  PreflightIssued,
  IntentRevised,
  ChangeStarted,
  ChangeSubmitted,
  ChangeRebased,
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
  ConflictNoted,
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
  /**
   * The escalations of the change's conflicts that are with a person and not
   * yet ruled on. They hold the change out of a batch and never out of the
   * queue: it is queued, and waits there or parked, until the ruling.
   */
  readonly awaitingRuling: readonly EscalationId[];
}

/** Who withdraws a change: the holder of its lease, or a maintainer of its project (the doorway authorised them). */
export type WithdrawAuthority =
  | { readonly _tag: "Lease"; readonly leaseId: LeaseId }
  | { readonly _tag: "Maintainer"; readonly by: UserId };

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
      readonly run?: RunRef;
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
      /** The agent rebased its workspace: `from` must be the change's base, and `onto` another commit. */
      readonly _tag: "Rebase";
      readonly leaseId: LeaseId;
      readonly from: CommitSha;
      readonly onto: CommitSha;
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
  /**
   * What Precheck derived from the submitted commit, committed on its own
   * before drift is classified: the subjects hear it whether the change then
   * drifts or compiles. Once per Precheck pass.
   */
  | {
      readonly _tag: "DeriveEffects";
      readonly effects: readonly DerivedEffect[];
      readonly derivationRef: string;
    }
  | { readonly _tag: "Drift"; readonly blocking: readonly Drift[] }
  | {
      readonly _tag: "CompilePlan";
      readonly drift: readonly Drift[];
      readonly planHash: ContentHash;
      readonly steps: number;
      readonly costEstimate: number;
      /** The predicate policy compiled for the change, carried onto PlanCompiled. */
      readonly predicatePolicy?: PredicatePolicies;
    }
  | { readonly _tag: "Queue"; readonly laneId: string; readonly blockers: Blockers }
  | { readonly _tag: "Park"; readonly escalationId: EscalationId }
  | { readonly _tag: "Batch"; readonly batchId: BatchId; readonly blockers: Blockers }
  | {
      readonly _tag: "Requeue";
      readonly batchId: BatchId;
      readonly reason: RequeueReason;
    }
  | ({
      readonly _tag: "Bounce";
      readonly reasons: readonly string[];
      readonly nextActions: readonly NextAction[];
      /** The failed batch, when the bounce comes from Integrating. */
      readonly batchId?: BatchId;
    } & BounceCause)
  | {
      /** A conflict proven against the change under `advise` or `annotate`: recorded, nothing moves. */
      readonly _tag: "NoteConflict";
      readonly conflictId: ConflictId;
      readonly predicate: Predicate;
      readonly policy: "advise" | "annotate";
      readonly evidenceRef?: string;
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
  | {
      readonly _tag: "Resume";
      readonly decisionId: DecisionId;
      /**
       * The escalations of the change's conflicts still with a person once
       * this ruling is recorded. While there is one the change is not resumed:
       * the ruling on one question never releases it past another.
       */
      readonly awaitingRuling: readonly EscalationId[];
    }
  | {
      readonly _tag: "Adopt";
      readonly agentId: AgentId;
      readonly run?: RunRef;
      readonly leaseId: LeaseId;
      readonly briefRef: string;
    }
  | { readonly _tag: "Lapse"; readonly leaseId: LeaseId }
  | { readonly _tag: "Withdraw"; readonly authority: WithdrawAuthority; readonly reason?: string }
  | { readonly _tag: "Supersede"; readonly by: ChangeId; readonly decisionId?: DecisionId };

/**
 * Why a change bounces: the verdict that failed it, or a conflict proven
 * against it under `block`. A conflict bounces a change only before it is
 * batched (Deriving, Verifying, Queued).
 */
export type BounceCause =
  | {
      readonly verdictId: VerdictId;
      readonly conflictId?: undefined;
      readonly declined?: undefined;
      readonly decisionId?: undefined;
    }
  | {
      readonly conflictId: ConflictId;
      readonly verdictId?: undefined;
      readonly declined?: undefined;
      readonly decisionId?: undefined;
    }
  | {
      /** The ruling the change was parked for went against it: from Parked awaiting-ruling only. */
      readonly decisionId: DecisionId;
      readonly verdictId?: undefined;
      readonly conflictId?: undefined;
      readonly declined?: undefined;
    }
  | {
      /** Promotion declined the change's batch because its push was refused: from Integrating only. */
      readonly declined: { readonly batchId: BatchId; readonly reason: PushRefusedReason };
      readonly verdictId?: undefined;
      readonly conflictId?: undefined;
      readonly decisionId?: undefined;
    };

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
  operationId: "change",
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

const NO_BLOCKERS: Blockers = {
  openProvenConflicts: [],
  failingGuards: [],
  unresolvedHighDrift: [],
  awaitingRuling: [],
};

const JOINS_ONCE_RULED =
  "A person was asked about a conflict of this change: it joins a batch once they rule";
const RESUMES_ONCE_RULED =
  "A person was asked about another conflict of this change: it resumes once they rule";

/**
 * The refusal of a blocked change, or undefined when nothing blocks it.
 * `awaited` are the rulings a batch or a resume must wait for, and `wait`
 * says which of the two; queueing passes none.
 */
const blocked = (
  change: Change,
  blockers: Blockers,
  awaited: readonly EscalationId[] = [],
  wait: string = JOINS_ONCE_RULED,
): Decision | undefined =>
  blockers.openProvenConflicts.length +
    blockers.failingGuards.length +
    blockers.unresolvedHighDrift.length +
    awaited.length ===
  0
    ? undefined
    : Result.fail(
        new ChangeBlocked({
          changeId: change.id,
          conflicts: [...blockers.openProvenConflicts],
          guards: [...blockers.failingGuards],
          drift: [...blockers.unresolvedHighDrift],
          ...(awaited.length === 0 ? {} : { escalations: [...awaited] }),
          nextActions: [
            ...(awaited.length === 0
              ? []
              : [
                  {
                    kind: "wait" as const,
                    title: wait,
                    args: { escalations: [...awaited] },
                  },
                ]),
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

/** The ways forward when a ruling went against the change: say something the ruling allows, or give the work up. */
const ruledAgainstActions = (changeId: ChangeId): readonly NextAction[] => [
  {
    kind: "call",
    title: "Revise the change's intent so that it no longer contradicts what was ruled",
    operationId: "revise",
    args: { changeId },
  },
  {
    kind: "call",
    title: "Withdraw the change",
    operationId: "abandon",
    args: { changeId },
  },
];

/** The ways forward when promotion declined the change's batch because its push was refused. */
const declinedActions = (changeId: ChangeId, reason: PushRefusedReason): readonly NextAction[] =>
  reason === "pack-too-large"
    ? [
        {
          kind: "call",
          title:
            "The change's pack is too large to push: declare part of the work as its own change",
          operationId: "declare",
        },
        {
          kind: "call",
          title: "Submit this change again with a smaller commit",
          operationId: "submit",
          args: { changeId },
        },
      ]
    : [
        {
          kind: "escalate",
          title:
            "The repo is at its size quota: ask an owner to free space, or whoever runs this Keel to raise the quota",
        },
        {
          kind: "call",
          title: "Submit the change again once there is room",
          operationId: "submit",
          args: { changeId },
        },
      ];

/** The plan the change was compiled to, for an enqueue event to carry, when it has one. */
const planOf = (change: Change): { readonly planHash?: ContentHash } =>
  change.planHash === undefined ? {} : { planHash: change.planHash };

/** The ways forward from a conflict proven against a change: read it, revise around it, or resolve it. */
const conflictActions = (changeId: ChangeId, conflictId: ConflictId): readonly NextAction[] => [
  {
    kind: "read",
    title: "Read the conflict and the proof against the change",
    operationId: "Conflicts_getConflict",
    args: { conflictId },
  },
  {
    kind: "call",
    title: "Revise the change's intent around the conflict",
    operationId: "revise",
    args: { changeId },
  },
  {
    kind: "call",
    title: "Resolve the conflict with a move",
    operationId: "resolve",
    args: { conflictId },
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
    case "Rebase":
      return command.leaseId;
    case "Withdraw":
      return command.authority._tag === "Lease" ? command.authority.leaseId : undefined;
    default:
      return undefined;
  }
};

/** Propositions in the canonical form they are committed in: declare and derive are where they enter. */
const canonical = (propositions: readonly Proposition[]): readonly Proposition[] =>
  propositions.map(canonicalProposition);

const declare = (command: Extract<ChangeCommand, { _tag: "Declare" }>): Decision =>
  Result.succeed([
    IntentDeclared.make({
      changeId: command.changeId,
      agentId: command.agentId,
      ...(command.run === undefined ? {} : { run: command.run }),
      origin: command.origin,
      ...(command.sketchId === undefined ? {} : { sketchId: command.sketchId }),
      revision: 1,
      goal: command.goal,
      footprint: command.footprint,
      premises: canonical(command.premises),
      ...(command.declaredEffects === undefined
        ? {}
        : { declaredEffects: canonical(command.declaredEffects) }),
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
          premisesAdded: canonical(command.premisesAdded),
          premisesRetracted: canonical(command.premisesRetracted),
          ...(command.declaredEffects === undefined
            ? {}
            : { declaredEffects: canonical(command.declaredEffects) }),
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
              premisesAdded: [canonicalProposition(command.premise)],
              premisesRetracted: [],
            }),
            preflightIssued(id, revision + 1, command.preflight),
          ])
        : refuse(change, command);

    case "Rebase":
      return at("working", "bounced") &&
        change.baseSha !== undefined &&
        command.from === change.baseSha &&
        command.onto !== command.from
        ? Result.succeed([
            ChangeRebased.make({ changeId: id, from: command.from, to: command.onto }),
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
          ...(change.baseSha === undefined ? {} : { baseSha: change.baseSha }),
        }),
      ]);
    }

    case "StartPrecheck":
      return at("submitted")
        ? Result.succeed([
            PrecheckStarted.make({ changeId: id, revision, instanceId: command.instanceId }),
          ])
        : refuse(change, command);

    case "DeriveEffects":
      // A second derivation in one pass would set the subjects against two readings of one commit.
      return at("deriving") && change.derivationRef === undefined
        ? Result.succeed([
            EffectsDerived.make({
              changeId: id,
              revision,
              effects: command.effects.map((effect) => ({
                ...effect,
                proposition: canonicalProposition(effect.proposition),
              })),
              derivationRef: command.derivationRef,
            }),
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
            ...(command.drift.length === 0
              ? []
              : [DriftDetected.make({ changeId: id, revision, drift: command.drift })]),
            PlanCompiled.make({
              changeId: id,
              revision,
              planHash: command.planHash,
              steps: command.steps,
              costEstimate: command.costEstimate,
              ...(command.predicatePolicy === undefined
                ? {}
                : { predicatePolicy: command.predicatePolicy }),
            }),
          ])
        : refuse(change, command);

    case "Queue":
      if (!at("verifying")) return refuse(change, command);
      return (
        blocked(change, command.blockers) ??
        Result.succeed([
          ChangeQueued.make({ changeId: id, laneId: command.laneId, ...planOf(change) }),
        ])
      );

    case "Park": {
      // Past its plan and not yet in a batch: a party cannot land past the question a person was asked.
      // A change already waiting takes the park for another question, and waits on that one from then.
      const another =
        at("parked") &&
        change.parkReason === "awaiting-ruling" &&
        command.escalationId !== change.escalationId;
      return at("verifying", "queued") || another
        ? Result.succeed([
            ChangeParked.make({
              changeId: id,
              reason: "awaiting-ruling",
              escalationId: command.escalationId,
            }),
          ])
        : refuse(change, command);
    }

    case "Batch":
      if (!at("queued")) return refuse(change, command);
      // No party to a conflict a person was asked about enters a batch before the ruling.
      return (
        blocked(change, command.blockers, command.blockers.awaitingRuling) ??
        Result.succeed([ChangeBatched.make({ changeId: id, batchId: command.batchId })])
      );

    case "Requeue":
      return at("integrating") && command.batchId === change.batchId
        ? Result.succeed([
            ChangeRequeued.make({
              changeId: id,
              batchId: command.batchId,
              reason: command.reason,
              ...planOf(change),
            }),
          ])
        : refuse(change, command);

    case "Bounce": {
      const awaitingRuling = at("parked") && change.parkReason === "awaiting-ruling";
      const fromBatch = at("integrating") && command.batchId === change.batchId;
      const beforeBatch = at("deriving", "verifying", "queued");
      if (command.declined !== undefined) {
        // A declined batch bounces only its own members, and only while they are in it.
        if (!(at("integrating") && command.declined.batchId === change.batchId))
          return refuse(change, command);
        return intoAgentOwned(
          change,
          now,
          ChangeBounced.make({
            changeId: id,
            declined: command.declined,
            reasons: command.reasons,
            nextActions:
              command.nextActions.length > 0
                ? command.nextActions
                : declinedActions(id, command.declined.reason),
          }),
        );
      }
      if (command.decisionId !== undefined) {
        // A ruling goes against a change only while the change waits for it.
        if (!awaitingRuling) return refuse(change, command);
        return intoAgentOwned(
          change,
          now,
          ChangeBounced.make({
            changeId: id,
            decisionId: command.decisionId,
            reasons: command.reasons,
            nextActions:
              command.nextActions.length > 0 ? command.nextActions : ruledAgainstActions(id),
          }),
        );
      }
      const cause =
        command.conflictId === undefined
          ? { verdictId: command.verdictId }
          : { conflictId: command.conflictId };
      if (!(beforeBatch || ("verdictId" in cause && (fromBatch || awaitingRuling))))
        return refuse(change, command);
      const nextActions =
        command.nextActions.length > 0
          ? command.nextActions
          : "conflictId" in cause
            ? conflictActions(id, cause.conflictId)
            : defaultBounceActions(id);
      return intoAgentOwned(
        change,
        now,
        ChangeBounced.make({ changeId: id, ...cause, reasons: command.reasons, nextActions }),
      );
    }

    case "NoteConflict":
      return Result.succeed([
        ConflictNoted.make({
          changeId: id,
          conflictId: command.conflictId,
          predicate: command.predicate,
          policy: command.policy,
          ...(command.evidenceRef === undefined ? {} : { evidenceRef: command.evidenceRef }),
          ...(command.policy === "advise"
            ? { nextActions: conflictActions(id, command.conflictId) }
            : {}),
        }),
      ]);

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
      if (!(at("parked") && change.parkReason === "awaiting-ruling"))
        return refuse(change, command);
      // The ruling on one question does not release a change another question still holds.
      return (
        blocked(change, NO_BLOCKERS, command.awaitingRuling, RESUMES_ONCE_RULED) ??
        Result.succeed([ChangeResumed.make({ changeId: id, decisionId: command.decisionId })])
      );

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
          ...(command.run === undefined ? {} : { run: command.run }),
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

type Optional =
  | "parkReason"
  | "escalationId"
  | "parkedFrom"
  | "batchId"
  | "laneId"
  | "predicatePolicy"
  | "derivationRef";

/** The change in `next`, without the fields that only hold in the state it leaves. */
const moveTo = (change: Change, next: ChangeState, drop: readonly Optional[] = []): Change => {
  const moved: { -readonly [K in keyof Change]: Change[K] } = { ...change, state: next };
  for (const key of drop) delete moved[key];
  return moved;
};

const released = (change: Change, next: ChangeState): Change => ({
  ...moveTo(change, next, ["parkReason", "escalationId", "parkedFrom", "batchId", "laneId"]),
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
      ...(event.run === undefined ? {} : { run: event.run }),
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
    case "ChangeRebased":
      return from("working", "bounced") && event.from === change.baseSha
        ? { ...change, baseSha: event.to }
        : illegal(change, event);
    case "PrecheckStarted":
      // A new pass derives again: the commit may differ though the revision does not.
      return from("submitted")
        ? moveTo(change, "deriving", ["derivationRef"])
        : illegal(change, event);
    case "EffectsDerived":
      return from("deriving") &&
        event.revision === change.intent.revision &&
        change.derivationRef === undefined
        ? { ...change, derivationRef: event.derivationRef }
        : illegal(change, event);
    case "DriftDetected":
      return from("deriving") ? change : illegal(change, event);
    case "ChangeDrifted":
      return from("deriving") ? moveTo(change, "drifted") : illegal(change, event);
    case "PlanCompiled":
      return from("deriving")
        ? {
            ...moveTo(change, "verifying", ["predicatePolicy"]),
            planHash: event.planHash,
            ...(event.predicatePolicy === undefined
              ? {}
              : { predicatePolicy: event.predicatePolicy }),
          }
        : illegal(change, event);
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
      return from("integrating")
        ? { ...released(change, "landed"), landedCommit: event.commitSha }
        : illegal(change, event);
    case "ChangeBounced":
      if (event.declined !== undefined)
        return from("integrating") && event.declined.batchId === change.batchId
          ? moveTo(change, "bounced", [
              "parkReason",
              "escalationId",
              "parkedFrom",
              "batchId",
              "laneId",
            ])
          : illegal(change, event);
      if (event.decisionId !== undefined)
        return from("parked") && change.parkReason === "awaiting-ruling"
          ? moveTo(change, "bounced", [
              "parkReason",
              "escalationId",
              "parkedFrom",
              "batchId",
              "laneId",
            ])
          : illegal(change, event);
      return from("deriving", "verifying", "queued") ||
        (event.conflictId === undefined &&
          (from("integrating") || (from("parked") && change.parkReason === "awaiting-ruling")))
        ? moveTo(change, "bounced", [
            "parkReason",
            "escalationId",
            "parkedFrom",
            "batchId",
            "laneId",
          ])
        : illegal(change, event);
    case "ConflictNoted":
      return change;
    case "ChangeParked":
      if (event.reason === "awaiting-ruling") {
        // Already waiting, and held by another question: it waits on that one, from where it first parked.
        if (from("parked") && change.parkReason === "awaiting-ruling")
          return event.escalationId !== undefined && event.escalationId !== change.escalationId
            ? { ...change, escalationId: event.escalationId }
            : illegal(change, event);
        // It keeps its lane and its plan: the ruling puts it back where it waited.
        return change.state === "verifying" || change.state === "queued"
          ? {
              ...moveTo(change, "parked"),
              parkReason: "awaiting-ruling",
              parkedFrom: change.state,
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
        ? moveTo(change, change.parkedFrom ?? "verifying", [
            "parkReason",
            "escalationId",
            "parkedFrom",
          ])
        : illegal(change, event);
    case "ChangeAdopted": {
      if (!isLapsed(change.lease, committed.at)) return illegal(change, event);
      // The change is the adopter's run's from here, or no run's: never still the run that held it.
      const { run: _held, ...held } = change;
      const adopted: Change = {
        ...held,
        agentId: event.agentId,
        ...(event.run === undefined ? {} : { run: event.run }),
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
