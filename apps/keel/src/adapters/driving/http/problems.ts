import type { WhoamiResult } from "../../../generated/http/app.gen.ts";

/**
 * Every problem the spec declares has the same body: RFC 9457 problem details
 * plus Keel's fields. The type is read off a generated result, so a spec change
 * to the problem shape breaks compilation here.
 */
export type ProblemBody = Extract<WhoamiResult, { status: 503 }>["body"];
export type ProblemCode = ProblemBody["code"];
export type NextAction = ProblemBody["nextActions"][number];

const TITLES: Record<ProblemCode, string> = {
  "auth.invalid_token": "The bearer token is missing, malformed, expired or unknown",
  "auth.insufficient_scope": "The token does not carry the scope this operation requires",
  "auth.revoked": "The agent's credentials have been revoked",
  "request.invalid": "The request does not match the API contract",
  "request.idempotency_conflict": "This idempotency key was already used for a different request",
  "request.precondition_failed": "The resource changed since you last read it",
  "resource.not_found": "No such resource",
  "rate.limited": "Too many requests",
  "service.unavailable": "Keel cannot serve this right now",
  "service.not_implemented": "This operation is part of the contract but not implemented yet",
  "internal.defect": "Keel hit a defect while serving this request",
  "change.not_found": "No such change",
  "change.lease_stale": "The lease is not the change's active lease",
  "change.lease_not_lapsed": "The change's lease has not lapsed, so it cannot be adopted yet",
  "change.state_refused": "The change's state does not allow this",
  "change.revision_mismatch": "The change moved past the revision you last read",
  "change.commit_not_in_workspace": "The commit is not in the change's workspace",
  "workspace.pool_exhausted": "No workspace is ready yet",
  "workspace.busy": "The change's workspace was busy, so nothing moved",
  "workspace.pack_too_large": "What the workspace needs from trunk is over the relay limit",
  "sketch.not_found": "No such sketch",
  "repo.ref_not_found": "The project's trunk has no such branch or commit",
  "repo.path_not_found": "Nothing of that kind at this path",
  "session.sponsor_refused": "The session names a sponsor the agent does not act for",
};

export interface ProblemExtras {
  readonly detail?: string;
  readonly nextActions?: readonly NextAction[];
  readonly issues?: ProblemBody["issues"];
  readonly retryAfterMs?: number;
}

/** A problem body. `type` is a URN, so the code never hardcodes a host. */
export function problem(
  status: number,
  code: ProblemCode,
  requestId: string,
  extras: ProblemExtras = {},
): ProblemBody {
  return {
    type: `urn:keel:problem:${code}`,
    title: TITLES[code],
    status,
    code,
    requestId,
    nextActions: [...(extras.nextActions ?? [])],
    ...(extras.detail === undefined ? {} : { detail: extras.detail }),
    ...(extras.issues === undefined ? {} : { issues: extras.issues }),
    ...(extras.retryAfterMs === undefined ? {} : { retryAfterMs: extras.retryAfterMs }),
  };
}

/** A problem as a raw Response, for middleware that answers before any route does. */
export function problemResponse(
  status: number,
  code: ProblemCode,
  requestId: string,
  extras: ProblemExtras = {},
): Response {
  return new Response(JSON.stringify(problem(status, code, requestId, extras)), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** The declared 503 every operation answers with until its lane implements it. */
export function notImplemented(requestId: string): {
  readonly status: 503;
  readonly body: ProblemBody;
} {
  return {
    status: 503,
    body: problem(503, "service.not_implemented", requestId, {
      detail:
        "The operation is in Keel's published contract; its implementation has not landed yet.",
    }),
  };
}
