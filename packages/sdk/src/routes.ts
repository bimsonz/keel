import type { WireInputs, WireOutputs } from "@keeltown/contracts";

/** Where each input key of an operation goes on the wire; every other key is the JSON body. */
export interface Route {
  readonly method: "GET" | "POST" | "PUT";
  /** Relative to `/v1`, with `{name}` for each path parameter. */
  readonly path: string;
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
}

/**
 * The operations this client calls, by operation id. A unit test holds each
 * entry equal to the published document (method, path, query and header
 * parameters), so a spec change that moves one fails there, not in production.
 */
export const ROUTES = {
  whoami: { method: "GET", path: "/agents/me" },
  declare: { method: "POST", path: "/changes", headers: ["idempotency-key"] },
  Changes_getChange: { method: "GET", path: "/changes/{changeId}" },
  submit: { method: "POST", path: "/submissions", headers: ["idempotency-key", "keel-lease"] },
  status: { method: "GET", path: "/changes/{changeId}/submission", query: ["wait"] },
  inbox: { method: "GET", path: "/inbox", query: ["cursor", "wait"] },
  Inbox_listEvents: { method: "GET", path: "/events", query: ["cursor", "wait", "limit"] },
  Views_getTrunk: { method: "GET", path: "/projects/{projectId}/trunk" },
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
} as const satisfies Partial<Record<keyof WireOutputs, Route>>;

export type RoutedOperation = keyof typeof ROUTES;

/** An operation's input as the contract declares it; an operation with no parameters takes none. */
export type InputOf<Op extends RoutedOperation> = Op extends keyof WireInputs
  ? WireInputs[Op]
  : Record<string, never>;
