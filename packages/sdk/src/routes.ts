import type { WireInputs, WireOutputs } from "@keeltown/contracts";

/** Where each input key of an operation goes on the wire; every other key is the JSON body. */
export interface Route {
  readonly method: "GET" | "POST" | "PUT";
  /** Relative to `/v1`, with `{name}` for each path parameter. */
  readonly path: string;
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
}

/** Operations the client never calls by route, each with the reason. */
export const UNROUTED = {
  Auth_exchangeToken:
    "the client's own token exchange: an RFC 6749 form post it makes before any call, not a JSON call",
} as const;

export type UnroutedOperation = keyof typeof UNROUTED;

/**
 * Every operation in the published document, by operation id, except those
 * `UNROUTED` names. A unit test holds this table and the document equal both
 * ways (method, path, query and header parameters), so a spec change that adds
 * or moves an operation fails there, not in production.
 */
export const ROUTES = {
  whoami: { method: "GET", path: "/agents/me" },
  SignIn_methods: { method: "GET", path: "/auth/methods" },
  declare: { method: "POST", path: "/changes", headers: ["idempotency-key"] },
  change: { method: "GET", path: "/changes/{changeId}" },
  submit: { method: "POST", path: "/submissions", headers: ["idempotency-key", "keel-lease"] },
  status: { method: "GET", path: "/changes/{changeId}/submission", query: ["wait"] },
  inbox: { method: "GET", path: "/inbox", query: ["cursor", "wait"] },
  Inbox_listEvents: {
    method: "GET",
    path: "/events",
    query: ["cursor", "project", "wait", "limit"],
  },
  Views_getTrunk: { method: "GET", path: "/projects/{projectId}/trunk" },
  abandon: {
    method: "POST",
    path: "/changes/{changeId}/abandon",
    headers: ["idempotency-key", "keel-lease"],
  },
  Operator_createProject: { method: "POST", path: "/projects", headers: ["idempotency-key"] },
  Operator_getSettings: { method: "GET", path: "/projects/{projectId}/settings" },
  Operator_putSettings: { method: "PUT", path: "/projects/{projectId}/settings" },
  Operator_enrolAgent: { method: "POST", path: "/agents", headers: ["idempotency-key"] },
  Repo_getTree: { method: "GET", path: "/projects/{projectId}/repo/tree", query: ["ref", "path"] },
  Repo_getBlob: { method: "GET", path: "/projects/{projectId}/repo/blob", query: ["ref", "path"] },
  Repo_listCommits: {
    method: "GET",
    path: "/projects/{projectId}/repo/commits",
    query: ["ref", "cursor", "limit"],
  },
  Repo_getCommit: { method: "GET", path: "/projects/{projectId}/repo/commits/{sha}" },
  Sessions_openSession: { method: "POST", path: "/sessions", headers: ["idempotency-key"] },
  Changes_listChanges: {
    method: "GET",
    path: "/changes",
    query: ["state", "project", "cursor", "limit"],
  },
  revise: {
    method: "POST",
    path: "/changes/{changeId}/revisions",
    headers: ["keel-lease", "idempotency-key", "if-match"],
  },
  rely: {
    method: "POST",
    path: "/changes/{changeId}/premises",
    headers: ["keel-lease", "idempotency-key"],
  },
  nearby: { method: "GET", path: "/changes/{changeId}/nearby" },
  adopt: { method: "POST", path: "/changes/{changeId}/adopt", headers: ["idempotency-key"] },
  rebase: {
    method: "POST",
    path: "/changes/{changeId}/rebase",
    headers: ["keel-lease", "idempotency-key"],
  },
  sketch: { method: "POST", path: "/sketches", headers: ["idempotency-key"] },
  Workspaces_refreshWorkspaceToken: {
    method: "POST",
    path: "/workspaces/{workspaceId}/token",
    headers: ["idempotency-key"],
  },
  Workspaces_releaseWorkspace: {
    method: "POST",
    path: "/workspaces/{workspaceId}/release",
    headers: ["idempotency-key"],
  },
  Conflicts_listConflicts: {
    method: "GET",
    path: "/conflicts",
    query: ["project", "open", "changeId", "state", "cursor", "limit"],
  },
  Conflicts_getConflict: { method: "GET", path: "/conflicts/{conflictId}", query: ["project"] },
  resolve: {
    method: "POST",
    path: "/conflicts/{conflictId}/resolution",
    headers: ["keel-lease", "idempotency-key"],
  },
  why: { method: "GET", path: "/why", query: ["path", "line", "subject"] },
  Memory_listDecisions: {
    method: "GET",
    path: "/decisions",
    query: ["subject", "cursor", "limit"],
  },
  Memory_getDecision: { method: "GET", path: "/decisions/{decisionId}" },
  Lattices_listLattices: { method: "GET", path: "/lattices" },
  Inbox_getSnapshot: { method: "GET", path: "/events/snapshot", query: ["project"] },
  Views_getVerdict: { method: "GET", path: "/verdicts/{verdictId}" },
  Views_getCandidate: { method: "GET", path: "/candidates/{candidateId}" },
  Views_listLanes: {
    method: "GET",
    path: "/projects/{projectId}/lanes",
    query: ["cursor", "limit"],
  },
  Operator_listProjects: { method: "GET", path: "/projects", query: ["cursor", "limit"] },
  Orgs_getProject: { method: "GET", path: "/orgs/{org}/projects/{name}" },
  Users_me: { method: "GET", path: "/users/me" },
  Admin_createUser: { method: "POST", path: "/admin/users" },
  Operator_suspendAgent: {
    method: "POST",
    path: "/agents/{agentId}/suspend",
    headers: ["idempotency-key"],
  },
  Operator_reinstateAgent: {
    method: "POST",
    path: "/agents/{agentId}/reinstate",
    headers: ["idempotency-key"],
  },
  Operator_revokeAgent: {
    method: "POST",
    path: "/agents/{agentId}/revoke",
    headers: ["idempotency-key"],
  },
  Operator_listEscalations: {
    method: "GET",
    path: "/escalations",
    query: ["state", "cursor", "limit"],
  },
  Operator_giveRuling: {
    method: "POST",
    path: "/escalations/{escalationId}/ruling",
    headers: ["idempotency-key"],
  },
} as const satisfies Record<Exclude<keyof WireOutputs, UnroutedOperation>, Route>;

export type RoutedOperation = keyof typeof ROUTES;

/** An operation's input as the contract declares it; an operation with no parameters takes none. */
export type InputOf<Op extends RoutedOperation> = Op extends keyof WireInputs
  ? WireInputs[Op]
  : Record<string, never>;
