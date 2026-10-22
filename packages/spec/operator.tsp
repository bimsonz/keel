import "@typespec/http";
import "./common.tsp";
import "./models.tsp";
import "./agents.tsp";

using Http;

namespace Keel;

/** What a sync from upstream did. */
model UpstreamSync {
  /** Trunk's head before the sync. */
  from: CommitSha;

  /** Upstream's head: trunk's head once `synced`. */
  to: CommitSha;

  /** Whether trunk is at `to` now. False with `from` equal to `to` when trunk was already level with upstream; false with them apart while a move the code host kept busy is finished, which the feed then shows as `TrunkSynced`. */
  synced: boolean;
}

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

/** A template, by name: one of the starting repositories Keel lists, such as `fixture-forge-lite`. */
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

  /** The largest batch a lane may form; 8 until a PUT sets it. The lane forms fewer as its recent failure rate rises. */
  @minValue(1)
  @maxValue(16)
  maxBatchSize: int32;

  /**
   * Whether the project's lane verifies each batch before it lands. Absent in a PUT means `required`;
   * Keel always answers it. With `off` the lane skips verification and marks what lands
   * unverified. Every change is audited by ProjectSettingsChanged.
   */
  verification?: "required" | "off";

  /**
   * Who may read the project. `public` lets anonymous readers see it through the repo read API; absent in a
   * PUT means `private`, and Keel always answers it. Every change is audited by ProjectSettingsChanged.
   */
  visibility?: "private" | "public";

  /**
   * Whether a fork of the project may propose changes back to it. Absent in a PUT means `open`, and Keel always
   * answers it; a private project takes no proposals, whatever it says. Every change is audited by
   * ProjectSettingsChanged.
   */
  proposals?: "open" | "closed";
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

  /**
   * Create a project in a namespace, with trunk's first commit. An agent
   * creates one in its own namespace, which its handle names, with a token
   * that names no project.
   */
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

  /**
   * Moves an imported or forked project's trunk forward to its upstream, as GitHub's "Sync fork" does: each upstream
   * commit is kept as it is. An import's trunk moves to the head of the upstream branch its import took, and only
   * when that head descends from trunk's. A fork's trunk moves to the head of the trunk it was forked from: to that
   * head itself when it descends from trunk's, otherwise to a merge commit Keel makes and signs, whose second parent
   * is that head and whose tree holds the fork's own work and upstream's. Its owners alone may ask, and a fork's only
   * while they may read its upstream. Refused, with nothing moved: a project that was neither imported nor forked
   * (`project.not_imported`); an import's trunk with commits upstream lacks (`trunk.not_fast_forward`, naming both
   * heads); a fork whose work and upstream's cannot be merged (`trunk.sync_conflicts`, naming the first path that
   * stopped the merge: land a change in the fork that takes upstream's version of it, then sync again); a promotion
   * in flight (`trunk.busy`, ask again shortly); an upstream that does not answer or lost the branch
   * (`project.upstream_unreachable`); upstream's new history over what Keel takes in one piece
   * (`project.import_too_large`) or over the namespace's repo bytes (`quota.exceeded`). The feed records the move as
   * `TrunkSynced`.
   */
  @summary("Sync an imported or forked project's trunk from its upstream")
  @tag("mcp")
  @useAuth(AgentWork | SessionAuth)
  @route("/projects/{projectId}/sync")
  @post
  syncUpstream(@path projectId: ProjectId): UpstreamSync | NotFound | Conflict | StandardErrors;

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
  @tag("mcp")
  @useAuth(AgentRead | SessionAuth)
  @route("/escalations")
  @get
  listEscalations(@query state?: "open" | "ruled" | "withdrawn", ...PageQuery): EscalationPage | StandardErrors;

  /**
   * Answer a question: the person first asked, or a person who maintains its namespace, names one
   * of its options; an agent is refused (`users-only`), whatever it maintains. The ruling records a
   * decision and resolves what the question was about: the conflict, the change to how Keel
   * verifies (`verification-change`), or the change that passed with fewer tests than trunk's last
   * verdict (`fewer-tests`), either of which `approve` resumes into the queue and anything else
   * sends back. An
   * option the question does not offer is a 400 `escalation.option_unknown` whose next actions rule
   * each valid one; a question already answered or withdrawn is a 409 `escalation.state_refused`.
   */
  @summary("Rule on an escalation")
  @tag("mcp")
  @useAuth(SessionAuth)
  @route("/escalations/{escalationId}/ruling")
  @post
  giveRuling(@path escalationId: EscalationId, ...IdempotencyKey, @body body: RulingRequest): EscalationView | NotFound | Conflict | StandardErrors;
}
