import { Schema } from "effect";
import {
  AgentId,
  Anchor,
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ContentHash,
  DecisionId,
  EscalationId,
  InstantSchema,
  LeaseId,
  SketchId,
  SubjectId,
  VerdictId,
  WorkspaceId,
} from "../kernel/index.ts";
import { ChangeOrigin, ParkReason } from "./change.ts";
import { DerivedEffect, Drift } from "./derivation.ts";
import { Contradiction, Neighbour, PrecedentRef } from "./preflight.ts";
import { FootprintEntry, Proposition, SubjectKey } from "./proposition.ts";
import { Move } from "./change.ts";

// Changes

export const IntentDeclared = Schema.TaggedStruct("IntentDeclared", {
  changeId: ChangeId,
  agentId: AgentId,
  origin: ChangeOrigin,
  sketchId: Schema.optional(SketchId),
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
  suggestedMove: Move,
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
});
export const PrecheckStarted = Schema.TaggedStruct("PrecheckStarted", {
  changeId: ChangeId,
  revision: Schema.Int,
  instanceId: Schema.String,
});
export const EffectsDerived = Schema.TaggedStruct("EffectsDerived", {
  changeId: ChangeId,
  revision: Schema.Int,
  effects: Schema.Array(DerivedEffect),
  derivationRef: Schema.String,
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
  costEstimate: Schema.Number,
});
export const ChangeQueued = Schema.TaggedStruct("ChangeQueued", {
  changeId: ChangeId,
  laneId: Schema.String,
});
export const ChangeBatched = Schema.TaggedStruct("ChangeBatched", {
  changeId: ChangeId,
  batchId: BatchId,
});
export const ChangeRequeued = Schema.TaggedStruct("ChangeRequeued", {
  changeId: ChangeId,
  batchId: BatchId,
  reason: Schema.Literals(["infra-failure", "bisection", "invalidated"]),
});
export const ChangeLanded = Schema.TaggedStruct("ChangeLanded", {
  changeId: ChangeId,
  commitSha: CommitSha,
  trunkSha: CommitSha,
  candidateId: CandidateId,
  proofId: Schema.String,
});
export const ChangeBounced = Schema.TaggedStruct("ChangeBounced", {
  changeId: ChangeId,
  verdictId: VerdictId,
  reasons: Schema.Array(Schema.String),
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
  cause: Schema.Struct({ changeId: ChangeId, effect: Proposition }),
});
export const PremiseReaffirmed = Schema.TaggedStruct("PremiseReaffirmed", {
  subjectId: SubjectId,
  changeId: ChangeId,
  premise: Proposition,
});

// Sketches and workspaces

export const SketchOpened = Schema.TaggedStruct("SketchOpened", {
  sketchId: SketchId,
  agentId: AgentId,
  workspaceId: WorkspaceId,
  expiresAt: InstantSchema,
});
export const SketchPromoted = Schema.TaggedStruct("SketchPromoted", {
  sketchId: SketchId,
  changeId: ChangeId,
});
export const SketchExpired = Schema.TaggedStruct("SketchExpired", { sketchId: SketchId });
export const SketchDiscarded = Schema.TaggedStruct("SketchDiscarded", {
  sketchId: SketchId,
  by: Schema.String,
});
export const WorkspaceForked = Schema.TaggedStruct("WorkspaceForked", {
  workspaceId: WorkspaceId,
  repo: Schema.String,
  sourceRepo: Schema.String,
});
export const WorkspaceGranted = Schema.TaggedStruct("WorkspaceGranted", {
  workspaceId: WorkspaceId,
  holder: Schema.Union([ChangeId, SketchId]),
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
  PremiseRelied,
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
  SubjectMinted,
  PremiseSuspected,
  PremiseReaffirmed,
  SketchOpened,
  SketchPromoted,
  SketchExpired,
  SketchDiscarded,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspacePushed,
  WorkspaceCollected,
]);
export type CoordinationEvent = typeof CoordinationEvent.Type;
