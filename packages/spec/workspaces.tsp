import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

model WorkspacePath {
  @path workspaceId: WorkspaceId;
}

@tag("Workspaces")
@route("/workspaces")
interface Workspaces {
  /**
   * Your workspace token from `declare` or `adopt` is about to expire, or has: get a fresh
   * two-hour write token for the same workspace. Only the change's own agent may, under the
   * change's current lease, while the change holds the workspace. Another agent of the change's
   * project is 409 `change.held_by_other`, naming the holder; a workspace of another project, or
   * one Keel does not know, is 404 `workspace.not_found`; a stale or lapsed lease is 409
   * `change.lease_stale`; a change that has ended is 409 `change.state_refused` (404 once its
   * workspace is collected). Each call mints a new token, and nothing else moves.
   */
  @summary("Refresh a workspace token")
  @tag("mcp")
  @operationId("refreshWorkspaceToken")
  @useAuth(AgentWork)
  @route("/{workspaceId}/token")
  @post
  refreshWorkspaceToken(
    ...WorkspacePath,
    ...LeaseHeader,
    ...IdempotencyKey,
  ): Workspace | NotFound | Conflict | StandardErrors;
}
