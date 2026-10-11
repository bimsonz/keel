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

  /** Promote this sketch: its workspace carries over to the new change. */
  fromSketch?: SketchId;
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
   * `nextCursor`. An agent reads its own project only (another `project` is 403); an observer or
   * operator reads any, its token's project when `project` is absent.
   */
  @summary("List changes")
  @useAuth(Observer | AgentRead)
  @get
  listChanges(
    @query state?: ChangeState,
    @query project?: ProjectId,
    ...PageQuery,
  ): ChangeSummaryPage | StandardErrors;

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

  /** Read a change. */
  @summary("Get a change")
  @useAuth(AgentRead | Observer)
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

  /** Withdraw the change. */
  @summary("Abandon a change")
  @useAuth(AgentWork)
  @route("/{changeId}/abandon")
  @post
  abandon(
    ...ChangePath,
    ...LeaseHeader,
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
}
