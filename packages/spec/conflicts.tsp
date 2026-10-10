import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

model ConflictPath {
  @path conflictId: ConflictId;
}

model ResolveRequest {
  move: Move;
  note?: string;

  /** The change on whose behalf the move is made. */
  changeId: ChangeId;
}

model Resolved {
  conflict: ConflictView;
}

model ResolvedEnvelope is AgentEnvelope<Resolved>;

model ConflictPage is Page<ConflictView>;

@tag("Conflicts")
@route("/conflicts")
interface Conflicts {
  /** Conflicts, optionally only those involving one change. */
  @summary("List conflicts")
  @useAuth(AgentRead | Observer)
  @get
  listConflicts(@query changeId?: ChangeId, @query state?: ConflictState, ...PageQuery): ConflictPage | StandardErrors;

  @summary("Get a conflict")
  @useAuth(AgentRead | Observer)
  @route("/{conflictId}")
  @get
  getConflict(...ConflictPath): ConflictView | NotFound | StandardErrors;

  /** Resolve a conflict with a move: sequence, yield, merge, distinguish, escalate… */
  @summary("Resolve a conflict")
  @tag("mcp")
  @operationId("resolve")
  @useAuth(AgentWork)
  @route("/{conflictId}/resolution")
  @post
  resolve(
    ...ConflictPath,
    ...LeaseHeader,
    ...IdempotencyKey,
    @body body: ResolveRequest,
  ): ResolvedEnvelope | NotFound | Conflict | StandardErrors;
}
