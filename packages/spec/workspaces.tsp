import "@typespec/http";
import "./common.tsp";
import "./models.tsp";

using Http;

namespace Keel;

model WorkspacePath {
  @path workspaceId: WorkspaceId;
}

model WorkspaceReleased {
  id: WorkspaceId;
  releasedAt: utcDateTime;
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

  /** Give the workspace back before its change ends. */
  @summary("Release a workspace")
  @useAuth(AgentWork)
  @route("/{workspaceId}/release")
  @post
  releaseWorkspace(...WorkspacePath, ...IdempotencyKey): WorkspaceReleased | NotFound | StandardErrors;
}
