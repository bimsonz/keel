import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";

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

model ChangePath {
  @path changeId: ChangeId;
}

@tag("Changes")
@route("/changes")
interface Changes {
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
}
