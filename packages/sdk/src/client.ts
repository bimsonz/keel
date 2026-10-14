import type {
  AbandonRequest,
  ChangeState,
  ConflictState,
  CreateCredentialRequest,
  CreateProjectRequest,
  DeclareRequest,
  EnrolAgentRequest,
  OpenSessionRequest,
  ProjectSettings,
  PutDeployTargetRequest,
  RelyRequest,
  ResolveRequest,
  ReviseRequest,
  RulingRequest,
  SubmitRequest,
  CommitRequest,
  SuspendAgentRequest,
  TokenResponse,
  WireOutputs,
} from "@keeltown/contracts";
import {
  type AgentSigner,
  clientAssertion,
  type Discovered,
  discover,
  dpopProof,
  refusalOf,
  runKey,
} from "./agent-key.ts";
import { KeelProblem, KeelTokenError } from "./problem.ts";
import { type InputOf, type OutputOf, ROUTES, type RoutedOperation } from "./routes.ts";

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

/**
 * An agent that holds a key: the client asks for five-minute tokens
 * with a request the key signs, each for one project and one run, and bound to
 * a key the client makes for itself and never stores. Every call then carries
 * a proof by that key, so a token copied from a log is no use without it.
 */
export interface KeyClientOptions {
  readonly baseUrl: string;
  /** The agent the key signed up as: its sign-up's `client_id`. */
  readonly agentId: string;
  /** The account's key. It signs requests for tokens and nothing else. */
  readonly key: AgentSigner;
  /** The one project the tokens are for; none for a token that stands in the agent's own namespace. */
  readonly project?: string;
  /** The run's label, such as `nightly-deps`: the same label is the same run across restarts. */
  readonly run?: string;
  /**
   * The door the tokens open: Keel's API when absent, or `<baseUrl>/mcp` for
   * its MCP endpoint. Each door refuses the other's token, so a client made
   * for the MCP door is for handing its token to an MCP client.
   */
  readonly resource?: string;
  /** False asks for a plain bearer with no key behind it, to hand to a tool that cannot sign. */
  readonly bound?: boolean;
  /** Scopes to ask for; every scope the agent holds when absent. */
  readonly scopes?: readonly string[];
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

type ClientOptions =
  | KeelClientOptions
  | KeyClientOptions
  | PublicClientOptions
  | SessionClientOptions;

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** A mutating call is retried safely only under the same key; one is minted when absent. */
export interface Idempotent extends CallOptions {
  readonly idempotencyKey?: string;
}

/** A token is refreshed this long before it expires, so a call never carries one that lapses in flight. */
const EXPIRY_MARGIN_MS = 30_000;

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Keel's API, typed from `@keeltown/contracts`. It exchanges the client's
 * credentials (a key, or a client secret) for a token, caches it until shortly
 * before it expires, and on a 401 exchanges once more and retries the call
 * once, under the same Idempotency-Key. A refusal throws `KeelProblem`,
 * carrying the next actions.
 */
export class KeelClient {
  readonly #options: ClientOptions;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  #token: { readonly value: string; readonly expiresAt: number } | undefined;
  /** Where Keel's own document says to ask for a token: read once. */
  #discovered: Promise<Discovered> | undefined;
  /** The key this client's tokens are bound to: one for the client's life, in memory only. */
  #runKey: Promise<AgentSigner> | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get #api(): string {
    return `${this.#options.baseUrl.replace(/\/+$/, "")}/v1`;
  }

  /** The key a bound token's proofs are made by, or none for a client that asked for a plain bearer. */
  #binding(): Promise<AgentSigner> | undefined {
    if (!("key" in this.#options) || this.#options.bound === false) return undefined;
    this.#runKey ??= runKey();
    return this.#runKey;
  }

  /** A token for an agent's key: asked of the endpoint Keel's document names, with a request the key signs. */
  async #keyToken(credentials: KeyClientOptions): Promise<string> {
    this.#discovered ??= discover(credentials.baseUrl, this.#fetch).catch((error: unknown) => {
      // A failed read is not kept: the next call asks again.
      this.#discovered = undefined;
      throw error;
    });
    const { issuer, tokenEndpoint } = await this.#discovered;
    const binding = await this.#binding();
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await clientAssertion(credentials.key, {
        agentId: credentials.agentId,
        audience: issuer,
      }),
    });
    if (credentials.resource !== undefined) form.set("resource", credentials.resource);
    if (credentials.project !== undefined) form.set("project", credentials.project);
    if (credentials.run !== undefined) form.set("run", credentials.run);
    if (credentials.scopes !== undefined) form.set("scope", credentials.scopes.join(" "));
    const response = await this.#fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(binding === undefined
          ? {}
          : { dpop: await dpopProof(binding, { method: "POST", url: tokenEndpoint }) }),
      },
      body: form.toString(),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw refusalOf(response.status, body);
    if (!isTokenResponse(body)) throw new KeelTokenError("invalid_response", response.status);
    this.#token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return body.access_token;
  }

  /** A token for the client's credentials: the cached one while it is fresh. */
  async token(options: { readonly fresh?: boolean } = {}): Promise<string> {
    if (options.fresh !== true && this.#token !== undefined && Date.now() < this.#token.expiresAt)
      return this.#token.value;
    const credentials = this.#options;
    if ("key" in credentials) return this.#keyToken(credentials);
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
    // A limited exchange is no refusal of the credentials: it is a problem like any other call's, and says how long to wait.
    if (response.status === 429) throw await KeelProblem.from(response);
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
  ): Promise<OutputOf<Op>> {
    const request = this.#request(operation, input);
    const binding = this.#binding();
    /** How the token is presented: under the DPoP scheme with a proof for this request when it is bound to a key. */
    const presenting = async (token: string): Promise<Record<string, string>> =>
      binding === undefined
        ? { authorization: `Bearer ${token}` }
        : {
            authorization: `DPoP ${token}`,
            dpop: await dpopProof(await binding, {
              method: request.method,
              url: request.url,
              accessToken: token,
            }),
          };
    const send = async (token: string | undefined) =>
      this.#fetch(request.url, {
        method: request.method,
        headers:
          token === undefined
            ? request.headers
            : { ...request.headers, ...(await presenting(token)) },
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const credentialed = "clientId" in this.#options || "key" in this.#options;
    const session = "session" in this.#options ? this.#options.session : undefined;
    let response = await send(credentialed ? await this.token() : session);
    if (credentialed && response.status === 401)
      response = await send(await this.token({ fresh: true }));
    if (!response.ok) throw await KeelProblem.from(response);
    // The body is the contract's: Keel validates every response against the published schemas.
    // Parsed from text, because `json()` is typed `any` in DOM's lib but `unknown` in Node's. A 204 has none.
    const text = await response.text();
    const answer: OutputOf<Op> = response.status === 204 ? undefined : JSON.parse(text);
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
    const sendsBody = route.method !== "GET" && route.method !== "DELETE";
    if (sendsBody) headers["content-type"] = "application/json";
    return {
      url: `${this.#api}${path}${search}`,
      method: route.method,
      headers,
      body: sendsBody ? JSON.stringify(body) : undefined,
    };
  }

  /**
   * Keel's allowed-signers file, as stock git reads one: every key Keel signs
   * or has signed commits with. Save it, name it as git's
   * `gpg.ssh.allowedSignersFile`, and `git verify-commit` checks any commit
   * Keel landed. Open to anyone, so it is asked for with no credential.
   */
  async allowedSigners(options: CallOptions = {}): Promise<string> {
    const response = await this.#fetch(
      `${this.#options.baseUrl.replace(/\/+$/, "")}/.well-known/keel/allowed-signers`,
      {
        method: "GET",
        headers: { accept: "text/plain" },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) throw await KeelProblem.from(response);
    return response.text();
  }

  whoami(options?: CallOptions): Promise<WireOutputs["whoami"]> {
    return this.call("whoami", {}, options);
  }

  /**
   * The calling agent asks for a sponsor: a code, good once and for ten minutes, and the page where
   * a signed-in person approves it. A new request replaces the last.
   */
  askSponsor(options?: CallOptions): Promise<WireOutputs["askSponsor"]> {
    return this.call("askSponsor", {}, options);
  }

  /** Who an agent is, as anyone may see it: its name, its kind and the org it works in. */
  agent(agentId: string, options?: CallOptions): Promise<WireOutputs["Agents_getAgent"]> {
    return this.call("Agents_getAgent", { agentId }, options);
  }

  /** The agents the signed-in person stands behind. */
  sponsoredAgents(options?: CallOptions): Promise<WireOutputs["Agents_listSponsored"]> {
    return this.call("Agents_listSponsored", {}, options);
  }

  /**
   * The signed-in person stands behind an agent, with the code it showed them. Keel wants a fresh
   * sign-in for it: a passkey sign-in from the last ten minutes.
   */
  approveSponsor(
    agentId: string,
    code: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_approveSponsor"]> {
    return this.call(
      "Agents_approveSponsor",
      { agentId, code, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Ends the link between an agent and its sponsor: the sponsor's call, on a fresh sign-in, or the agent's own. */
  endSponsorship(
    agentId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_endSponsorship"]> {
    return this.call(
      "Agents_endSponsorship",
      { agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * The signed-in member invites an agent into an org, by the agent's handle. The agent gets
   * nothing until it accepts; then it reads and works there, and the member answers for it. Keel
   * wants a fresh sign-in for it: a passkey sign-in from the last ten minutes.
   */
  inviteAgent(
    namespace: string,
    agent: string,
    options: Idempotent & { readonly scopes?: readonly ("agent:read" | "agent:work")[] } = {},
  ): Promise<WireOutputs["Namespaces_inviteAgent"]> {
    return this.call(
      "Namespaces_inviteAgent",
      {
        handle: namespace,
        agent,
        ...(options.scopes === undefined ? {} : { scopes: [...options.scopes] }),
        "idempotency-key": keyOf(options),
      },
      options,
    );
  }

  /** The agents in an org: those that joined, and for its members the invitations not yet answered and who made each. */
  namespaceAgents(
    namespace: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Namespaces_listAgents"]> {
    return this.call("Namespaces_listAgents", { handle: namespace }, options);
  }

  /** Takes an agent out of an org, or withdraws its invitation: the member who invited it or a maintainer, on a fresh sign-in. */
  removeAgent(
    namespace: string,
    agentId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Namespaces_removeAgent"]> {
    return this.call(
      "Namespaces_removeAgent",
      { handle: namespace, agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** The namespaces the calling agent was invited into: the ones it joined and the ones still asking. */
  invitations(options?: CallOptions): Promise<WireOutputs["Agents_listNamespaces"]> {
    return this.call("Agents_listNamespaces", {}, options);
  }

  /** The calling agent accepts an invitation into a namespace, named by its handle or its id. */
  acceptInvitation(
    namespace: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_acceptInvitation"]> {
    return this.call(
      "Agents_acceptInvitation",
      { namespace, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** The calling agent declines an invitation it has not accepted, or leaves a namespace it joined. */
  leaveNamespace(
    namespace: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_leaveNamespace"]> {
    return this.call(
      "Agents_leaveNamespace",
      { namespace, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * The signed-in person invites an agent to one project of their own namespace, by the agent's
   * handle, as a personal repository takes a collaborator. The agent gets nothing until it
   * accepts; then a token that names that project reads and works on it, and on nothing else of
   * the namespace. Keel wants a fresh sign-in for it: a passkey sign-in from the last ten minutes.
   */
  inviteToProject(
    projectId: string,
    agent: string,
    options: Idempotent & { readonly scopes?: readonly ("agent:read" | "agent:work")[] } = {},
  ): Promise<WireOutputs["Projects_inviteAgent"]> {
    return this.call(
      "Projects_inviteAgent",
      {
        projectId,
        agent,
        ...(options.scopes === undefined ? {} : { scopes: [...options.scopes] }),
        "idempotency-key": keyOf(options),
      },
      options,
    );
  }

  /** The agents invited to a project: those that joined, and for its owner the invitations not yet answered. */
  projectAgents(
    projectId: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Projects_listAgents"]> {
    return this.call("Projects_listAgents", { projectId }, options);
  }

  /** Takes an agent off a project of the signed-in person's own namespace, or withdraws its invitation, on a fresh sign-in. */
  removeFromProject(
    projectId: string,
    agentId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Projects_removeAgent"]> {
    return this.call(
      "Projects_removeAgent",
      { projectId, agentId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** The projects the calling agent was invited to, one by one: the ones it joined and the ones still asking. */
  projectInvitations(options?: CallOptions): Promise<WireOutputs["Agents_listProjects"]> {
    return this.call("Agents_listProjects", {}, options);
  }

  /** The calling agent accepts an invitation to one project, named by its id. */
  acceptProjectInvitation(
    projectId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_acceptProjectInvitation"]> {
    return this.call(
      "Agents_acceptProjectInvitation",
      { projectId, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** The calling agent declines an invitation to a project it has not accepted, or leaves one it joined. */
  leaveProject(
    projectId: string,
    options: Idempotent = {},
  ): Promise<WireOutputs["Agents_leaveProject"]> {
    return this.call(
      "Agents_leaveProject",
      { projectId, "idempotency-key": keyOf(options) },
      options,
    );
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

  /**
   * Commits edits to the change's workspace with no clone: Keel applies them
   * to `parent` (default `expectedHead`) and moves the workspace's main to the
   * new commit, which `submit` then takes.
   */
  commitEdits(
    changeId: string,
    commit: CommitRequest,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["commit"]> {
    return this.call(
      "commit",
      { changeId, ...commit, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /**
   * A fresh two-hour token for the workspace the caller's change holds, under
   * the change's lease: the same workspace, nothing else moves.
   */
  refreshWorkspaceToken(
    workspaceId: string,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["refreshWorkspaceToken"]> {
    return this.call(
      "refreshWorkspaceToken",
      { workspaceId, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
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

  /**
   * Why a line, a path or a subject is as it is: the decisions and premises
   * behind it, in an agent's own project unless `project` names another.
   */
  why(
    about: {
      readonly path?: string;
      readonly line?: number;
      readonly subject?: string;
      readonly project?: string;
    },
    options?: CallOptions,
  ): Promise<WireOutputs["why"]> {
    return this.call(
      "why",
      { path: about.path, line: about.line, subject: about.subject, project: about.project },
      options,
    );
  }

  /**
   * A project's decisions, newest first, optionally about one subject: an
   * agent's own project unless `project` names another. Pass a page's
   * `nextCursor` for the next.
   */
  decisions(
    options: CallOptions & {
      readonly project?: string;
      readonly subject?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Memory_listDecisions"]> {
    return this.call(
      "Memory_listDecisions",
      {
        project: options.project,
        subject: options.subject,
        cursor: options.cursor,
        limit: options.limit,
      },
      options,
    );
  }

  decision(decisionId: string, options?: CallOptions): Promise<WireOutputs["Memory_getDecision"]> {
    return this.call("Memory_getDecision", { decisionId }, options);
  }

  /** Where a change's submission stands; with `wait` (0–900 s), once it moves. */
  status(
    changeId: string,
    options: CallOptions & { readonly wait?: number } = {},
  ): Promise<WireOutputs["status"]> {
    return this.call("status", { changeId, wait: options.wait }, options);
  }

  /** Notices after `cursor`; with `wait` (0–900 s), the first one to arrive. */
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

  /** Operator: creates a project whose trunk starts as `source` says: empty, imported from a public Git URL, forked from a project, or made from a template. */
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

  /** Whose a handle is: a person's, an agent's or an org's, with the namespace's id. */
  namespace(
    handle: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Namespaces_getNamespace"]> {
    return this.call("Namespaces_getNamespace", { handle }, options);
  }

  /** A project by its namespace's handle and its own name, as `/<namespace>/<project>` names them, with the reader's role there. */
  project(
    handle: string,
    name: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Namespaces_getProject"]> {
    return this.call("Namespaces_getProject", { handle, name }, options);
  }

  /** The signed-in user: its handle, its own namespace, and its orgs with its role in each. */
  me(options?: CallOptions): Promise<WireOutputs["Users_me"]> {
    return this.call("Users_me", {}, options);
  }

  /** The projects the caller may read, each with its namespace and the reader's role there; pass a page's `nextCursor` for the next. */
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

  /**
   * Stores a provider's API token in a namespace, under a label: an owner's alone. The answer
   * names it by a minted id; the secret is never answered again, here or anywhere.
   */
  createCredential(
    namespace: string,
    credential: CreateCredentialRequest,
    options?: CallOptions,
  ): Promise<WireOutputs["Delivery_createCredential"]> {
    return this.call("Delivery_createCredential", { ...credential, handle: namespace }, options);
  }

  /** A namespace's credentials, by label and id: never a secret. */
  credentials(
    namespace: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Delivery_listCredentials"]> {
    return this.call("Delivery_listCredentials", { handle: namespace }, options);
  }

  /** Deletes a credential from a namespace: its secret is gone for good. */
  deleteCredential(namespace: string, credentialId: string, options?: CallOptions): Promise<void> {
    return this.call("Delivery_deleteCredential", { handle: namespace, credentialId }, options);
  }

  /**
   * Sets a project's deploy target, new or in place of the one of that name. Its credential must
   * be one of the project's own namespace, and must reach the account's Workers before anything is set.
   */
  putDeployTarget(
    projectId: string,
    name: string,
    target: PutDeployTargetRequest,
    options?: CallOptions,
  ): Promise<WireOutputs["Delivery_putDeployTarget"]> {
    return this.call("Delivery_putDeployTarget", { ...target, projectId, name }, options);
  }

  /** A project's deploy targets, in name order. */
  deployTargets(
    projectId: string,
    options?: CallOptions,
  ): Promise<WireOutputs["Delivery_listDeployTargets"]> {
    return this.call("Delivery_listDeployTargets", { projectId }, options);
  }

  /** Clears a project's deploy target. */
  deleteDeployTarget(projectId: string, name: string, options?: CallOptions): Promise<void> {
    return this.call("Delivery_deleteDeployTarget", { projectId, name }, options);
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

  /** What changed on trunk from `base` to `head` (`main` when absent), with each file's text on each side. */
  compare(
    projectId: string,
    base: string,
    options: CallOptions & { readonly head?: string } = {},
  ): Promise<WireOutputs["Repo_compare"]> {
    return this.call("Repo_compare", { projectId, base, head: options.head }, options);
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

  /** The agent's sponsor pauses it, on a fresh sign-in: every request it makes is refused until it is reinstated. */
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

  /** The agent's sponsor reinstates it, on a fresh sign-in. */
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

export function createKeelClient(options: ClientOptions): KeelClient {
  return new KeelClient(options);
}
