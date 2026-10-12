// The envelope every published Keel event arrives in, and the catalogue's event
// names. Both are Keel's own: `EventRecord` and `KeelEvent` in its generated
// wire types (./keel). What is written here is only the list of names, which
// the reader and the fixtures' check need at run time, and it is held to the
// generated catalogue in both directions.

import type { EntityKind, EntityRef, EventRecord, KeelEvent as Published } from "./keel/index.ts";

export type { EntityKind, EntityRef };

export const EVENT_TYPES = [
  // identity
  "AgentEnrolled",
  "AgentSuspended",
  "AgentReinstated",
  "AgentRevoked",
  "UserSignedUp",
  "OrgCreated",
  "MembershipChanged",
  "UserSuspended",
  "UserReinstated",
  "OrgSuspended",
  "OrgReinstated",
  "OrgDeleted",
  // coordination: changes
  "IntentDeclared",
  "ChangeStarted",
  "PreflightIssued",
  "IntentRevised",
  "PremiseRelied",
  "ChangeSubmitted",
  "ChangeRebased",
  "PrecheckStarted",
  "EffectsDerived",
  "DriftDetected",
  "ChangeDrifted",
  "PlanCompiled",
  "ChangeQueued",
  "ChangeBatched",
  "ChangeRequeued",
  "ChangeLanded",
  "ChangeBounced",
  "ConflictNoted",
  "AlternativeDeclared",
  "AlternativeLanded",
  "ChangeParked",
  "ChangeResumed",
  "ChangeAdopted",
  "ChangeWithdrawn",
  "ChangeSuperseded",
  "LeaseLapsed",
  // coordination: subjects and premises
  "SubjectMinted",
  "PremiseSuspected",
  "PremiseReaffirmed",
  // coordination: sketches and workspaces
  "SketchOpened",
  "SketchPromoted",
  "SketchExpired",
  "SketchDiscarded",
  "WorkspaceForked",
  "WorkspaceGranted",
  "WorkspaceReassigned",
  "WorkspacePushed",
  "WorkspaceCollected",
  // verification
  "ConflictSuspected",
  "ProbeDrafted",
  "ProbeRan",
  "WorldCheckRan",
  "ProbeDiscarded",
  "ConflictProven",
  "ConflictDismissed",
  "ConflictEscalated",
  "ConflictResolved",
  "GuardAdmitted",
  "GuardRetired",
  "GuardFailed",
  "VerdictIssued",
  "EscalationRaised",
  "EscalationWithdrawn",
  // integration
  "BatchFormed",
  "CandidateAssembled",
  "VerificationStarted",
  "BatchVerified",
  "BatchFailed",
  "CandidateBisected",
  "CandidateInvalidated",
  "CandidatePromoted",
  "ProjectCreated",
  "ProjectDeleted",
  "ProjectSettingsChanged",
  "TrunkInitialized",
  "PromotionStarted",
  "PromotionComposed",
  "TrunkAdvanced",
  "PromotionDeclined",
  "PromotionFrozen",
  "PromotionResumed",
  "AuditCompleted",
  // memory
  "RulingGiven",
  "DecisionRecorded",
  "DecisionSuperseded",
  "DecisionOverruled",
  "PrecedentSurfaced",
  "PrecedentFollowed",
  "PrecedentDistinguished",
  "OverruleRequested",
  "TenetEstablished",
  "TenetContested",
  "TenetReaffirmed",
  "TenetRetracted",
  "TenetSuperseded",
  "SessionOpened",
  "MessagesCaptured",
  "SessionRedacted",
  // delivery
  "DeployTargetSet",
  "DeployTargetCleared",
  "PreviewDeployed",
  "PreviewTornDown",
  "DeploymentPromoted",
  "DeploymentRolledBack",
] as const satisfies readonly Published["_tag"][];

export type EventType = (typeof EVENT_TYPES)[number];

type Assert<Holds extends true> = Holds;

/** Compiles only while the list above names every event in Keel's catalogue. A new event fails here first. */
export type CatalogueIsWhole = Assert<
  [Exclude<Published["_tag"], EventType>] extends [never] ? true : false
>;

/**
 * One entry of Keel's log, as Keel publishes it: who it is about, its place in that entity's own sequence,
 * when, who caused it (`agent:<AgentId>` or `user:<UserId>`, absent when the platform did; `operator:<by>` is
 * how a person was named before Keel had users, read in older entries and never written), the project, and the
 * short name Keel's Projector gave what the event created (#7, C-1, P-1, G-1, E-1, D-1). The console numbers
 * nothing itself. `type` tells the payload apart.
 */
export interface KeelEvent<
  Type extends EventType = EventType,
  Payload = Record<string, unknown>,
> extends Omit<EventRecord, "type" | "entity" | "payload"> {
  type: Type;
  entity: EntityRef;
  payload: Payload;
}
