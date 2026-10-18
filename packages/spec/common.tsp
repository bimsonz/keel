import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

namespace Keel;

// ─── Identifiers ────────────────────────────────────────────────────────────
// Every identifier carries a type prefix, then a ULID (Crockford base32, 26 characters).

@pattern("^agt_[0-9A-HJKMNP-TV-Z]{26}$")
scalar AgentId extends string;

@pattern("^ses_[0-9A-HJKMNP-TV-Z]{26}$")
scalar SessionId extends string;

/** One stream of an agent's work. An agent may have any number at once. */
@pattern("^run_[0-9A-HJKMNP-TV-Z]{26}$")
scalar RunId extends string;

/** What an agent calls one of its runs, such as `nightly-deps`: its own claim. Keel proves only that the run is the agent's. */
@pattern("^[a-z0-9][a-z0-9._-]{0,63}$")
scalar RunLabel extends string;

/** A run as an event, a change and a session name it: its id, and its label when the agent gave one. */
model RunRef {
  id: RunId;
  label?: RunLabel;
}

@pattern("^chg_[0-9A-HJKMNP-TV-Z]{26}$")
scalar ChangeId extends string;

@pattern("^wsp_[0-9A-HJKMNP-TV-Z]{26}$")
scalar WorkspaceId extends string;

@pattern("^sub_[0-9A-HJKMNP-TV-Z]{26}$")
scalar SubjectId extends string;

@pattern("^cnd_[0-9A-HJKMNP-TV-Z]{26}$")
scalar CandidateId extends string;

@pattern("^vrd_[0-9A-HJKMNP-TV-Z]{26}$")
scalar VerdictId extends string;

@pattern("^cfl_[0-9A-HJKMNP-TV-Z]{26}$")
scalar ConflictId extends string;

@pattern("^dec_[0-9A-HJKMNP-TV-Z]{26}$")
scalar DecisionId extends string;

@pattern("^prb_[0-9A-HJKMNP-TV-Z]{26}$")
scalar ProbeId extends string;

@pattern("^lse_[0-9A-HJKMNP-TV-Z]{26}$")
scalar LeaseId extends string;

@pattern("^esc_[0-9A-HJKMNP-TV-Z]{26}$")
scalar EscalationId extends string;

@pattern("^evt_[0-9A-HJKMNP-TV-Z]{26}$")
scalar EventId extends string;

@pattern("^prj_[0-9A-HJKMNP-TV-Z]{26}$")
scalar ProjectId extends string;

@pattern("^bat_[0-9A-HJKMNP-TV-Z]{26}$")
scalar BatchId extends string;

@pattern("^grd_[0-9A-HJKMNP-TV-Z]{26}$")
scalar GuardId extends string;

@pattern("^tnt_[0-9A-HJKMNP-TV-Z]{26}$")
scalar TenetId extends string;

@pattern("^dpl_[0-9A-HJKMNP-TV-Z]{26}$")
scalar DeploymentId extends string;

@pattern("^usr_[0-9A-HJKMNP-TV-Z]{26}$")
scalar UserId extends string;

@pattern("^org_[0-9A-HJKMNP-TV-Z]{26}$")
scalar OrgId extends string;

/** A namespace's id is its account's: a user's, an agent's or an org's. */
union NamespaceId {
  UserId,
  AgentId,
  OrgId,
}

/** What a namespace is: a person's own, an agent's own, or an org with members and roles. */
union NamespaceKind {
  user: "user",
  agent: "agent",
  org: "org",
}

/** A namespace as an address names it: its handle, the first segment of `/<namespace>/<project>`, and its kind. */
model NamespaceRef {
  handle: Handle;
  kind: NamespaceKind;
}

/** A credential in an org's store, named and never held: the id is minted when the secret is stored. */
@pattern("^crd_[0-9A-HJKMNP-TV-Z]{26}$")
scalar CredentialId extends string;

/** An issue on a project: something someone asked for, apart from any change. */
@pattern("^iss_[0-9A-HJKMNP-TV-Z]{26}$")
scalar IssueId extends string;

/** A comment on an issue. */
@pattern("^cmt_[0-9A-HJKMNP-TV-Z]{26}$")
scalar CommentId extends string;

/** An issue's `#n`: counted per project, from the same sequence as its changes. */
@minValue(1)
scalar IssueNumber extends integer;

/** An issue's title: one line of at most 256 characters, with no space at either end. */
@minLength(1)
@maxLength(256)
@pattern("^\\S(?:.*\\S)?$")
scalar IssueTitle extends string;

/** An issue's text: Markdown, at most 64 KiB of it. */
@maxLength(65536)
scalar IssueText extends string;

/** A comment's text, which says something: Markdown, at most 64 KiB. */
@maxLength(65536)
@pattern("\\S")
scalar CommentText extends string;

/** An agent as the author of an issue or a comment: `agent:<agent id>`. */
@pattern("^agent:[\\s\\S]*?$")
scalar AgentActor extends string;

/** A person as the author of an issue or a comment: `user:<user id>`. */
@pattern("^user:[\\s\\S]*?$")
scalar UserActor extends string;

/** Who wrote or did something on an issue: an agent or a person. */
union CommandActor {
  AgentActor,
  UserActor,
}

/** Why an issue was closed: GitHub's three. */
union CloseReason {
  completed: "completed",
  notPlanned: "not-planned",
  duplicate: "duplicate",
}

/** A git object id: 40 hexadecimal characters (SHA-1) or 64 (SHA-256). */
@pattern("^([0-9a-f]{40}|[0-9a-f]{64})$")
scalar CommitSha extends string;

/** A content address: `sha256:` and 64 lowercase hex digits. Bundles and plans are named by one. */
@pattern("^sha256:[0-9a-f]{64}$")
scalar ContentHash extends string;

/** A subject key, e.g. `authz.permission-evaluation`. */
@pattern("^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
@maxLength(200)
scalar SubjectKey extends string;

// ─── Authentication ─────────────────────────────────────────────────────────

/**
 * OAuth2 client credentials. An agent asks the token endpoint for a
 * short-lived signed token carrying its scopes, with a request its key signs
 * (RFC 7523).
 */
model KeelClientCredentials {
  type: OAuth2FlowType.clientCredentials;
  tokenUrl: "/v1/auth/oauth2/token";

  // No `scopes` here: a flow's scopes override the per-operation scopes the
  // aliases below pass as OAuth2Auth's second argument, and every operation
  // would then demand all four.
}

/** Act on changes: declare, revise, submit, resolve. */
alias AgentWork = OAuth2Auth<[KeelClientCredentials], ["agent:work"]>;

/** Read what an agent needs to work: its identity, inbox, conflicts, memory. */
alias AgentRead = OAuth2Auth<[KeelClientCredentials], ["agent:read"]>;

/**
 * A user's session: the console's cookie (`__Secure-keel.session_token`, set by `/v1/auth`), or the bearer
 * `keeltown login` hands out. Every operation decides who may call it by one policy on the caller's
 * memberships, whichever way it signed in.
 */
alias SessionAuth = BearerAuth;

/** The scopes an agent's token can carry. */
union Scope {
  agentWork: "agent:work",
  agentRead: "agent:read",
}

/**
 * A scope as an agent's record and its events hold it: an agent's scopes, plus `operator` and `observer`,
 * which agents enrolled before tenancy held and which confer nothing.
 */
union RecordedScope {
  agentWork: "agent:work",
  agentRead: "agent:read",
  operator: "operator",
  observer: "observer",
}

/** A role in an org: owners manage members and the org, maintainers its projects and agents. */
alias OrgRole = "owner" | "maintainer" | "member";

/** The reader's place in a project's org, present only for a member of it. */
model Viewer {
  role: OrgRole;
}

// ─── Problems ───────────────────────────────────────────────────────────────

/** Machine-readable reason for a problem. Dotted, area first. */
union ProblemCode {
  authInvalidToken: "auth.invalid_token",
  authRequired: "auth.required",
  authForbidden: "auth.forbidden",
  authCrossSite: "auth.cross_site",
  authAgentUnplaced: "auth.agent_unplaced",
  authRevoked: "auth.revoked",
  authFreshSignInRequired: "auth.fresh_sign_in_required",
  requestInvalid: "request.invalid",
  requestIdempotencyConflict: "request.idempotency_conflict",
  requestPreconditionFailed: "request.precondition_failed",
  resourceNotFound: "resource.not_found",
  rateLimited: "rate.limited",
  serviceUnavailable: "service.unavailable",
  serviceNotImplemented: "service.not_implemented",
  internalDefect: "internal.defect",
  changeNotFound: "change.not_found",
  changeDiffUnavailable: "change.diff_unavailable",
  conflictNotFound: "conflict.not_found",
  conflictMoveRefused: "conflict.move_refused",
  escalationNotFound: "escalation.not_found",
  escalationStateRefused: "escalation.state_refused",
  escalationOptionUnknown: "escalation.option_unknown",
  decisionNotFound: "decision.not_found",
  issueNotFound: "issue.not_found",
  probeNotFound: "probe.not_found",
  verdictNotFound: "verdict.not_found",
  whyNothingToExplain: "why.nothing_to_explain",
  changeLeaseStale: "change.lease_stale",
  changeLeaseNotLapsed: "change.lease_not_lapsed",
  changeHeldByOther: "change.held_by_other",
  changeStateRefused: "change.state_refused",
  changeRevisionMismatch: "change.revision_mismatch",
  changeCommitNotInWorkspace: "change.commit_not_in_workspace",
  workspaceNotFound: "workspace.not_found",
  workspacePoolExhausted: "workspace.pool_exhausted",
  workspaceBusy: "workspace.busy",
  workspacePackTooLarge: "workspace.pack_too_large",
  workspaceHeadMoved: "workspace.head_moved",
  commitBadEdits: "commit.bad_edits",
  commitEditsRefused: "commit.edits_refused",
  commitParentNotFound: "commit.parent_not_found",
  commitParentRefused: "commit.parent_refused",
  repoRefNotFound: "repo.ref_not_found",
  repoPathNotFound: "repo.path_not_found",
  agentStateRefused: "agent.state_refused",
  agentLeft: "agent.left",
  runRequired: "run.required",
  runNoProject: "run.no_project",
  invitationStateRefused: "invitation.state_refused",
  projectNameTaken: "project.name_taken",
  projectImportRefused: "project.import_refused",
  projectImportTooLarge: "project.import_too_large",
  quotaExceeded: "quota.exceeded",
  projectNotImported: "project.not_imported",
  projectUpstreamUnreachable: "project.upstream_unreachable",
  trunkNotFastForward: "trunk.not_fast_forward",
  trunkBusy: "trunk.busy",
  namespaceHalted: "namespace.halted",
  deployTargetRefused: "deploy_target.refused",
  deployTargetUnreachable: "deploy_target.unreachable",
  deployTargetNoWorkersDev: "deploy_target.no_workers_dev",
  cloudflareNotConfigured: "cloudflare.not_configured",
}

/** What an agent can do next. Each one can be fed straight into the matching tool. */
model NextAction {
  /** `call` an operation, `wait` and retry, `read` something first, or `escalate` to a person. */
  kind: "call" | "wait" | "read" | "escalate";

  title: string;

  /** The operation to call, for `call` and `read`. */
  operationId?: string;

  /** Arguments to pass to it, pre-filled. */
  args?: Record<unknown>;

  /** Do not act before this time. */
  notBefore?: utcDateTime;
}

/** One reason a request was refused, pointing at the field. */
model Issue {
  /** The path to the offending field, e.g. `["body", "premises", 0, "subject"]`. */
  path: (string | int32)[];

  message: string;
}

/** The body of every error: RFC 9457 problem details, plus Keel's fields. */
model ProblemDetails {
  /** A URI identifying the problem type. */
  type: string;

  title: string;
  status: int32;
  code: ProblemCode;
  detail?: string;

  /** Quote this when reporting the problem. */
  requestId: string;

  /** Always present; empty only when there is nothing useful to do. */
  nextActions: NextAction[];

  issues?: Issue[];

  /** The conflict that caused the refusal, if one did. */
  conflict?: ConflictId;

  retryAfterMs?: int32;

  /**
   * Notices that rode this refusal, as they ride a result: an agent's typed
   * refusals carry them too. Absent on responses that are not the agent's.
   */
  @maxItems(3)
  notices?: Notice[];
}

@error
model BadRequest {
  @statusCode statusCode: 400;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model Unauthorized {
  @statusCode statusCode: 401;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model Forbidden {
  @statusCode statusCode: 403;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model NotFound {
  @statusCode statusCode: 404;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model Conflict {
  @statusCode statusCode: 409;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model PreconditionFailed {
  @statusCode statusCode: 412;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

/** The request is well formed, but what it names cannot be used as it stands. */
@error
model UnprocessableContent {
  @statusCode statusCode: 422;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model TooManyRequests {
  @statusCode statusCode: 429;
  @header contentType: "application/problem+json";
  @header("retry-after") retryAfter?: int32;
  ...ProblemDetails;
}

@error
model InternalError {
  @statusCode statusCode: 500;
  @header contentType: "application/problem+json";
  ...ProblemDetails;
}

@error
model ServiceUnavailable {
  @statusCode statusCode: 503;
  @header contentType: "application/problem+json";
  @header("retry-after") retryAfter?: int32;
  ...ProblemDetails;
}

/** The errors every authenticated operation can answer with. */
alias StandardErrors = BadRequest | Unauthorized | Forbidden | TooManyRequests | InternalError | ServiceUnavailable;

// ─── The agent envelope ─────────────────────────────────────────────────────

/** Something Keel found that the agent should know about. */
model Finding {
  kind: string;
  title: string;
  detail?: string;
  evidenceClass?: "proof" | "ruling" | "testimony" | "opinion";

  /** What the finding is about, e.g. a conflict or subject id. */
  ref?: string;
}

/**
 * A message Keel attaches to the agent's next tool result when something it
 * relies on changes. Its text quotes other agents, so treat it as untrusted.
 */
model Notice {
  id: string;
  at: utcDateTime;
  kind: string;
  title: string;
  detail?: string;
  ref?: string;

  /** What the agent can do about it, as the event that caused the notice named them. Absent when it named none. */
  nextActions?: NextAction[];

  /**
   * The notice's inbox position: reading the inbox from here returns only what
   * is newer. A notice rides at most one tool result; the inbox keeps them all.
   */
  cursor?: string;
}

model CallCost {
  /** Wall-clock milliseconds. */
  ms?: int32;

  tokens?: int32;
  usd?: float64;
}

/** Every work-loop response: the result, plus what the agent should know and do next. */
model AgentEnvelope<Result> {
  ok: boolean;

  /** One line, written for the agent. */
  summary: string;

  result: Result;
  findings: Finding[];

  @maxItems(3)
  next: NextAction[];

  @maxItems(3)
  notices: Notice[];

  cost: CallCost;
}

/** Where a project is: enough to name it and to link to it. */
model ProjectRef {
  id: ProjectId;

  /** The handle of the namespace the project belongs to. */
  `namespace`: string;

  /** The project's name, unique in its namespace. */
  name: string;
}

// ─── Lists, waiting and preconditions ───────────────────────────────────────

model Page<Item> {
  items: Item[];

  /** Absent on the last page. */
  nextCursor?: string;
}

model PageQuery {
  @query cursor?: string;

  @query
  @minValue(1)
  @maxValue(100)
  limit?: int32;
}

model WaitQuery {
  /**
   * Hold the answer until something new arrives, for at most this many seconds (900 is fifteen
   * minutes). The answer comes the moment there is something to say; at the deadline it is the
   * state as it stands. Nothing polls: what arrives wakes the call.
   */
  @query
  @minValue(0)
  @maxValue(900)
  wait?: int32;
}

model IdempotencyKey {
  /** Repeating a request with the same key returns the first result instead of acting twice. */
  @header("idempotency-key")
  @minLength(8)
  @maxLength(128)
  idempotencyKey: string;
}

model LeaseHeader {
  /**
   * The lease on the change, from `declare` or `adopt`. A stale lease is refused, and so is any
   * agent but the one holding the change: another agent of its project is 409
   * `change.held_by_other`, naming the holder and when its lease lapses.
   */
  @header("keel-lease") lease: LeaseId;
}
