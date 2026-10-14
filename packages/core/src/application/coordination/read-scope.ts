import type { Effect } from "effect";
import type { CoordinationEvent } from "../../domain/coordination/index.ts";
import type { DeliveryEvent } from "../../domain/delivery/index.ts";
import type { Audience, IdentityEvent } from "../../domain/identity/index.ts";
import type { IntegrationEvent } from "../../domain/integration/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";
import type { MemoryEvent } from "../../domain/memory/index.ts";
import type { VerificationEvent } from "../../domain/verification/index.ts";

type EventType = (
  | IdentityEvent
  | CoordinationEvent
  | IntegrationEvent
  | VerificationEvent
  | MemoryEvent
  | DeliveryEvent
)["_tag"];

/**
 * Each event type's audience. Exhaustive, so a new event type does not compile
 * until it is placed here. Members only:
 * - operator data: an agent's enrolment (its scopes and its sponsor) and its
 *   standing (suspended, reinstated or revoked, with the reasons), a
 *   project's settings and deploy targets (an account and a credential's id),
 *   and the credentials an org stores (their labels, never their secrets);
 * - escalations and rulings: the question, its options and the rationale. That
 *   a conflict waits on a ruling is the conflict's own state, so
 *   ConflictEscalated is public;
 * - an agent's sessions: its harness, its model, its sponsor and its messages.
 * No public event carries a sponsor (`sponsor`); `[b12.event-audience]`
 * holds that against the schemas.
 */
export const EVENT_AUDIENCE: Readonly<Record<EventType, Audience>> = {
  AgentEnrolled: "members",
  // An agent's handle and its key are public, as a person's username is.
  AgentSignedUp: "public",
  AgentSuspended: "members",
  AgentReinstated: "members",
  AgentRevoked: "members",
  AgentSponsored: "members",
  AgentUnsponsored: "members",
  // An invitation and its end name the member or whoever ended it; that an agent joined names no person.
  AgentInvited: "members",
  AgentJoinedNamespace: "public",
  AgentLeftNamespace: "members",
  // A project's invitation, as an org's: only the joining names no person.
  AgentInvitedToProject: "members",
  AgentJoinedProject: "public",
  AgentLeftProject: "members",
  UserSignedUp: "members",
  OrgCreated: "members",
  MembershipChanged: "members",
  UserSuspended: "members",
  UserReinstated: "members",
  OrgSuspended: "members",
  OrgReinstated: "members",
  OrgDeleted: "members",

  IntentDeclared: "public",
  PreflightIssued: "public",
  IntentRevised: "public",
  ChangeStarted: "public",
  PremiseRelied: "public",
  ChangeSubmitted: "public",
  ChangeRebased: "public",
  PrecheckStarted: "public",
  EffectsDerived: "public",
  DriftDetected: "public",
  ChangeDrifted: "public",
  PlanCompiled: "public",
  ChangeQueued: "public",
  ChangeBatched: "public",
  ChangeRequeued: "public",
  ChangeLanded: "public",
  ChangeBounced: "public",
  ConflictNoted: "public",
  AlternativeDeclared: "public",
  AlternativeLanded: "public",
  ChangeParked: "public",
  ChangeResumed: "public",
  ChangeAdopted: "public",
  ChangeWithdrawn: "public",
  ChangeSuperseded: "public",
  LeaseLapsed: "public",
  SubjectMinted: "public",
  PremiseSuspected: "public",
  PremiseReaffirmed: "public",
  WorkspaceForked: "public",
  WorkspaceGranted: "public",
  WorkspacePushed: "public",
  WorkspaceCollected: "public",

  BatchFormed: "public",
  CandidateAssembled: "public",
  VerificationStarted: "public",
  BatchVerified: "public",
  BatchFailed: "public",
  CandidateBisected: "public",
  CandidateInvalidated: "public",
  CandidatePromoted: "public",
  TrunkAdvanced: "public",
  PromotionDeclined: "public",
  PromotionFrozen: "public",
  PromotionResumed: "public",
  ProjectCreated: "public",
  ProjectDeleted: "members",
  ProjectSettingsChanged: "members",
  TrunkInitialized: "public",
  PromotionStarted: "public",
  PromotionComposed: "public",
  AuditCompleted: "public",

  ConflictSuspected: "public",
  ProbeDrafted: "public",
  ProbeRan: "public",
  WorldCheckRan: "public",
  ProbeDiscarded: "public",
  ConflictProven: "public",
  ConflictDismissed: "public",
  ConflictEscalated: "public",
  ConflictResolved: "public",
  GuardAdmitted: "public",
  GuardRetired: "public",
  GuardFailed: "public",
  VerdictIssued: "public",
  EscalationRaised: "members",
  EscalationWithdrawn: "members",
  EscalationWidened: "members",

  RulingGiven: "members",
  DecisionRecorded: "public",
  DecisionSuperseded: "public",
  DecisionOverruled: "public",
  PrecedentSurfaced: "public",
  PrecedentFollowed: "public",
  PrecedentDistinguished: "public",
  OverruleRequested: "members",
  TenetEstablished: "public",
  TenetContested: "public",
  TenetReaffirmed: "public",
  TenetRetracted: "public",
  TenetSuperseded: "public",
  SessionOpened: "members",
  MessagesCaptured: "members",
  SessionRedacted: "members",

  // An org's credentials, by label, provider and who stored them: never the secret, and still the owners' alone to read.
  CredentialStored: "members",
  CredentialRemoved: "members",
  DeployTargetSet: "members",
  DeployTargetCleared: "members",
  PreviewDeployed: "public",
  PreviewTornDown: "public",
  DeploymentPromoted: "public",
  DeploymentRolledBack: "public",
};

const AUDIENCE = new Map<string, Audience>(Object.entries(EVENT_AUDIENCE));

/** An envelope type's audience: members only for a type this build does not know. */
export const audienceOf = (type: string): Audience => AUDIENCE.get(type) ?? "members";

/**
 * One project's reads, as the doorway authorised them: whether the reader sees
 * its members' events or only the public ones.
 */
export interface ProjectScope {
  readonly project: ProjectId;
  readonly audience: Audience;
}

/**
 * What a read of the feed covers, as the doorway authorised it: one project,
 * or every project readable to a reader who named none. `audienceOf` answers
 * how that reader sees a project, or undefined where it may not read it; an
 * event no project owns is never in such a read.
 */
export type FeedScope =
  | { readonly _tag: "Project"; readonly project: ProjectId; readonly audience: Audience }
  | {
      readonly _tag: "Readable";
      readonly audienceOf: (project: ProjectId) => Effect.Effect<Audience | undefined>;
    };
