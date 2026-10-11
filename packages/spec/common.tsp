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

@pattern("^chg_[0-9A-HJKMNP-TV-Z]{26}$")
scalar ChangeId extends string;

@pattern("^wsp_[0-9A-HJKMNP-TV-Z]{26}$")
scalar WorkspaceId extends string;

@pattern("^sk_[0-9A-HJKMNP-TV-Z]{26}$")
scalar SketchId extends string;

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

/**
 * A sponsor: the human an agent acts on behalf of, accountable for its changes
 * and the first person an escalation goes to. A `scheme:value` address, e.g.
 * `github:octocat` or `mailto:a@example.com`.
 */
@pattern("^[a-z][a-z0-9+.-]*:\\S.*$")
@maxLength(256)
scalar Sponsor extends string;

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
 * OAuth2 client credentials. A client exchanges its id and secret at the token
 * endpoint for a short-lived Ed25519-signed JWT carrying its scopes.
 */
model KeelClientCredentials {
  type: OAuth2FlowType.clientCredentials;
  tokenUrl: "/v1/oauth/token";

  // No `scopes` here: a flow's scopes override the per-operation scopes the
  // aliases below pass as OAuth2Auth's second argument, and every operation
  // would then demand all four.
}

/** Act on changes: declare, revise, submit, resolve. */
alias AgentWork = OAuth2Auth<[KeelClientCredentials], ["agent:work"]>;

/** Read what an agent needs to work: its identity, inbox, conflicts, memory. */
alias AgentRead = OAuth2Auth<[KeelClientCredentials], ["agent:read"]>;

/** Administer projects, agents and rulings. */
alias OperatorScope = OAuth2Auth<[KeelClientCredentials], ["operator"]>;

/** Read-only views of the whole system, e.g. for Mission Control. */
alias Observer = OAuth2Auth<[KeelClientCredentials], ["observer"]>;

/** The scopes a token can carry. */
union Scope {
  agentWork: "agent:work",
  agentRead: "agent:read",
  operator: "operator",
  observer: "observer",
}

// ─── Problems ───────────────────────────────────────────────────────────────

/** Machine-readable reason for a problem. Dotted; lanes add codes as they build. */
union ProblemCode {
  authInvalidToken: "auth.invalid_token",
  authInsufficientScope: "auth.insufficient_scope",
  authRevoked: "auth.revoked",
  requestInvalid: "request.invalid",
  requestIdempotencyConflict: "request.idempotency_conflict",
  requestPreconditionFailed: "request.precondition_failed",
  resourceNotFound: "resource.not_found",
  rateLimited: "rate.limited",
  serviceUnavailable: "service.unavailable",
  serviceNotImplemented: "service.not_implemented",
  internalDefect: "internal.defect",
  changeNotFound: "change.not_found",
  changeLeaseStale: "change.lease_stale",
  changeLeaseNotLapsed: "change.lease_not_lapsed",
  changeStateRefused: "change.state_refused",
  changeCommitNotInWorkspace: "change.commit_not_in_workspace",
  workspacePoolExhausted: "workspace.pool_exhausted",
  workspaceBusy: "workspace.busy",
  workspacePackTooLarge: "workspace.pack_too_large",
  sketchNotFound: "sketch.not_found",
  repoRefNotFound: "repo.ref_not_found",
  repoPathNotFound: "repo.path_not_found",
  sessionSponsorRefused: "session.sponsor_refused",
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
  /** Long-poll: wait up to this many seconds for something new before answering. */
  @query
  @minValue(0)
  @maxValue(30)
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
  /** The lease on the change, from `declare` or `adopt`. A stale lease is refused. */
  @header("keel-lease") lease: LeaseId;
}
