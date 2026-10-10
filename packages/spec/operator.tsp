import "@typespec/http";
import "./common.tsp";
import "./models.tsp";
import "./agents.tsp";

using Http;

namespace Keel;

model ProjectView {
  id: ProjectId;
  name: string;
  createdAt: utcDateTime;
}

model CreateProjectRequest {
  @minLength(1)
  name: string;
}

model ProjectSettings {
  /** Paths only Keel may change; a change touching them is refused at precheck. */
  protectedPaths: string[];

  /** The largest batch a lane may form. */
  @minValue(1)
  @maxValue(16)
  maxBatchSize: int32;
}

model ProjectPage is Page<ProjectView>;

model EnrolAgentRequest {
  @minLength(1)
  name: string;

  kind: AgentKind;
  scopes: Scope[];
}

model EnrolledAgent {
  agent: AgentProfile;
  clientId: string;

  /** Shown once. */
  clientSecret: string;
}

model EscalationView {
  id: EscalationId;
  question: string;
  options: string[];
  raisedAt: utcDateTime;
  state: "open" | "ruled" | "withdrawn";
}

model EscalationPage is Page<EscalationView>;

model RulingRequest {
  option: string;
  rationale?: string;
}

@tag("Operator")
interface Operator {
  @summary("List projects")
  @useAuth(OperatorScope)
  @route("/projects")
  @get
  listProjects(...PageQuery): ProjectPage | StandardErrors;

  @summary("Create a project")
  @useAuth(OperatorScope)
  @route("/projects")
  @post
  createProject(...IdempotencyKey, @body body: CreateProjectRequest): {
    @statusCode statusCode: 201;
    @body body: ProjectView;
  } | StandardErrors;

  @summary("Get a project's settings")
  @useAuth(OperatorScope)
  @route("/projects/{projectId}/settings")
  @get
  getSettings(@path projectId: ProjectId): ProjectSettings | NotFound | StandardErrors;

  @summary("Replace a project's settings")
  @useAuth(OperatorScope)
  @route("/projects/{projectId}/settings")
  @put
  putSettings(@path projectId: ProjectId, @body body: ProjectSettings): ProjectSettings | NotFound | StandardErrors;

  @summary("Enrol an agent")
  @useAuth(OperatorScope)
  @route("/agents")
  @post
  enrolAgent(...IdempotencyKey, @body body: EnrolAgentRequest): {
    @statusCode statusCode: 201;
    @body body: EnrolledAgent;
  } | StandardErrors;

  @summary("List escalations")
  @useAuth(OperatorScope)
  @route("/escalations")
  @get
  listEscalations(@query state?: "open" | "ruled" | "withdrawn", ...PageQuery): EscalationPage | StandardErrors;

  @summary("Rule on an escalation")
  @useAuth(OperatorScope)
  @route("/escalations/{escalationId}/ruling")
  @post
  giveRuling(@path escalationId: EscalationId, ...IdempotencyKey, @body body: RulingRequest): EscalationView | NotFound | Conflict | StandardErrors;
}
