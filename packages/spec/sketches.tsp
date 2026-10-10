import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

model SketchRequest {
  /** What the sketch is for, in a line. */
  purpose?: string;
}

model SketchView {
  id: SketchId;
  workspace: Workspace;
  expiresAt: utcDateTime;
}

model SketchEnvelope is AgentEnvelope<SketchView>;

@tag("Sketches")
@route("/sketches")
interface Sketches {
  /** Open a throwaway workspace for an idea: no intent, no preflight, no integration. Promote it with `declare` and `fromSketch`. */
  @summary("Open a sketch")
  @tag("mcp")
  @operationId("sketch")
  @useAuth(AgentWork)
  @post
  sketch(...IdempotencyKey, @body body: SketchRequest): {
    @statusCode statusCode: 201;
    @body body: SketchEnvelope;
  } | StandardErrors;
}
