import { Effect, Schema } from "effect";
import type { CoordinationEvent } from "../../domain/coordination/index.ts";
import type { DeliveryEvent } from "../../domain/delivery/index.ts";
import type { IdentityEvent, AgentToken } from "../../domain/identity/index.ts";
import { type IntegrationEvent, ProjectNotFound } from "../../domain/integration/index.ts";
import { ProjectId } from "../../domain/kernel/index.ts";
import type { MemoryEvent } from "../../domain/memory/index.ts";
import type { VerificationEvent } from "../../domain/verification/index.ts";
import { Projects } from "../ports/index.ts";

/**
 * Who an event on a project's feed is for: the project's members (its agents,
 * and the observers and operators who read every project), or anyone at all
 * once its operator made the project public.
 */
export type Audience = "members" | "public";

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
 *   standing (suspended, reinstated or revoked, with the reasons), and a
 *   project's settings;
 * - escalations and rulings: the question, its options and the rationale. That
 *   a conflict waits on a ruling is the conflict's own state, so
 *   ConflictEscalated is public;
 * - an agent's sessions: its harness, its model, its sponsor and its messages.
 * No public event carries a sponsor (`onBehalfOf`); `[b12.event-audience]`
 * holds that against the schemas.
 */
export const EVENT_AUDIENCE: Readonly<Record<EventType, Audience>> = {
  AgentEnrolled: "members",
  AgentSuspended: "members",
  AgentReinstated: "members",
  AgentRevoked: "members",

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
  ChangeParked: "public",
  ChangeResumed: "public",
  ChangeAdopted: "public",
  ChangeWithdrawn: "public",
  ChangeSuperseded: "public",
  LeaseLapsed: "public",
  SubjectMinted: "public",
  PremiseSuspected: "public",
  PremiseReaffirmed: "public",
  SketchOpened: "public",
  SketchPromoted: "public",
  SketchExpired: "public",
  SketchDiscarded: "public",
  WorkspaceForked: "public",
  WorkspaceGranted: "public",
  WorkspaceReassigned: "public",
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

  PreviewDeployed: "public",
  PreviewTornDown: "public",
  DeploymentPromoted: "public",
  DeploymentRolledBack: "public",
};

const AUDIENCE = new Map<string, Audience>(Object.entries(EVENT_AUDIENCE));

/** An envelope type's audience: members only for a type this build does not know. */
export const audienceOf = (type: string): Audience => AUDIENCE.get(type) ?? "members";

/** A read that spans every project, or a token's own, asked without a token. */
export class TokenRequired extends Schema.TaggedError<TokenRequired>()("TokenRequired", {}) {}

/**
 * An agent asked to read another project that is not public. A project that
 * does not exist answers the same, so a private project's existence does not
 * leak.
 */
export class ForeignProject extends Schema.TaggedError<ForeignProject>()("ForeignProject", {
  projectId: ProjectId,
}) {}

/** One project's reads, and whether the reader sees its members' events or only the public ones. */
export interface ProjectScope {
  readonly project: ProjectId;
  readonly audience: Audience;
}

/** What a read of the feed covers: every project, or one. */
export type ReadScope =
  | { readonly _tag: "instance" }
  | ({ readonly _tag: "project" } & ProjectScope);

export type ReadRefused = TokenRequired | ProjectNotFound | ForeignProject;

/**
 * Who reads every project at L1: an observer, because Mission Control shows
 * every project (S-0's control project too), and an operator, whose authority
 * is instance-wide.
 */
const readsInstanceWide = (principal: AgentToken): boolean =>
  principal.scopes.includes("observer") || principal.scopes.includes("operator");

const isPublic = (projectId: ProjectId): Effect.Effect<boolean, never, Projects> =>
  Projects.use((projects) => projects.settings(projectId)).pipe(
    Effect.map((settings) => settings.visibility === "public"),
    Effect.catchTag("ProjectNotFound", () => Effect.succeed(false)),
  );

/**
 * Whether `principal` (null without a token) may read `project`, and as whom.
 * An observer or an operator reads any project, and an agent its own, as a
 * member. Anyone reads a public project's public events. Otherwise an agent is
 * refused ForeignProject (403) and a caller without a token ProjectNotFound
 * (404), whether or not the project exists.
 */
export const projectScope = (
  principal: AgentToken | null,
  project: ProjectId,
): Effect.Effect<ProjectScope, ProjectNotFound | ForeignProject, Projects> => {
  if (principal !== null && (readsInstanceWide(principal) || principal.projectId === project))
    return Effect.succeed({ project, audience: "members" });
  return isPublic(project).pipe(
    Effect.flatMap((open): Effect.Effect<ProjectScope, ProjectNotFound | ForeignProject> =>
      open
        ? Effect.succeed({ project, audience: "public" })
        : Effect.fail(
            principal === null
              ? new ProjectNotFound({ projectId: project })
              : new ForeignProject({ projectId: project }),
          ),
    ),
  );
};

/**
 * What a read of the feed covers. Without `asked`: an observer's or operator's
 * read is the whole feed, an agent's is its own project, and a caller without
 * a token is refused, since it may only name one public project. With it, as
 * `projectScope`.
 */
export const readScope = (
  principal: AgentToken | null,
  asked: ProjectId | undefined,
): Effect.Effect<ReadScope, ReadRefused, Projects> => {
  if (asked !== undefined)
    return Effect.map(projectScope(principal, asked), (scope) => ({
      _tag: "project",
      ...scope,
    }));
  if (principal === null) return Effect.fail(new TokenRequired());
  if (readsInstanceWide(principal)) return Effect.succeed({ _tag: "instance" });
  return Effect.succeed({ _tag: "project", project: principal.projectId, audience: "members" });
};

/**
 * The project a read of one project's views is about, and as whom: the one
 * asked for, or the token's own when none is; a caller without a token must
 * name one.
 */
export const viewScope = (
  principal: AgentToken | null,
  asked: ProjectId | undefined,
): Effect.Effect<ProjectScope, ReadRefused, Projects> => {
  const project = asked ?? principal?.projectId;
  return project === undefined
    ? Effect.fail(new TokenRequired())
    : projectScope(principal, project);
};
