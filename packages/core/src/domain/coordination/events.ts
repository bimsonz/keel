import { Schema } from "effect";
import {
  AgentId,
  Anchor,
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ConflictId,
  ContentHash,
  Counterpart,
  DecisionId,
  EscalationId,
  InstantSchema,
  LeaseId,
  NextAction,
  ProjectId,
  RunRef,
  SubjectId,
  VerdictId,
  WorkspaceId,
} from "../kernel/index.ts";
import { ChangeOrigin, ParkReason, PushRefusedReason } from "./change.ts";
import { DerivedEffect, Drift } from "./derivation.ts";
import {
  Contradiction,
  MoveBasis,
  Neighbour,
  PrecedentRef,
  PreflightCompared,
} from "./preflight.ts";
import {
  FootprintEntry,
  Predicate,
  PredicatePolicies,
  Proposition,
  SubjectKey,
} from "./proposition.ts";
import { Suggestion } from "./change.ts";

// Changes

export const IntentDeclared = Schema.TaggedStruct("IntentDeclared", {
  changeId: ChangeId,
  agentId: AgentId,
  /** The run of the agent that declared the change, when its token named one: the run that holds it. */
  run: Schema.optional(RunRef),
  origin: ChangeOrigin,
  revision: Schema.Int,
  goal: Schema.NonEmptyString,
  footprint: Schema.Array(FootprintEntry),
  premises: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
  leaseId: LeaseId,
});
export const PreflightIssued = Schema.TaggedStruct("PreflightIssued", {
  changeId: ChangeId,
  revision: Schema.Int,
  neighbours: Schema.Array(Neighbour),
  contradictions: Schema.Array(Contradiction),
  precedents: Schema.Array(PrecedentRef),
  suggestedMove: Suggestion,
  /** What the move rests on: a contradiction above, by index, or a precedent. Absent exactly when the move is `proceed`. */
  basis: Schema.optional(MoveBasis),
  /** The live changes with the same intent, in the order the live index gave them, never ranked. Absent when there are none. */
  alternatives: Schema.optional(Schema.Array(ChangeId)),
  /** How many live changes the preflight read, near the intent, and under how many subject keys. Absent on older events. */
  compared: Schema.optional(PreflightCompared),
});
export const IntentRevised = Schema.TaggedStruct("IntentRevised", {
  changeId: ChangeId,
  revision: Schema.Int,
  goal: Schema.optional(Schema.String),
  footprint: Schema.optional(Schema.Array(FootprintEntry)),
  premisesAdded: Schema.Array(Proposition),
  premisesRetracted: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
});
/** Declared → Working: the pool granted a workspace. */
export const ChangeStarted = Schema.TaggedStruct("ChangeStarted", {
  changeId: ChangeId,
  workspaceId: WorkspaceId,
  /** The workspace's head when granted: the change's base, which Precheck diffs against. Always set; optional only so older events still decode. */
  baseSha: Schema.optional(CommitSha),
});
export const PremiseRelied = Schema.TaggedStruct("PremiseRelied", {
  subjectId: SubjectId,
  changeId: ChangeId,
  premise: Proposition,
});
export const ChangeSubmitted = Schema.TaggedStruct("ChangeSubmitted", {
  changeId: ChangeId,
  revision: Schema.Int,
  commitSha: CommitSha,
  workspaceId: WorkspaceId,
  /** The change's base when it was submitted: the base the submission is judged against. Always set when the change has one; optional only so older events still decode. */
  baseSha: Schema.optional(CommitSha),
});
/** The agent rebased its workspace onto `to`: the change's base moves from `from`, and nothing else changes. */
export const ChangeRebased = Schema.TaggedStruct("ChangeRebased", {
  changeId: ChangeId,
  from: CommitSha,
  to: CommitSha,
});
export const PrecheckStarted = Schema.TaggedStruct("PrecheckStarted", {
  changeId: ChangeId,
  revision: Schema.Int,
  instanceId: Schema.String,
});
/**
 * A live anchor a change's submitted diff touches: code a premise on
 * `subject` is anchored to, which the change edits whether or not anything
 * was derived from the edit.
 */
export const TouchedAnchor = Schema.Struct({ subject: SubjectKey, anchor: Anchor });
export type TouchedAnchor = typeof TouchedAnchor.Type;
export const EffectsDerived = Schema.TaggedStruct("EffectsDerived", {
  changeId: ChangeId,
  revision: Schema.Int,
  effects: Schema.Array(DerivedEffect),
  derivationRef: Schema.String,
  /** The live anchors the submitted diff touches; absent on a derivation from before they were kept, and when there are none. */
  touched: Schema.optional(Schema.Array(TouchedAnchor)),
  /** The paths the submitted diff touches, sorted, at most DERIVED_PATHS_MAX; absent on a derivation from before they were kept. */
  paths: Schema.optional(Schema.Array(Schema.String)),
});
export const DriftDetected = Schema.TaggedStruct("DriftDetected", {
  changeId: ChangeId,
  revision: Schema.Int,
  drift: Schema.Array(Drift),
});
export const ChangeDrifted = Schema.TaggedStruct("ChangeDrifted", {
  changeId: ChangeId,
  revision: Schema.Int,
  blocking: Schema.Array(Drift),
});
export const PlanCompiled = Schema.TaggedStruct("PlanCompiled", {
  changeId: ChangeId,
  revision: Schema.Int,
  planHash: ContentHash,
  steps: Schema.Int,
  costEstimate: Schema.Finite,
  /** The predicate policy compiled for the change; the Change DO applies it to a proven conflict. Absent, or a predicate left out, is `advise`. */
  predicatePolicy: Schema.optional(PredicatePolicies),
});
export const ChangeQueued = Schema.TaggedStruct("ChangeQueued", {
  changeId: ChangeId,
  laneId: Schema.String,
  /** The plan the change was verified under: its PlanCompiled's hash. Optional only so older events still decode. */
  planHash: Schema.optional(ContentHash),
});
export const ChangeBatched = Schema.TaggedStruct("ChangeBatched", {
  changeId: ChangeId,
  batchId: BatchId,
});
/**
 * Why a change goes back from Integrating to its lane's queue: its batch failed
 * on infrastructure, was bisected or invalidated, failed on another member,
 * or its members clashed (`textual`, `interaction`), so each runs alone next.
 */
export const RequeueReason = Schema.Literals([
  "infra-failure",
  "bisection",
  "invalidated",
  "co-member-failed",
  "textual",
  "interaction",
]);
export type RequeueReason = typeof RequeueReason.Type;
export const ChangeRequeued = Schema.TaggedStruct("ChangeRequeued", {
  changeId: ChangeId,
  batchId: BatchId,
  reason: RequeueReason,
  /** The plan the change was verified under, so the Lane re-adds it from this event alone. Optional only so older events still decode. */
  planHash: Schema.optional(ContentHash),
});
export const ChangeLanded = Schema.TaggedStruct("ChangeLanded", {
  changeId: ChangeId,
  commitSha: CommitSha,
  trunkSha: CommitSha,
  candidateId: CandidateId,
  proofId: Schema.String,
});
/**
 * The change went back to its agent, for one cause: the verdict that failed
 * it, the conflict proven against it under a `block` policy (proof, ADR 0005),
 * the promotion that declined its batch because Artifacts refused the push, or
 * the decision of a ruling that went against it.
 */
export const ChangeBounced = Schema.TaggedStruct("ChangeBounced", {
  changeId: ChangeId,
  verdictId: Schema.optional(VerdictId),
  conflictId: Schema.optional(ConflictId),
  /** The batch promotion declined, and why its push was refused. */
  declined: Schema.optional(Schema.Struct({ batchId: BatchId, reason: PushRefusedReason })),
  /** The decision of the ruling that went against the change while it waited for it. */
  decisionId: Schema.optional(DecisionId),
  reasons: Schema.Array(Schema.String),
  /** Always set, never empty, by `decideChange`; optional only so events committed before it was added still decode. */
  nextActions: Schema.optional(Schema.Array(NextAction)),
  /** What the change conflicts with on trunk, from its verdict, when it bounced on a textual conflict. */
  counterparts: Schema.optional(Schema.Array(Counterpart)),
}).check(
  Schema.makeFilter(
    (e) =>
      [e.verdictId, e.conflictId, e.declined, e.decisionId].filter((cause) => cause !== undefined)
        .length === 1 ||
      "a bounce names exactly one cause: its verdict, its conflict, its declined batch or the decision that went against it",
  ),
);
/**
 * A conflict proven against the change under an `advise` or `annotate`
 * policy: recorded on the change, which stays where it is. Advise names the
 * ways forward; annotate notifies no one.
 */
export const ConflictNoted = Schema.TaggedStruct("ConflictNoted", {
  changeId: ChangeId,
  conflictId: ConflictId,
  predicate: Predicate,
  policy: Schema.Literals(["advise", "annotate"]),
  /** The proof's evidence, as the Change DO refers to it (`probe:<probeId>`). */
  evidenceRef: Schema.optional(Schema.NonEmptyString),
  /** Set for `advise` only: view the conflict, revise, resolve. */
  nextActions: Schema.optional(Schema.Array(NextAction)),
});
/**
 * Another live change was declared with the same intent as `changeId`: their
 * declared effects make the same claims. A notice for `changeId`'s agent,
 * committed on the project. Keel shows alternatives to each other and never
 * picks one.
 */
export const AlternativeDeclared = Schema.TaggedStruct("AlternativeDeclared", {
  projectId: ProjectId,
  changeId: ChangeId,
  alternativeId: ChangeId,
  /** Compare the two (read the other change, read what is near your own), rebase, or withdraw. */
  nextActions: Schema.Array(NextAction),
});
/** A change with the same intent as `changeId` landed. A notice for `changeId`'s agent, committed on the project. */
export const AlternativeLanded = Schema.TaggedStruct("AlternativeLanded", {
  projectId: ProjectId,
  changeId: ChangeId,
  landedChangeId: ChangeId,
  /** Compare the two (read the landed change, read what is near your own), rebase, or withdraw. */
  nextActions: Schema.Array(NextAction),
});
export const ChangeParked = Schema.TaggedStruct("ChangeParked", {
  changeId: ChangeId,
  reason: ParkReason,
  escalationId: Schema.optional(EscalationId),
});
export const ChangeResumed = Schema.TaggedStruct("ChangeResumed", {
  changeId: ChangeId,
  decisionId: DecisionId,
});
export const ChangeAdopted = Schema.TaggedStruct("ChangeAdopted", {
  changeId: ChangeId,
  previousAgentId: AgentId,
  agentId: AgentId,
  /** The adopter's run, which holds the change from here; absent when the adopter's token named none. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  briefRef: Schema.String,
});
export const ChangeWithdrawn = Schema.TaggedStruct("ChangeWithdrawn", {
  changeId: ChangeId,
  by: Schema.String,
  reason: Schema.optional(Schema.String),
});
export const ChangeSuperseded = Schema.TaggedStruct("ChangeSuperseded", {
  changeId: ChangeId,
  by: ChangeId,
  decisionId: Schema.optional(DecisionId),
});
export const LeaseLapsed = Schema.TaggedStruct("LeaseLapsed", {
  changeId: ChangeId,
  leaseId: LeaseId,
  renewedAt: InstantSchema,
});
/** The platform handed the change back to its agent: the lease's 15 minutes start again from here. */
export const LeaseRestarted = Schema.TaggedStruct("LeaseRestarted", {
  changeId: ChangeId,
  leaseId: LeaseId,
});

// Subjects and premises

export const SubjectMinted = Schema.TaggedStruct("SubjectMinted", {
  subjectId: SubjectId,
  key: SubjectKey,
  anchors: Schema.Array(Anchor),
  gloss: Schema.String,
  mintedBy: Schema.Literals(["scan", "clef", "agent"]),
});
export const PremiseSuspected = Schema.TaggedStruct("PremiseSuspected", {
  subjectId: SubjectId,
  changeId: ChangeId,
  premise: Proposition,
  /**
   * The change that put the premise in doubt: by an effect the subject judged
   * against it, or (with no effect to judge) by editing code the premise is
   * anchored to.
   */
  cause: Schema.Struct({
    changeId: ChangeId,
    effect: Schema.optional(Proposition),
    anchor: Schema.optional(Anchor),
  }),
});
export const PremiseReaffirmed = Schema.TaggedStruct("PremiseReaffirmed", {
  subjectId: SubjectId,
  changeId: ChangeId,
  premise: Proposition,
});

// Workspaces

export const WorkspaceForked = Schema.TaggedStruct("WorkspaceForked", {
  workspaceId: WorkspaceId,
  repo: Schema.String,
  sourceRepo: Schema.String,
});
export const WorkspaceGranted = Schema.TaggedStruct("WorkspaceGranted", {
  workspaceId: WorkspaceId,
  holder: ChangeId,
  expiresAt: InstantSchema,
  /** The workspace's head when granted: the change's base. */
  baseSha: CommitSha,
});
export const WorkspacePushed = Schema.TaggedStruct("WorkspacePushed", {
  workspaceId: WorkspaceId,
  ref: Schema.String,
  sha: CommitSha,
});
export const WorkspaceCollected = Schema.TaggedStruct("WorkspaceCollected", {
  workspaceId: WorkspaceId,
  reason: Schema.Literals(["landed", "withdrawn", "expired"]),
});

export const CoordinationEvent = Schema.Union([
  IntentDeclared,
  PreflightIssued,
  IntentRevised,
  ChangeStarted,
  PremiseRelied,
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
  AlternativeDeclared,
  AlternativeLanded,
  ChangeParked,
  ChangeResumed,
  ChangeAdopted,
  ChangeWithdrawn,
  ChangeSuperseded,
  LeaseLapsed,
  LeaseRestarted,
  SubjectMinted,
  PremiseSuspected,
  PremiseReaffirmed,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspacePushed,
  WorkspaceCollected,
]);
export type CoordinationEvent = typeof CoordinationEvent.Type;
