import "@typespec/http";
import "./common.tsp";
import "./models.tsp";
import "./agents.tsp";

using Http;

namespace Keel;

/** A project and where it lives: `/<namespace>/<name>`. */
model ProjectView {
  id: ProjectId;

  /** The namespace the project belongs to: a person's own, an agent's own or an org. */
  `namespace`: NamespaceRef;

  /** The project's name in its namespace, lower-case. */
  name: string;

  visibility: "private" | "public";

  /** When the project was created: answered on creation. */
  createdAt?: utcDateTime;

  /** The reader's role in the project's namespace: its owner's in their own, a member's in an org; absent for anyone else. */
  viewer?: Viewer;

  /**
   * The project this one was forked from, where the reader may read that project: a fork of a private project
   * names it to nobody outside it. Answered on creation and on a read of one project, not in a list.
   */
  forkedFrom?: ProjectRef;
}

model CreateProjectRequest {
  /** The namespace the project is created in, by its handle: the caller's own, or an org the caller is a member of. */
  @minLength(1)
  `namespace`: string;

  /** The project's name in its namespace, unique there in any case. */
  @minLength(1)
  name: string;

  /** Where the project's trunk starts. */
  source: ProjectSource;
}

/** An empty project: Keel writes trunk's first commit, a README naming the project, and signs it. */
model EmptySource {
  kind: "empty";
}

/**
 * A public Git repository, imported once. Its history must fit what the namespace has left of its repository
 * quota, and what Keel copies in one piece.
 */
model ImportSource {
  kind: "import";

  /**
   * `https://<host>/<path>` and nothing more: no credential, port, query or fragment, and a host by name. It is
   * recorded as the project's origin, for every reader of the project.
   */
  @minLength(1)
  @maxLength(2048)
  url: string;

  /** The upstream branch to take, by its short name (`main`, `release/1.x`); the upstream's default when absent. */
  @minLength(1)
  @maxLength(255)
  ref?: string;
}

/**
 * The trunk of a project the caller may fork. A public project forks into the caller's own namespace or any org
 * the caller is a member of; a private one only into its own namespace.
 */
model ForkSource {
  kind: "fork";
  project: ProjectId;
}

/** A template, by name. An interim start: it leaves the API once Keel's fixture is a public repository to import. */
model TemplateSource {
  kind: "template";

  @minLength(1)
  name: string;
}

/** Where a new project's trunk starts, told apart by `kind`. */
union ProjectSource {
  empty: EmptySource,
  `import`: ImportSource,
  fork: ForkSource,
  template: TemplateSource,
}

model ProjectSettings {
  /** Paths only Keel may change; a change touching them is refused at precheck. */
  protectedPaths: string[];

  /** The largest batch a lane may form. */
  @minValue(1)
  @maxValue(16)
  maxBatchSize: int32;

  /**
   * Whether the project's lane verifies each batch before it lands. Absent in a PUT means `required`;
   * Keel always answers it. `off` is for a negative-control project only: the lane then skips verification
   * and marks what lands unverified. Every change is audited by ProjectSettingsChanged.
   */
  verification?: "required" | "off";

  /**
   * Who may read the project. `public` lets anonymous readers see it through the repo read API; absent in a
   * PUT means `private`, and Keel always answers it. Every change is audited by ProjectSettingsChanged.
   */
  visibility?: "private" | "public";
}

model ProjectPage is Page<ProjectView>;

model EnrolAgentRequest {
  @minLength(1)
  name: string;

  kind: AgentKind;
  scopes: Scope[];

  /** The one project the agent works in. The caller, a member of its org, becomes the agent's sponsor. */
  projectId: ProjectId;
}

model SuspendAgentRequest {
  /** Why the agent is suspended: recorded on AgentSuspended. */
  @minLength(1)
  reason: string;
}

model EnrolledAgent {
  agent: AgentProfile;
  clientId: string;

  /** Shown once. */
  clientSecret: string;
}

/** A question put to a person, as Mission Control's inbox shows it: what EscalationRaised carried, and where it stands. */
model EscalationView {
  id: EscalationId;

  /** Keel's short name for the question, counted per project: `E-1` is the project's first. */
  label: string;

  /** The project whose conflict the question is about. */
  project: ProjectRef;

  question: string;

  /** At least two, with unique ids; a ruling names one by `id`. */
  options: EscalationOption[];

  /** What the question is about. */
  about: EntityRef;

  category: EscalationCategory;

  /** Keel's evidence, put before the person. */
  evidence: EscalationEvidence[];

  /** Earlier decisions on the same subject. */
  precedents: DecisionId[];

  /** The option suggested while the question is open: one of `options`, never applied on a timeout. */
  @minLength(1)
  default: string;

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
  /** The projects the caller may read: a visitor's are the public ones; each project is decided by its read rule. */
  @summary("List projects")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/projects")
  @get
  listProjects(...PageQuery): ProjectPage | StandardErrors;

  @summary("Create a project")
  @useAuth(SessionAuth)
  @route("/projects")
  @post
  createProject(...IdempotencyKey, @body body: CreateProjectRequest): {
    @statusCode statusCode: 201;
    @body body: ProjectView;
  } | NotFound | Conflict | StandardErrors;

  @summary("Get a project's settings")
  @useAuth(AgentRead | SessionAuth)
  @route("/projects/{projectId}/settings")
  @get
  getSettings(@path projectId: ProjectId): ProjectSettings | NotFound | StandardErrors;

  @summary("Replace a project's settings")
  @useAuth(SessionAuth)
  @route("/projects/{projectId}/settings")
  @put
  putSettings(@path projectId: ProjectId, @body body: ProjectSettings): ProjectSettings | NotFound | Conflict | StandardErrors;

  @summary("Enrol an agent")
  @useAuth(SessionAuth)
  @route("/agents")
  @post
  enrolAgent(...IdempotencyKey, @body body: EnrolAgentRequest): {
    @statusCode statusCode: 201;
    @body body: EnrolledAgent;
  } | NotFound | Conflict | StandardErrors;

  /**
   * Pause an agent: every request it makes is refused (403, `agent-paused`) until its sponsor
   * reinstates it. Only the agent's sponsor may, on a fresh sign-in (403
   * `auth.fresh_sign_in_required` otherwise); to anyone else the agent is not there (404). Only an
   * active agent can be suspended (409 `agent.state_refused` otherwise).
   */
  @summary("Suspend an agent")
  @useAuth(SessionAuth)
  @route("/agents/{agentId}/suspend")
  @post
  suspendAgent(@path agentId: AgentId, ...IdempotencyKey, @body body: SuspendAgentRequest): AgentProfile | NotFound | Conflict | StandardErrors;

  /** Reinstate a paused agent: its requests are answered again. Its sponsor's alone, on a fresh sign-in. */
  @summary("Reinstate an agent")
  @useAuth(SessionAuth)
  @route("/agents/{agentId}/reinstate")
  @post
  reinstateAgent(@path agentId: AgentId, ...IdempotencyKey): AgentProfile | NotFound | Conflict | StandardErrors;

  /**
   * Revoke an agent, for good: its revocation epoch moves on, so every token it holds is refused at
   * once, and it can never be reinstated.
   */
  @summary("Revoke an agent")
  @useAuth(SessionAuth)
  @route("/agents/{agentId}/revoke")
  @post
  revokeAgent(@path agentId: AgentId, ...IdempotencyKey): AgentProfile | NotFound | Conflict | StandardErrors;

  /**
   * The questions Keel has put to people, newest first. An agent reads its own project's. A person
   * reads their inbox across every project: a question they are the first asked, at once, and a
   * question of a namespace they maintain once thirty minutes have passed without an answer. A page
   * may hold fewer than `limit` while `nextCursor` says more follow.
   */
  @summary("List escalations")
  @useAuth(AgentRead | SessionAuth)
  @route("/escalations")
  @get
  listEscalations(@query state?: "open" | "ruled" | "withdrawn", ...PageQuery): EscalationPage | StandardErrors;

  /**
   * Answer a question: the person first asked, or a maintainer of its namespace, names one of its
   * options. The ruling records a decision and resolves the conflict the question was about. An
   * option the question does not offer is a 400 `escalation.option_unknown` whose next actions rule
   * each valid one; a question already answered or withdrawn is a 409 `escalation.state_refused`.
   */
  @summary("Rule on an escalation")
  @useAuth(SessionAuth)
  @route("/escalations/{escalationId}/ruling")
  @post
  giveRuling(@path escalationId: EscalationId, ...IdempotencyKey, @body body: RulingRequest): EscalationView | NotFound | Conflict | StandardErrors;
}
