import type { WireInputs, WireOutputs } from "@keeltown/contracts";

/** Where each input key of an operation goes on the wire; every other key is the JSON body. */
export interface Route {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Relative to `/v1`, with `{name}` for each path parameter. */
  readonly path: string;
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
}

/** Operations the client never calls by route, each with the reason. */
export const UNROUTED = {
  Auth_exchangeToken:
    "the client's own token exchange: an RFC 6749 form post it makes before any call, not a JSON call",
  Auth_registerClient:
    "the client's own sign-up: an RFC 7591 registration it signs with its key before it has a token",
  Delivery_completeCloudflareConnect:
    "where Cloudflare's consent screen sends a person's browser back: a redirect, never a call",
} as const;

export type UnroutedOperation = keyof typeof UNROUTED;

/** Every operation in the document: each takes an input, answers a body, or both. */
type DocumentedOperation = keyof WireInputs | keyof WireOutputs;

/**
 * Every operation in the published document, by operation id, except those
 * `UNROUTED` names. A unit test holds this table and the document equal both
 * ways (method, path, query and header parameters), so a spec change that adds
 * or moves an operation fails there, not in production.
 */
export const ROUTES = {
  whoami: { method: "GET", path: "/agents/me" },
  askSponsor: { method: "POST", path: "/agents/me/sponsor-request", query: ["person"] },
  Agents_listSponsored: { method: "GET", path: "/agents/sponsored" },
  Agents_approveSponsor: {
    method: "PUT",
    path: "/agents/{agentId}/sponsor",
    headers: ["idempotency-key"],
  },
  Agents_endSponsorship: {
    method: "DELETE",
    path: "/agents/{agentId}/sponsor",
    headers: ["idempotency-key"],
  },
  Agents_getAgent: { method: "GET", path: "/agents/{agentId}" },
  Agents_listNamespaces: { method: "GET", path: "/agents/me/namespaces" },
  Agents_acceptInvitation: {
    method: "PUT",
    path: "/agents/me/namespaces/{namespace}",
    headers: ["idempotency-key"],
  },
  Agents_leaveNamespace: {
    method: "DELETE",
    path: "/agents/me/namespaces/{namespace}",
    headers: ["idempotency-key"],
  },
  Agents_listProjects: { method: "GET", path: "/agents/me/projects" },
  Agents_listReachableProjects: { method: "GET", path: "/agents/me/reachable-projects" },
  Agents_useProject: { method: "PUT", path: "/agents/me/run/project" },
  Agents_acceptProjectInvitation: {
    method: "PUT",
    path: "/agents/me/projects/{projectId}",
    headers: ["idempotency-key"],
  },
  Agents_leaveProject: {
    method: "DELETE",
    path: "/agents/me/projects/{projectId}",
    headers: ["idempotency-key"],
  },
  Projects_listAgents: { method: "GET", path: "/projects/{projectId}/agents" },
  Projects_inviteAgent: {
    method: "POST",
    path: "/projects/{projectId}/agents",
    headers: ["idempotency-key"],
  },
  Projects_removeAgent: {
    method: "DELETE",
    path: "/projects/{projectId}/agents/{agentId}",
    headers: ["idempotency-key"],
  },
  Namespaces_listAgents: { method: "GET", path: "/namespaces/{handle}/agents" },
  Namespaces_inviteAgent: {
    method: "POST",
    path: "/namespaces/{handle}/agents",
    headers: ["idempotency-key"],
  },
  Namespaces_removeAgent: {
    method: "DELETE",
    path: "/namespaces/{handle}/agents/{agentId}",
    headers: ["idempotency-key"],
  },
  SignIn_methods: { method: "GET", path: "/auth/methods" },
  declare: { method: "POST", path: "/changes", headers: ["idempotency-key"] },
  change: { method: "GET", path: "/changes/{changeId}" },
  submit: { method: "POST", path: "/submissions", headers: ["idempotency-key", "keel-lease"] },
  status: { method: "GET", path: "/changes/{changeId}/submission", query: ["wait"] },
  inbox: { method: "GET", path: "/inbox", query: ["cursor", "wait"] },
  Inbox_listEvents: {
    method: "GET",
    path: "/events",
    query: ["cursor", "project", "wait", "limit", "view"],
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
  Operator_syncUpstream: { method: "POST", path: "/projects/{projectId}/sync" },
  Operator_enrolAgent: { method: "POST", path: "/agents", headers: ["idempotency-key"] },
  Repo_getTree: { method: "GET", path: "/projects/{projectId}/repo/tree", query: ["ref", "path"] },
  Repo_getBlob: {
    method: "GET",
    path: "/projects/{projectId}/repo/blob",
    query: ["ref", "path", "startLine"],
  },
  Repo_listCommits: {
    method: "GET",
    path: "/projects/{projectId}/repo/commits",
    query: ["ref", "cursor", "limit"],
  },
  Repo_getCommit: { method: "GET", path: "/projects/{projectId}/repo/commits/{sha}" },
  Repo_compare: {
    method: "GET",
    path: "/projects/{projectId}/repo/compare",
    query: ["base", "head"],
  },
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
  commit: {
    method: "POST",
    path: "/changes/{changeId}/commits",
    headers: ["keel-lease", "idempotency-key"],
  },
  refreshWorkspaceToken: {
    method: "POST",
    path: "/workspaces/{workspaceId}/token",
    headers: ["keel-lease", "idempotency-key"],
  },
  Conflicts_listConflicts: {
    method: "GET",
    path: "/conflicts",
    query: ["project", "open", "changeId", "state", "cursor", "limit"],
  },
  Conflicts_getConflict: { method: "GET", path: "/conflicts/{conflictId}", query: ["project"] },
  Probes_getProbeSource: { method: "GET", path: "/probes/{probeId}/source", query: ["project"] },
  resolve: {
    method: "POST",
    path: "/conflicts/{conflictId}/resolution",
    headers: ["keel-lease", "idempotency-key"],
  },
  why: { method: "GET", path: "/why", query: ["project", "path", "line", "subject"] },
  Memory_listDecisions: {
    method: "GET",
    path: "/decisions",
    query: ["project", "subject", "cursor", "limit"],
  },
  Memory_getDecision: { method: "GET", path: "/decisions/{decisionId}" },
  Lattices_listLattices: { method: "GET", path: "/lattices" },
  Inbox_getSnapshot: { method: "GET", path: "/events/snapshot", query: ["project"] },
  Views_getVerdict: { method: "GET", path: "/verdicts/{verdictId}" },
  Views_listLanes: {
    method: "GET",
    path: "/projects/{projectId}/lanes",
    query: ["cursor", "limit"],
  },
  Operator_listProjects: { method: "GET", path: "/projects", query: ["cursor", "limit"] },
  Namespaces_getNamespace: { method: "GET", path: "/namespaces/{handle}" },
  Namespaces_getProject: { method: "GET", path: "/namespaces/{handle}/projects/{name}" },
  Users_me: { method: "GET", path: "/users/me" },
  Users_listSponsorRequests: { method: "GET", path: "/users/me/sponsor-requests" },
  Users_approveSponsorRequest: {
    method: "PUT",
    path: "/users/me/sponsor-requests/{agentId}",
    headers: ["idempotency-key"],
  },
  Users_declineSponsorRequest: {
    method: "DELETE",
    path: "/users/me/sponsor-requests/{agentId}",
    query: ["block"],
    headers: ["idempotency-key"],
  },
  Users_listBlockedAgents: { method: "GET", path: "/users/me/blocked-agents" },
  Users_unblockAgent: {
    method: "DELETE",
    path: "/users/me/blocked-agents/{agentId}",
    headers: ["idempotency-key"],
  },
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
  Delivery_createCredential: { method: "POST", path: "/namespaces/{handle}/credentials" },
  Delivery_listCredentials: { method: "GET", path: "/namespaces/{handle}/credentials" },
  Delivery_deleteCredential: {
    method: "DELETE",
    path: "/namespaces/{handle}/credentials/{credentialId}",
  },
  Delivery_putDeployTarget: { method: "PUT", path: "/projects/{projectId}/deploy-targets/{name}" },
  Delivery_listDeployTargets: { method: "GET", path: "/projects/{projectId}/deploy-targets" },
  Delivery_deleteDeployTarget: {
    method: "DELETE",
    path: "/projects/{projectId}/deploy-targets/{name}",
  },
  Delivery_beginCloudflareConnect: {
    method: "POST",
    path: "/projects/{projectId}/deploy-targets/{name}/cloudflare-connect",
  },
  diff: { method: "GET", path: "/changes/{changeId}/diff" },
} as const satisfies Record<Exclude<DocumentedOperation, UnroutedOperation>, Route>;

export type RoutedOperation = keyof typeof ROUTES;

/** What an operation answers on success: its body, or nothing for one that answers 204. */
export type OutputOf<Op extends RoutedOperation> = Op extends keyof WireOutputs
  ? WireOutputs[Op]
  : undefined;

/** An operation's input as the contract declares it; an operation with no parameters takes none. */
export type InputOf<Op extends RoutedOperation> = Op extends keyof WireInputs
  ? WireInputs[Op]
  : Record<string, never>;
