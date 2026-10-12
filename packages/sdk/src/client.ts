import type {
  AbandonRequest,
  ChangeState,
  ConflictState,
  CreateProjectRequest,
  DeclareRequest,
  EnrolAgentRequest,
  OpenSessionRequest,
  ProjectSettings,
  RelyRequest,
  ResolveRequest,
  ReviseRequest,
  RulingRequest,
  SketchRequest,
  SubmitRequest,
  SuspendAgentRequest,
  TokenResponse,
  WireOutputs,
} from "@keeltown/contracts";
import { KeelProblem, KeelTokenError } from "./problem.ts";
import { type InputOf, ROUTES, type RoutedOperation } from "./routes.ts";

export interface KeelClientOptions {
  /** Keel's origin, e.g. `https://keel.example.workers.dev`; the client adds `/v1`. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scopes to ask for; every scope the agent holds when absent. */
  readonly scopes?: readonly string[];
  /** Defaults to the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * A client with no credentials: it calls only what Keel serves without a
 * token, such as a public project's code, and sends no Authorization header.
 */
export interface PublicClientOptions {
  readonly baseUrl: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * A signed-in user's client: a Better Auth session, sent as a bearer. It is
 * what `keeltown login` hands out; the caller acts as that user, through its
 * memberships.
 */
export interface SessionClientOptions {
  readonly baseUrl: string;
  readonly session: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** A mutating call is retried safely only under the same key; one is minted when absent. */
export interface Idempotent extends CallOptions {
  readonly idempotencyKey?: string;
}

/** A token is refreshed this long before it expires, so a call never carries one that lapses in flight. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Keel's API, typed from `@keeltown/contracts`. It exchanges the client
 * credentials for a bearer token, caches it until shortly before it expires,
 * and on a 401 exchanges once more and retries the call once, under the same
 * Idempotency-Key. A refusal throws `KeelProblem`, carrying the next actions.
 */
export class KeelClient {
  readonly #options: KeelClientOptions | PublicClientOptions | SessionClientOptions;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  #token: { readonly value: string; readonly expiresAt: number } | undefined;

  constructor(options: KeelClientOptions | PublicClientOptions | SessionClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get #api(): string {
    return `${this.#options.baseUrl.replace(/\/+$/, "")}/v1`;
  }

  /** A bearer token for the client's credentials: the cached one while it is fresh. */
  async token(options: { readonly fresh?: boolean } = {}): Promise<string> {
    if (options.fresh !== true && this.#token !== undefined && Date.now() < this.#token.expiresAt)
      return this.#token.value;
    const credentials = this.#options;
    if (!("clientId" in credentials))
      throw new KeelTokenError("invalid_client", 0, "This client has no credentials.");
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
    if (credentials.scopes !== undefined) form.set("scope", credentials.scopes.join(" "));
    const response = await this.#fetch(`${this.#api}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const refusal = typeof body === "object" && body !== null ? body : {};
      throw new KeelTokenError(
        "error" in refusal && typeof refusal.error === "string"
          ? refusal.error
          : "invalid_response",
        response.status,
        "error_description" in refusal && typeof refusal.error_description === "string"
          ? refusal.error_description
          : undefined,
      );
    }
    if (!isTokenResponse(body)) throw new KeelTokenError("invalid_response", response.status);
    const granted = body;
    this.#token = {
      value: granted.access_token,
      expiresAt: Date.now() + granted.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return granted.access_token;
  }

  /**
   * Any routed operation by its operation id, with the input the contract
   * declares for it (path, query, header and body fields together).
   */
  async call<Op extends RoutedOperation>(
    operation: Op,
    input: InputOf<Op>,
    options: CallOptions = {},
  ): Promise<WireOutputs[Op]> {
    const request = this.#request(operation, input);
    const send = async (token: string | undefined) =>
      this.#fetch(request.url, {
        method: request.method,
        headers:
          token === undefined
            ? request.headers
            : { ...request.headers, authorization: `Bearer ${token}` },
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const credentialed = "clientId" in this.#options;
    const session = "session" in this.#options ? this.#options.session : undefined;
    let response = await send(credentialed ? await this.token() : session);
    if (credentialed && response.status === 401)
      response = await send(await this.token({ fresh: true }));
    if (!response.ok) throw await KeelProblem.from(response);
    // The body is the contract's: Keel validates every response against the published schemas.
    // Parsed from text, because `json()` is typed `any` in DOM's lib but `unknown` in Node's.
    const answer: WireOutputs[Op] = JSON.parse(await response.text());
    return answer;
  }

  #request(operation: RoutedOperation, input: Readonly<Record<string, unknown>>) {
    const route: (typeof ROUTES)[RoutedOperation] = ROUTES[operation];
    const query = new Set<string>("query" in route ? route.query : []);
    const headerNames = new Set<string>("headers" in route ? route.headers : []);
    const params = new URLSearchParams();
    const headers: Record<string, string> = { accept: "application/json" };
    const body: Record<string, unknown> = {};
    let path: string = route.path;
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (path.includes(`{${key}}`))
        path = path.replace(`{${key}}`, encodeURIComponent(scalar(value)));
      else if (query.has(key)) params.set(key, scalar(value));
      else if (headerNames.has(key)) headers[key] = scalar(value);
      else body[key] = value;
    }
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const sendsBody = route.method !== "GET";
    if (sendsBody) headers["content-type"] = "application/json";
    return {
      url: `${this.#api}${path}${search}`,
      method: route.method,
      headers,
      body: sendsBody ? JSON.stringify(body) : undefined,
    };
  }

  whoami(options?: CallOptions): Promise<WireOutputs["whoami"]> {
    return this.call("whoami", {}, options);
  }

  /** The sign-in methods this instance offers besides a passkey. */
  signInMethods(options?: CallOptions): Promise<WireOutputs["SignIn_methods"]> {
    return this.call("SignIn_methods", {}, options);
  }

  /** Opens the agent's session, which becomes its current one. Retry with the same key to reach it. */
  openSession(
    request: OpenSessionRequest = {},
    options: Idempotent = {},
  ): Promise<WireOutputs["Sessions_openSession"]> {
    return this.call(
      "Sessions_openSession",
      { ...request, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Declares a change and takes its workspace. Retry with the same key to reach the same change. */
  declare(intent: DeclareRequest, options: Idempotent = {}): Promise<WireOutputs["declare"]> {
    return this.call("declare", { ...intent, "idempotency-key": keyOf(options) }, options);
  }

  /** Submits a commit pushed to the change's workspace, under the change's lease. */
  submit(
    submission: SubmitRequest,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["submit"]> {
    return this.call(
      "submit",
      { ...submission, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * Withdraws a change and releases its workspace: under its lease, or with
   * no lease when the client holds the operator scope.
   */
  abandon(
    changeId: string,
    request: AbandonRequest = {},
    options: Idempotent & { readonly lease?: string } = {},
  ): Promise<WireOutputs["abandon"]> {
    return this.call(
      "abandon",
      { ...request, changeId, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * Revises a change's intent under its lease, at the revision last read (its
   * ETag); another revision is refused with the current one named.
   */
  revise(
    changeId: string,
    revision: ReviseRequest,
    options: Idempotent & { readonly lease: string; readonly ifMatch: number },
  ): Promise<WireOutputs["revise"]> {
    return this.call(
      "revise",
      {
        ...revision,
        changeId,
        "keel-lease": options.lease,
        "idempotency-key": keyOf(options),
        "if-match": `"${options.ifMatch}"`,
      },
      options,
    );
  }

  /** Adds one premise to a change under its lease; relying on a subject subscribes the change to it. */
  rely(
    changeId: string,
    request: RelyRequest,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["rely"]> {
    return this.call(
      "rely",
      { ...request, changeId, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** What is near a change now: the preflight of its intent as it stands. Commits nothing. */
  nearby(changeId: string, options?: CallOptions): Promise<WireOutputs["nearby"]> {
    return this.call("nearby", { changeId }, options);
  }

  /** Takes over a change whose lease lapsed: a new lease, and a fresh token for its workspace. */
  adopt(changeId: string, options: Idempotent = {}): Promise<WireOutputs["adopt"]> {
    return this.call("adopt", { changeId, "idempotency-key": keyOf(options) }, options);
  }

  /**
   * After a textual bounce: puts trunk's head on the workspace's `keel/trunk`
   * and moves the change's base there. Then merge it with git, push and submit.
   */
  rebase(
    changeId: string,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["rebase"]> {
    return this.call(
      "rebase",
      { changeId, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** A sketch: a workspace for exploring, with no change declared. */
  sketch(request: SketchRequest = {}, options: Idempotent = {}): Promise<WireOutputs["sketch"]> {
    return this.call("sketch", { ...request, "idempotency-key": keyOf(options) }, options);
  }

  /** A fresh token for a workspace the caller holds. */
  refreshWorkspaceToken(
    workspaceId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Workspaces_refreshWorkspaceToken"]> {
    return this.call(
      "Workspaces_refreshWorkspaceToken",
      { workspaceId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Gives a workspace back. */
  releaseWorkspace(
    workspaceId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Workspaces_releaseWorkspace"]> {
    return this.call(
      "Workspaces_releaseWorkspace",
      { workspaceId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * A project's conflicts, newest first, with how many are open and settled:
   * the token's own project unless `project` names another (required without
   * a token). Optionally only the open or only the settled ones, about one
   * change, or in one state; pass a page's `nextCursor` for the next.
   */
  conflicts(
    options: CallOptions & {
      readonly project?: string;
      readonly open?: boolean;
      readonly changeId?: string;
      readonly state?: ConflictState;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Conflicts_listConflicts"]> {
    return this.call(
      "Conflicts_listConflicts",
      {
        project: options.project,
        open: options.open,
        changeId: options.changeId,
        state: options.state,
        cursor: options.cursor,
        limit: options.limit,
      },
      options,
    );
  }

  /** One conflict of a project, with its sides, probe, world matrix and guard: the token's own project unless `project` names another. */
  conflict(
    conflictId: string,
    options: CallOptions & { readonly project?: string } = {},
  ): Promise<WireOutputs["Conflicts_getConflict"]> {
    return this.call("Conflicts_getConflict", { conflictId, project: options.project }, options);
  }

  /** The source of a conflict's probe, file by file: the token's own project unless `project` names another. */
  probeSource(
    probeId: string,
    options: CallOptions & { readonly project?: string } = {},
  ): Promise<WireOutputs["Probes_getProbeSource"]> {
    return this.call("Probes_getProbeSource", { probeId, project: options.project }, options);
  }

  /** Resolves a conflict by a move, under the lease of the change named in the resolution. */
  resolve(
    conflictId: string,
    resolution: ResolveRequest,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["resolve"]> {
    return this.call(
      "resolve",
      { ...resolution, conflictId, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Why a line, a path or a subject is as it is: the decisions and premises behind it. */
  why(
    about: { readonly path?: string; readonly line?: number; readonly subject?: string },
    options?: CallOptions,
  ): Promise<WireOutputs["why"]> {
    return this.call(
      "why",
      { path: about.path, line: about.line, subject: about.subject },
      options,
    );
  }

  /** Decisions, optionally about one subject; pass a page's `nextCursor` for the next. */
  decisions(
    options: CallOptions & {
      readonly subject?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Memory_listDecisions"]> {
    return this.call(
      "Memory_listDecisions",
      { subject: options.subject, cursor: options.cursor, limit: options.limit },
      options,
    );
  }

  decision(decisionId: string, options?: CallOptions): Promise<WireOutputs["Memory_getDecision"]> {
    return this.call("Memory_getDecision", { decisionId }, options);
  }

  /** Where a change's submission stands; with `wait` (0–30 s), once it moves. */
  status(
    changeId: string,
    options: CallOptions & { readonly wait?: number } = {},
  ): Promise<WireOutputs["status"]> {
    return this.call("status", { changeId, wait: options.wait }, options);
  }

  /** Notices after `cursor`; with `wait` (0–30 s), the first one to arrive. */
  inbox(
    options: CallOptions & { readonly cursor?: string; readonly wait?: number } = {},
  ): Promise<WireOutputs["inbox"]> {
    return this.call("inbox", { cursor: options.cursor, wait: options.wait }, options);
  }

  /**
   * The operation log after `cursor`, oldest first, optionally one project's;
   * with `wait`, the next event.
   */
  events(
    options: CallOptions & {
      readonly cursor?: string;
      readonly project?: string;
      readonly wait?: number;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Inbox_listEvents"]> {
    return this.call(
      "Inbox_listEvents",
      {
        cursor: options.cursor,
        project: options.project,
        wait: options.wait,
        limit: options.limit,
      },
      options,
    );
  }

  /** Changes, optionally in one state or project; pass a page's `nextCursor` for the next. */
  changes(
    options: CallOptions & {
      readonly state?: ChangeState;
      readonly project?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Changes_listChanges"]> {
    return this.call(
      "Changes_listChanges",
      {
        state: options.state,
        project: options.project,
        cursor: options.cursor,
        limit: options.limit,
      },
      options,
    );
  }

  /** Every project's state at the feed's current position, optionally one project's. */
  snapshot(
    options: CallOptions & { readonly project?: string } = {},
  ): Promise<WireOutputs["Inbox_getSnapshot"]> {
    return this.call("Inbox_getSnapshot", { project: options.project }, options);
  }

  /** Every predicate's lattice, as the domain publishes it. */
  lattices(options?: CallOptions): Promise<WireOutputs["Lattices_listLattices"]> {
    return this.call("Lattices_listLattices", {}, options);
  }

  verdict(verdictId: string, options?: CallOptions): Promise<WireOutputs["Views_getVerdict"]> {
    return this.call("Views_getVerdict", { verdictId }, options);
  }

  candidate(
    candidateId: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Views_getCandidate"]> {
    return this.call("Views_getCandidate", { candidateId }, options);
  }

  /** A project's lanes; pass a page's `nextCursor` for the next. */
  lanes(
    projectId: string,
    options: CallOptions & { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<WireOutputs["Views_listLanes"]> {
    return this.call(
      "Views_listLanes",
      { projectId, cursor: options.cursor, limit: options.limit },
      options,
    );
  }

  change(changeId: string, options?: CallOptions): Promise<WireOutputs["change"]> {
    return this.call("change", { changeId }, options);
  }

  trunk(projectId: string, options?: CallOptions): Promise<WireOutputs["Views_getTrunk"]> {
    return this.call("Views_getTrunk", { projectId }, options);
  }

  /** Operator: creates a project whose trunk is forked from `source`. */
  createProject(
    project: CreateProjectRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_createProject"]> {
    return this.call(
      "Operator_createProject",
      { ...project, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** A project by its org's name and its own, as `/<org>/<project>` names them, with the reader's role there. */
  project(
    org: string,
    name: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Orgs_getProject"]> {
    return this.call("Orgs_getProject", { org, name }, options);
  }

  /** The signed-in user: its handle, whether it is the instance admin, and its orgs with its role in each. */
  me(options?: CallOptions): Promise<WireOutputs["Users_me"]> {
    return this.call("Users_me", {}, options);
  }

  /** The projects the caller may read, each with its org and the reader's role there; pass a page's `nextCursor` for the next. */
  projects(
    options: CallOptions & { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<WireOutputs["Operator_listProjects"]> {
    return this.call(
      "Operator_listProjects",
      { cursor: options.cursor, limit: options.limit },
      options,
    );
  }

  /** Operator: a project's settings, as its Project DO holds them. */
  settings(projectId: string, options?: CallOptions): Promise<WireOutputs["Operator_getSettings"]> {
    return this.call("Operator_getSettings", { projectId }, options);
  }

  /**
   * Operator: replaces a project's settings. A PUT of what is already there
   * commits nothing, so a retry is safe; an absent `verification` means `required`.
   */
  putSettings(
    projectId: string,
    settings: ProjectSettings,
    options?: CallOptions,
  ): Promise<WireOutputs["Operator_putSettings"]> {
    return this.call("Operator_putSettings", { ...settings, projectId }, options);
  }

  /** A directory of a project's trunk at `ref` (trunk's head when absent); the root without `path`. */
  tree(
    projectId: string,
    options: CallOptions & { readonly ref?: string; readonly path?: string } = {},
  ): Promise<WireOutputs["Repo_getTree"]> {
    return this.call("Repo_getTree", { projectId, ref: options.ref, path: options.path }, options);
  }

  /** A file of a project's trunk at `ref`: its text inline up to 1 MiB, unless it is binary. */
  blob(
    projectId: string,
    path: string,
    options: CallOptions & { readonly ref?: string } = {},
  ): Promise<WireOutputs["Repo_getBlob"]> {
    return this.call("Repo_getBlob", { projectId, path, ref: options.ref }, options);
  }

  /** Trunk's history from `ref`, newest first; pass a page's `nextCursor` for the next. */
  commits(
    projectId: string,
    options: CallOptions & {
      readonly ref?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Repo_listCommits"]> {
    return this.call(
      "Repo_listCommits",
      { projectId, ref: options.ref, cursor: options.cursor, limit: options.limit },
      options,
    );
  }

  /** A commit of a project's trunk and the files it changed, with their text on each side. */
  commit(
    projectId: string,
    sha: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Repo_getCommit"]> {
    return this.call("Repo_getCommit", { projectId, sha }, options);
  }

  /** Operator: enrols an agent. The client secret in the answer is shown once. */
  enrolAgent(
    agent: EnrolAgentRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_enrolAgent"]> {
    return this.call(
      "Operator_enrolAgent",
      { ...agent, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Operator: suspends an agent; its next request is refused until it is reinstated. */
  suspendAgent(
    agentId: string,
    request: SuspendAgentRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_suspendAgent"]> {
    return this.call(
      "Operator_suspendAgent",
      { ...request, agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Operator: reinstates a suspended agent. */
  reinstateAgent(
    agentId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_reinstateAgent"]> {
    return this.call(
      "Operator_reinstateAgent",
      { agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Operator: revokes an agent for good; every credential it holds stops working. */
  revokeAgent(
    agentId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_revokeAgent"]> {
    return this.call(
      "Operator_revokeAgent",
      { agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Operator: escalations, optionally in one state; pass a page's `nextCursor` for the next. */
  escalations(
    options: CallOptions & {
      readonly state?: "open" | "ruled" | "withdrawn";
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Operator_listEscalations"]> {
    return this.call(
      "Operator_listEscalations",
      { state: options.state, cursor: options.cursor, limit: options.limit },
      options,
    );
  }

  /** Operator: rules on an escalation by one of its option ids. */
  giveRuling(
    escalationId: string,
    ruling: RulingRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_giveRuling"]> {
    return this.call(
      "Operator_giveRuling",
      { ...ruling, escalationId, "idempotency-key": keyOf(options) },
      options,
    );
  }
}

/** A path, query or header value: the contract makes them strings, numbers and booleans only. */
function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isTokenResponse(body: unknown): body is TokenResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "access_token" in body &&
    typeof body.access_token === "string" &&
    "expires_in" in body &&
    typeof body.expires_in === "number"
  );
}

const keyOf = (options: Idempotent) => options.idempotencyKey ?? crypto.randomUUID();

export function createKeelClient(
  options: KeelClientOptions | PublicClientOptions | SessionClientOptions,
): KeelClient {
  return new KeelClient(options);
}
