import "@typespec/http";
import "./common.tsp";
import "./models.tsp";

using Http;

namespace Keel;

model WorkspacePath {
  @path workspaceId: WorkspaceId;
}

@tag("Workspaces")
@route("/workspaces")
interface Workspaces {
  /** Mint a fresh write token for the workspace. */
  @summary("Refresh a workspace token")
  @useAuth(AgentWork)
  @route("/{workspaceId}/token")
  @post
  refreshWorkspaceToken(...WorkspacePath, ...IdempotencyKey): Workspace | NotFound | StandardErrors;
}
