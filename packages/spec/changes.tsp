import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";
import "./events.tsp";

using Http;
using OpenAPI;

namespace Keel;

model DeclareRequest {
  /** What the change will achieve, in one or two sentences. */
  @minLength(1)
  goal: string;

  /** The paths and symbols it expects to edit, create or delete. */
  footprint?: MFP.FootprintEntry[];

  /** What it relies on, about code it does not own. */
  premises: MFP.Proposition[];

  /** Effects the agent expects to cause. Advisory only: Keel derives effects from the diff. */
  declaredEffects?: MFP.Proposition[];
}

model Declared {
  change: Change;
  preflight: Preflight;
  workspace: Workspace;
  lease: Lease;
}

model DeclaredEnvelope is AgentEnvelope<Declared>;

model ReviseRequest {
  goal?: string;
  footprint?: MFP.FootprintEntry[];
  premisesAdded?: MFP.Proposition[];
  premisesRetracted?: MFP.Proposition[];

  /** Replaces the declared effects. Advisory only. */
  declaredEffects?: MFP.Proposition[];
}

model Revised {
  change: Change;
  preflight: Preflight;
}

model RevisedEnvelope is AgentEnvelope<Revised>;

model RelyRequest {
  premise: MFP.Proposition;
}

model Relied {
  change: Change;
  preflight: Preflight;
}

model ReliedEnvelope is AgentEnvelope<Relied>;

model Nearby {
  preflight: Preflight;
}

model NearbyEnvelope is AgentEnvelope<Nearby>;

model AbandonRequest {
  /** Why it is withdrawn, kept on the change's ChangeWithdrawn. */
  reason?: string;
}

model Abandoned {
  change: Change;
}

model AbandonedEnvelope is AgentEnvelope<Abandoned>;

/** A change taken over after its lease lapsed: the adopter's new lease, and a fresh token for its workspace. */
model Adopted {
  change: Change;
  lease: Lease;

  /** The workspace the change holds, with a token for the adopter. Absent when it never got one. */
  workspace?: Workspace;
}

model AdoptedEnvelope is AgentEnvelope<Adopted>;

/** A change moved onto trunk's head: its new base, and the workspace branch that holds it, to fetch and merge. */
model Rebased {
  change: Change;

  /** The workspace branch holding trunk's head: `refs/heads/keel/trunk`. */
  ref: string;

  /** The change's base now: trunk's head, which a resubmission is judged against. */
  base: CommitSha;
}

model RebasedEnvelope is AgentEnvelope<Rebased>;

/** One file's new content, or its deletion: set exactly one of `content` and `delete`. */
model CommitEdit {
  path: RepoPath;

  /** The file's whole new content: UTF-8 text, or base64 when `encoding` is `base64`. */
  @maxLength(1048576)
  content?: string;

  /** How `content` is written. Absent is `utf8`. */
  encoding?: "utf8" | "base64";

  /** Absent keeps an existing file's mode and makes a new file plain. */
  executable?: boolean;

  /** Delete the file at `path`. */
  delete?: true;
}

/** Edits to commit in your change's workspace, on a commit it holds. */
model CommitRequest {
  /**
   * The workspace's `main` as you last read it: from `declare` or `adopt` (the workspace's
   * `baseSha`), or a previous `commit`. If `main` has moved since, the commit is refused with
   * 409 `workspace.head_moved` and nothing is written.
   */
  expectedHead: CommitSha;

  /**
   * The commit your edits apply to and the new commit's one parent. Absent is `expectedHead`.
   * After a `rebase`, pass the change's new `base` to rebuild your change on trunk's head.
   */
  parent?: CommitSha;

  @minLength(1)
  @maxLength(10000)
  message: string;

  @minItems(1)
  @maxItems(500)
  edits: CommitEdit[];
}

/** The commit now at your workspace's `main`: submit it with `submit`. */
model Committed {
  change: Change;
  commitSha: CommitSha;
  parent: CommitSha;

  /** The commit's tree. */
  tree: string;

  /** Paths whose content or mode the commit changed. */
  changed: int32;
}

model CommittedEnvelope is AgentEnvelope<Committed>;

model ChangePath {
  @path changeId: ChangeId;
}

/** One change as Mission Control lists it: `#number`, its state, goal and agent. */
model ChangeSummary {
  changeId: ChangeId;

  /** The change's `#n`, counted per project in declaration order. */
  number: int32;

  state: ChangeState;

  /** Why it is parked, while it is. */
  parkReason?: ParkReason;

  /** The agent holding it now: the adopter after an adoption. */
  agentId: AgentId;

  goal: string;
  revision: int32;
  declaredAt: utcDateTime;

  /** When its last event was committed. */
  updatedAt: utcDateTime;
}

model ChangeSummaryPage is Page<ChangeSummary>;

@tag("Changes")
@route("/changes")
interface Changes {
  /**
   * A project's changes, newest `#n` first, from the Projector's read model; `cursor` is a page's
   * `nextCursor`. An agent reads its own project or a public one (another `project` is 403); an
   * observer reads any, its token's project when `project` is absent. Without a token,
   * `project` names a public project (otherwise 404, as for one that does not exist); without either, 401.
   */
  @summary("List changes")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @get
  listChanges(
    @query state?: ChangeState,
    @query project?: ProjectId,
    ...PageQuery,
  ): ChangeSummaryPage | NotFound | StandardErrors;

  /** Declare an intent before writing code. Returns preflight, a workspace to push to, and a lease. */
  @summary("Declare a change")
  @tag("mcp")
  @operationId("declare")
  @useAuth(AgentWork)
  @post
  `declare`(...IdempotencyKey, @body body: DeclareRequest): {
    @statusCode statusCode: 201;
    @body body: DeclaredEnvelope;
  } | NotFound | Conflict | StandardErrors;

  /**
   * Read a change, as its own Durable Object holds it. An observer reads any change, an agent its own
   * project's, and anyone (without a token too) a public project's. Any other change answers 404, as
   * one that does not exist does, so a private change's existence does not leak. Compare a change with
   * an alternative by reading both.
   */
  @summary("Get a change")
  @tag("mcp")
  @operationId("change")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{changeId}")
  @get
  getChange(...ChangePath): Change | NotFound | StandardErrors;

  /** Revise the intent. Send the current revision's ETag as If-Match. */
  @summary("Revise a change's intent")
  @tag("mcp")
  @operationId("revise")
  @useAuth(AgentWork)
  @route("/{changeId}/revisions")
  @post
  revise(
    ...ChangePath,
    ...LeaseHeader,
    ...IdempotencyKey,
    @header("if-match") ifMatch: string,
    @body body: ReviseRequest,
  ): RevisedEnvelope | NotFound | Conflict | PreconditionFailed | StandardErrors;

  /** Add one premise. Relying on a subject subscribes the change to it. */
  @summary("Rely on a premise")
  @tag("mcp")
  @operationId("rely")
  @useAuth(AgentWork)
  @route("/{changeId}/premises")
  @post
  rely(
    ...ChangePath,
    ...LeaseHeader,
    ...IdempotencyKey,
    @body body: RelyRequest,
  ): ReliedEnvelope | NotFound | Conflict | StandardErrors;

  /** Changes near this one, contradictions, and precedents. May over-report; it never opens a conflict. */
  @summary("What is near this change?")
  @tag("mcp")
  @operationId("nearby")
  @useAuth(AgentRead)
  @route("/{changeId}/nearby")
  @get
  nearby(...ChangePath): NearbyEnvelope | NotFound | StandardErrors;

  /**
   * Withdraw the change and release its workspace: under its lease, or as an operator with no lease (a
   * parked change, say). A change being integrated, or one that has ended, is 409
   * `change.state_refused`. A retry with the same key answers the same change.
   */
  @summary("Abandon a change")
  @tag("mcp")
  @operationId("abandon")
  @useAuth(AgentWork | SessionAuth)
  @route("/{changeId}/abandon")
  @post
  abandon(
    ...ChangePath,

    /** The lease on the change, from `declare` or `adopt`. Only an operator may leave it out. */
    @header("keel-lease") lease?: LeaseId,

    ...IdempotencyKey,
    @body body: AbandonRequest,
  ): AbandonedEnvelope | NotFound | Conflict | StandardErrors;

  /**
   * Your lease lapsed (after a crash or a context reset): take the change back with a fresh lease and
   * workspace token. Only a lapsed lease can be adopted (409 `change.lease_not_lapsed` says when it
   * lapses), and only by an agent of the change's project. A retry with the same key answers the
   * same lease.
   */
  @summary("Adopt a change")
  @tag("mcp")
  @operationId("adopt")
  @useAuth(AgentWork)
  @route("/{changeId}/adopt")
  @post
  adopt(...ChangePath, ...IdempotencyKey): AdoptedEnvelope | NotFound | Conflict | StandardErrors;

  /**
   * Trunk moved under your change and it bounced on a textual conflict: put trunk's head on your
   * workspace's `keel/trunk` branch and move the change's base there. Then run
   * `git fetch origin keel/trunk && git merge FETCH_HEAD`, resolve, push and submit again (merge,
   * never force-push). Allowed while the change is working or bounced, under your lease. A retry
   * with the same key answers as before; 503 `workspace.busy` means try again shortly.
   */
  @summary("Rebase a change onto trunk")
  @tag("mcp")
  @operationId("rebase")
  @useAuth(AgentWork)
  @route("/{changeId}/rebase")
  @post
  rebase(
    ...ChangePath,
    ...LeaseHeader,
    ...IdempotencyKey,
  ): RebasedEnvelope | NotFound | Conflict | StandardErrors;

  /**
   * Commit edits to your change's workspace without a clone: Keel applies them to `parent`
   * (default `expectedHead`), makes one commit authored by you, and moves your workspace's
   * `main` from `expectedHead` to it, renewing your lease. Then call `submit` with its
   * `commitSha`. Only your own workspace is written, never trunk. Allowed while the change is
   * working or bounced, under your lease. Refusals: 409 `workspace.head_moved` (it names the
   * head now: read it and try again), 409 `commit.edits_refused` (an edit cannot apply, or
   * nothing changed), 400 `commit.bad_edits` (a bad, duplicate or nested path), 404
   * `commit.parent_not_found`. A retry whose commit already sits at `main` answers that commit.
   * A commit records no event of the change's own: it is seen as a push to the workspace.
   */
  @summary("Commit edits to your workspace")
  @tag("mcp")
  @operationId("commit")
  @useAuth(AgentWork)
  @route("/{changeId}/commits")
  @post
  commit(
    ...ChangePath,
    ...LeaseHeader,
    ...IdempotencyKey,
    @body body: CommitRequest,
  ): CommittedEnvelope | NotFound | Conflict | StandardErrors;
}
