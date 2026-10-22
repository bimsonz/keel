import {
  DerivedEffect,
  Intent,
  PreflightCompared,
  ProposalLimit,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import {
  ConnectStateRefused,
  DeliveryRefused,
  Deployment,
  DeployTarget,
  DeployTargetName,
  DeployTargetRefused,
  PendingConnect,
} from "@keeltown/core/domain/delivery";
import {
  IdempotencyConflict,
  Invitation,
  InvitationRefused,
  InvitationScopes,
  QuotaExceeded,
} from "@keeltown/core/domain/identity";
import { ProjectNotFound } from "@keeltown/core/domain/integration";
import {
  CloseReason,
  CommentText,
  Issue,
  IssueComment,
  IssueNotFound,
  IssueNumber,
  IssueText,
  IssueTitle,
} from "@keeltown/core/domain/issues";
import {
  CommandActor,
  AgentId,
  Anchor,
  CandidateId,
  ChangeId,
  CommitSha,
  DeploymentId,
  Glob,
  InstantSchema,
  NamespaceId,
  ProjectId,
  RunRef,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { RepoRef } from "./workspace-pool.ts";

/** Whether the project's lane verifies each batch: `off` passes each batch unverified. */
export const Verification = Schema.Literals(["required", "off"]);

/** Who may read the project: `public` lets anonymous readers in; `private` is the default. */
export const Visibility = Schema.Literals(["private", "public"]);

/** Whether a fork may propose to the project: `open` is the default; a private project takes none. */
export const Proposals = Schema.Literals(["open", "closed"]);

/** The project's settings as the Project DO answers them: `verification`, `visibility` and `proposals` always present. */
export const ProjectSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
  verification: Verification,
  visibility: Visibility,
  proposals: Proposals,
});

/**
 * Replace the project's settings (an absent `verification` is `required`, an
 * absent `visibility` `private`, absent `proposals` `open`). `by` is the actor's id, a person's or an
 * agent's in a namespace of its own; `actor` is the same actor as the envelope
 * names it, and `run` the run an agent changes them in, when its token named
 * one. The Project DO commits one ProjectSettingsChanged naming every changed
 * field, with `by`, under that actor and run; an unchanged PUT commits nothing. `requestId` keys the commit: a replay answers the settings
 * as they stand, and the same id with other settings is IdempotencyConflict.
 */
export const PutSettingsCommand = Schema.Struct({
  projectId: ProjectId,
  settings: Schema.Struct({
    protectedPaths: Schema.Array(Glob),
    maxBatchSize: Schema.Int,
    verification: Schema.optional(Verification),
    visibility: Schema.optional(Visibility),
    proposals: Schema.optional(Proposals),
  }),
  by: Schema.NonEmptyString,
  actor: CommandActor,
  run: Schema.optional(RunRef),
  requestId: Schema.NonEmptyString,
});

/**
 * Create the project this DO is named for. The isolate derives `projectId`
 * from the actor and the Idempotency-Key, so a retry reaches the same DO,
 * which replays by `idempotencyKey` and refuses another body (`fingerprint`)
 * with IdempotencyConflict. `by` is the id of who creates it, a person or an
 * agent in a namespace of its own; `actor` is the same creator as the commit's
 * envelope names it, and `run` the run an agent creates it in, when its token
 * named one. Trunk is made by `source`: Keel's own first commit for an
 * empty project, a public Git repository imported once, another project's
 * trunk forked, or a template forked. Trunk is initialised at its first
 * head, with where it came from; staging is forked from trunk; the
 * per-project mirror is created empty in the workspace namespace and trunk's
 * head is pushed into it; then the pool is configured.
 */
export const CreateProjectCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  /** Where trunk starts, as the doorway read it from the request. */
  source: Schema.Union([
    Schema.TaggedStruct("Empty", {}),
    Schema.TaggedStruct("Import", {
      url: Schema.NonEmptyString,
      ref: Schema.optional(Schema.NonEmptyString),
    }),
    Schema.TaggedStruct("Project", { projectId: ProjectId }),
    Schema.TaggedStruct("Template", { repo: Schema.NonEmptyString }),
  ]),
  by: Schema.NonEmptyString,
  actor: CommandActor,
  run: Schema.optional(RunRef),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const ProjectView = Schema.Struct({
  id: ProjectId,
  name: Schema.NonEmptyString,
  createdAt: InstantSchema,
});

/**
 * CodeHost's RepoNotFound, by shape: this folder cannot import the ports (rule
 * R15), so the DO answers the port's error as is and the caller rebuilds it.
 */
export const RepoNotFound = Schema.TaggedStruct("RepoNotFound", { repo: RepoRef });

/** CodeHost's ImportRefused, by shape (rule R15): the code host imported nothing from the URL. */
export const ImportRefused = Schema.TaggedStruct("ImportRefused", {
  reason: Schema.Literals(["not-found", "not-git", "unreachable", "too-large", "no-branch"]),
});

/** The Trunks port's ImportTooLarge, by shape (rule R15): an imported history over what one relay carries. */
export const ImportTooLarge = Schema.TaggedStruct("ImportTooLarge", {
  projectId: Schema.String,
  bytes: Schema.Number,
  limit: Schema.Number,
});

/** One live change in the project's index: its current intent and the effects last derived for it. */
export const LiveChangeView = Schema.Struct({
  id: ChangeId,
  intent: Intent,
  derived: Schema.Array(DerivedEffect),
});

/** Read the live changes near a change's intent (the port's `near`): `self` is left out. */
export const LiveNearRead = Schema.Struct({
  self: ChangeId,
  intent: Intent,
});

/** The live changes near an intent, in change id order, and what finding them compared: the port's `LiveNear`. */
export const LiveNearView = Schema.Struct({
  changes: Schema.Array(LiveChangeView),
  compared: PreflightCompared,
});

/** A live subject and the code it is anchored to: the domain's `SubjectAnchors`, as it crosses RPC. */
export const SubjectAnchorsView = Schema.Struct({
  subject: SubjectKey,
  anchors: Schema.Array(Anchor),
});

/**
 * The person whose namespace the project is in invites an agent to it (core's
 * `InviteAgent`). `namespace` is that namespace, which the invitation's events
 * name; the object's own address says which project. The commit's cause is
 * `invite:<agentId>:<idempotencyKey>`.
 */
export const InviteToProjectCommand = Schema.Struct({
  namespace: NamespaceId,
  agentId: AgentId,
  by: UserId,
  scopes: InvitationScopes,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** The agent accepts its invitation to the project (core's `AcceptInvitation`): `run` is the run it answers in, from its token. */
export const AcceptProjectInvitationCommand = Schema.Struct({
  namespace: NamespaceId,
  agentId: AgentId,
  run: Schema.optional(RunRef),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * An invitation to the project ends (core's `EndInvitation`): `by` is the
 * agent itself or a person, the event's `by` and the commit's actor, and `run`
 * the run an agent ends it in.
 */
export const EndProjectInvitationCommand = Schema.Struct({
  namespace: NamespaceId,
  agentId: AgentId,
  by: CommandActor,
  run: Schema.optional(RunRef),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** A deploy target as the Project DO holds it: the record, and the workers.dev subdomain its account answered. */
export const HeldDeployTargetView = Schema.Struct({
  target: DeployTarget,
  workersDev: Schema.optional(Schema.String),
});

/**
 * Set one of the project's deploy targets (core's `SetProjectDeployTarget`):
 * `credentialInOrg` is whether the credential is the project's namespace's,
 * as the caller read it, and `workersDev` what the account answered. The
 * Project DO decides with `setDeployTarget` over the targets it holds and
 * commits DeployTargetSet; `requestId` keys the commit.
 */
export const SetDeployTargetCommand = Schema.Struct({
  projectId: ProjectId,
  target: DeployTarget,
  by: UserId,
  credentialInOrg: Schema.Boolean,
  workersDev: Schema.optional(Schema.String),
  requestId: Schema.NonEmptyString,
});

/** Clear one of the project's deploy targets (core's `ClearProjectDeployTarget`), committing DeployTargetCleared. */
export const ClearDeployTargetCommand = Schema.Struct({
  projectId: ProjectId,
  name: DeployTargetName,
  by: UserId,
  requestId: Schema.NonEmptyString,
});

/** Hold a Connect its owner begins (core's `HoldProjectConnect`), in place of one they began before. */
export const HoldConnectCommand = Schema.Struct({
  projectId: ProjectId,
  by: UserId,
  target: DeployTargetName,
  nonce: Schema.NonEmptyString,
  verifier: Schema.NonEmptyString,
});

/** Take the Connect its owner began (core's `TakeProjectConnect`), by the nonce its callback carried. */
export const TakeConnectCommand = Schema.Struct({
  projectId: ProjectId,
  by: UserId,
  nonce: Schema.String,
});

/**
 * Keep a candidate's deployment (core's `recordDeployment`), in place of any
 * kept for it before. It commits no event; a replay of the same deployment
 * leaves it as it stands.
 */
export const RecordDeploymentCommand = Schema.Struct({
  projectId: ProjectId,
  deployment: Deployment,
});

/** Read the deployment the project keeps for a candidate (core's `deploymentOf`). */
export const DeploymentOfCommand = Schema.Struct({
  projectId: ProjectId,
  candidateId: CandidateId,
});

/**
 * Trunk was deployed as one of the project's deployments (core's
 * `promoteDeployment`): marks it promoted to `trunkSha` and commits
 * DeploymentPromoted, once. One the project does not hold commits nothing.
 */
export const DeploymentPromotedCommand = Schema.Struct({
  projectId: ProjectId,
  deploymentId: DeploymentId,
  trunkSha: CommitSha,
});

/**
 * Trunk advanced and Keel deployed nothing (core's `refuseDelivery`): commits
 * DeliveryRefused with these fields, once per `trunkSha`.
 */
export const DeliveryRefusedCommand = Schema.Struct({
  projectId: ProjectId,
  trunkSha: CommitSha,
  candidateId: Schema.optional(CandidateId),
  reason: DeliveryRefused.fields.reason,
  detail: Schema.String,
});

/**
 * Open an issue on the project (core's `OpenIssue`): `author` is the person or
 * the agent the policy let through. The commit's cause is
 * `open-issue:<author>:<idempotencyKey>`.
 */
export const OpenIssueCommand = Schema.Struct({
  title: IssueTitle,
  body: IssueText,
  author: CommandActor,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * Reserve the change id of a proposal to the project (core's
 * `reserveProposal`), by its proposer's Idempotency-Key: `fingerprint` hashes
 * the request, so a reused key is told apart from a retry.
 */
export const ReserveProposalCommand = Schema.Struct({
  proposer: CommandActor,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** The place a proposal refused before it was made gives back, by its proposer's key. */
export const ReleaseProposalCommand = Schema.Struct({
  proposer: CommandActor,
  idempotencyKey: Schema.String,
});

/** What is done to an issue by its `#n` (core's `IssueMove`). */
export const IssueMove = Schema.Union([
  Schema.TaggedStruct("Comment", { body: CommentText }),
  Schema.TaggedStruct("Close", { reason: CloseReason }),
  Schema.TaggedStruct("Reopen", {}),
]);

/** Comment on, close or reopen issue `#n` (core's `MoveIssue`): `by` is who the policy let through. */
export const MoveIssueCommand = Schema.Struct({
  number: IssueNumber,
  move: IssueMove,
  by: CommandActor,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** A page of the project's issues, newest first, below `before` when given. */
export const IssuesRead = Schema.Struct({
  state: Schema.optional(Schema.Literals(["open", "closed"])),
  before: Schema.optional(IssueNumber),
  limit: Schema.Int,
});

export const IssueRead = Schema.Struct({ number: IssueNumber });

export const IssuePageView = Schema.Struct({
  items: Schema.Array(Issue),
  next: Schema.optional(IssueNumber),
  open: Schema.Int,
  closed: Schema.Int,
});

export const IssueThreadView = Schema.Struct({
  issue: Issue,
  comments: Schema.Array(IssueComment),
});

/** An issue after a move on it, and the comment a comment made. */
export const IssueMovedView = Schema.Struct({
  issue: Issue,
  comment: Schema.optional(IssueComment),
});

const invitationMove = exitCodec(
  Invitation,
  Schema.Union([InvitationRefused, IdempotencyConflict]),
);

export const ProjectCodecs = {
  inviteAgent: invitationMove,
  acceptInvitation: invitationMove,
  endInvitation: invitationMove,
  liveNear: exitCodec(LiveNearView, Schema.Never),
  liveAnchors: exitCodec(Schema.Array(SubjectAnchorsView), Schema.Never),
  settings: exitCodec(ProjectSettings, ProjectNotFound),
  putSettings: exitCodec(ProjectSettings, Schema.Union([ProjectNotFound, IdempotencyConflict])),
  deployTargets: exitCodec(Schema.Array(HeldDeployTargetView), ProjectNotFound),
  setDeployTarget: exitCodec(
    HeldDeployTargetView,
    Schema.Union([ProjectNotFound, DeployTargetRefused, IdempotencyConflict]),
  ),
  clearDeployTarget: exitCodec(Schema.Void, Schema.Union([ProjectNotFound, DeployTargetRefused])),
  holdConnect: exitCodec(Schema.Void, ProjectNotFound),
  takeConnect: exitCodec(PendingConnect, Schema.Union([ProjectNotFound, ConnectStateRefused])),
  recordDeployment: exitCodec(Schema.Void, ProjectNotFound),
  deploymentOf: exitCodec(Schema.UndefinedOr(Deployment), ProjectNotFound),
  deploymentPromoted: exitCodec(Schema.Void, ProjectNotFound),
  deliveryRefused: exitCodec(Schema.Void, ProjectNotFound),
  openIssue: exitCodec(Issue, IdempotencyConflict),
  reserveProposal: exitCodec(ChangeId, Schema.Union([ProposalLimit, IdempotencyConflict])),
  releaseProposal: exitCodec(Schema.Void, Schema.Never),
  moveIssue: exitCodec(IssueMovedView, Schema.Union([IssueNotFound, IdempotencyConflict])),
  issues: exitCodec(IssuePageView, Schema.Never),
  issue: exitCodec(IssueThreadView, IssueNotFound),
  createProject: exitCodec(
    ProjectView,
    Schema.Union([IdempotencyConflict, RepoNotFound, ImportRefused, QuotaExceeded, ImportTooLarge]),
  ),
};

/** The Project DO (`project:<id>`): settings and the subject registry. */
export interface ProjectRpc extends EventReceiverRpc {
  /** The project's live changes, all of them, from each one's declare until it ends. */
  /** The project's live changes near a change's intent, read by key, for its preflight. */
  liveNear(read: typeof LiveNearRead.Encoded): Promise<ExitJson>;
  /** Where the project's live changes anchor their subjects in code, for Precheck's derivation. */
  liveAnchors(): Promise<ExitJson>;
  settings(): Promise<ExitJson>;
  putSettings(command: typeof PutSettingsCommand.Encoded): Promise<ExitJson>;
  /** The project's deploy targets, in name order, each with what its account answered. */
  deployTargets(): Promise<ExitJson>;
  /** Sets one of the project's deploy targets, committing DeployTargetSet. */
  setDeployTarget(command: typeof SetDeployTargetCommand.Encoded): Promise<ExitJson>;
  /** Clears one of the project's deploy targets, committing DeployTargetCleared. */
  clearDeployTarget(command: typeof ClearDeployTargetCommand.Encoded): Promise<ExitJson>;
  /** Holds a Connect its owner begins, in place of one they began before; commits nothing. */
  holdConnect(command: typeof HoldConnectCommand.Encoded): Promise<ExitJson>;
  /** Takes the Connect its owner began, if the nonce is its own and its window open; it is gone after. */
  takeConnect(command: typeof TakeConnectCommand.Encoded): Promise<ExitJson>;
  /** Keeps a candidate's deployment, in place of any kept for it before; commits nothing. */
  recordDeployment(command: typeof RecordDeploymentCommand.Encoded): Promise<ExitJson>;
  /** The deployment the project keeps for a candidate, or undefined. */
  deploymentOf(command: typeof DeploymentOfCommand.Encoded): Promise<ExitJson>;
  /** Marks a deployment promoted to trunk's commit, committing DeploymentPromoted once. */
  deploymentPromoted(command: typeof DeploymentPromotedCommand.Encoded): Promise<ExitJson>;
  /** Commits DeliveryRefused: trunk advanced and Keel deployed nothing. */
  deliveryRefused(command: typeof DeliveryRefusedCommand.Encoded): Promise<ExitJson>;
  createProject(command: typeof CreateProjectCommand.Encoded): Promise<ExitJson>;
  /** The person whose namespace the project is in invites an agent to it alone, idempotent by key. */
  inviteAgent(command: typeof InviteToProjectCommand.Encoded): Promise<ExitJson>;
  /** The invited agent accepts. */
  acceptInvitation(command: typeof AcceptProjectInvitationCommand.Encoded): Promise<ExitJson>;
  /** The agent's invitation to the project ends: it declines or leaves, or the person takes it off. */
  endInvitation(command: typeof EndProjectInvitationCommand.Encoded): Promise<ExitJson>;
  /** Opens an issue with the project's next `#n`, idempotent by its author's key. */
  openIssue(command: typeof OpenIssueCommand.Encoded): Promise<ExitJson>;
  /** Reserves a proposal's change id by its proposer's key, within what one proposer may have open. */
  reserveProposal(command: typeof ReserveProposalCommand.Encoded): Promise<ExitJson>;
  /** Gives back the place a proposal refused before it was made reserved, by its proposer's key. */
  releaseProposal(command: typeof ReleaseProposalCommand.Encoded): Promise<ExitJson>;
  /** Comments on, closes or reopens issue `#n`, idempotent by the caller's key. */
  moveIssue(command: typeof MoveIssueCommand.Encoded): Promise<ExitJson>;
  /** A page of the project's issues, newest first, with the open and closed totals. */
  issues(read: typeof IssuesRead.Encoded): Promise<ExitJson>;
  /** Issue `#n` and its comments, oldest first. */
  issue(read: typeof IssueRead.Encoded): Promise<ExitJson>;
}
