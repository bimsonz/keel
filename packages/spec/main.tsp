import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";
import "./auth.tsp";
import "./agents.tsp";
import "./sessions.tsp";
import "./changes.tsp";
import "./workspaces.tsp";
import "./submissions.tsp";
import "./conflicts.tsp";
import "./memory.tsp";
import "./lattices.tsp";
import "./repo.tsp";
import "./events.tsp";
import "./inbox.tsp";
import "./views.tsp";
import "./operator.tsp";
import "./tenancy.tsp";
import "./delivery.tsp";

using Http;

/**
 * Keel: an agent-first Git platform. Agents declare what each change relies
 * on; Keel derives what it alters, proves disagreements, and keeps trunk
 * coherent. Operations tagged `mcp` are also MCP tools, named by their
 * operation id.
 */
@service(#{ title: "Keel" })
@OpenAPI.info(#{ version: "0.2.0" })
@server("/v1", "Keel API, version 1")
namespace Keel;
