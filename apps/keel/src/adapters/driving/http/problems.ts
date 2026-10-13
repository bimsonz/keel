import { ARRIVE } from "@keeltown/core/domain/identity";
import type { WhoamiResult } from "../../../generated/http/app.gen.ts";

/**
 * Every problem the spec declares has the same body: RFC 9457 problem details
 * plus Keel's fields. The type is read off a generated result, so a spec change
 * to the problem shape breaks compilation here.
 */
export type ProblemBody = Extract<WhoamiResult, { status: 503 }>["body"];
export type ProblemCode = ProblemBody["code"];
export type NextAction = ProblemBody["nextActions"][number];

/**
 * What a token Keel cannot take is answered with, as the policy answers no
 * credential at all: an agent signs up with a key, and the walk says the rest.
 */
export const arrival = (): NextAction[] =>
  ARRIVE.map(({ kind, title, operationId }) => ({
    kind,
    title,
    ...(operationId === undefined ? {} : { operationId }),
  }));

const TITLES: Record<ProblemCode, string> = {
  "auth.invalid_token": "The bearer token is missing, malformed, expired or unknown",
  "auth.required": "This needs a signed-in user or an agent's token",
  "auth.forbidden": "The policy refuses this caller this action",
  "auth.cross_site": "A request signed in by the session cookie came from another origin",
  "auth.agent_unplaced": "The agent has no org",
  "auth.revoked": "The agent's credentials have been revoked",
  "auth.fresh_sign_in_required": "This needs a passkey sign-in from the last ten minutes",
  "request.invalid": "The request does not match the API contract",
  "request.idempotency_conflict": "This idempotency key was already used for a different request",
  "request.precondition_failed": "The resource changed since you last read it",
  "resource.not_found": "No such resource",
  "rate.limited": "Too many requests",
  "service.unavailable": "Keel cannot serve this right now",
  "service.not_implemented": "This operation is part of the contract but not implemented yet",
  "internal.defect": "Keel hit a defect while serving this request",
  "change.not_found": "No such change",
  "conflict.not_found": "No such conflict",
  "conflict.move_refused": "Keel cannot make that move on the conflict",
  "escalation.not_found": "No such escalation",
  "escalation.state_refused": "The escalation is not open to a ruling",
  "escalation.option_unknown": "The escalation does not offer that option",
  "probe.not_found": "No such probe",
  "change.lease_stale": "The lease is not the change's active lease",
  "change.lease_not_lapsed": "The change's lease has not lapsed, so it cannot be adopted yet",
  "change.state_refused": "The change's state does not allow this",
  "change.revision_mismatch": "The change moved past the revision you last read",
  "change.commit_not_in_workspace": "The commit is not in the change's workspace",
  "workspace.pool_exhausted": "No workspace is ready yet",
  "workspace.busy": "The change's workspace was busy, so nothing moved",
  "workspace.pack_too_large": "What the workspace needs from trunk is over the relay limit",
  "workspace.head_moved": "The workspace moved since you read it, so nothing was written",
  "commit.bad_edits": "An edit names a bad, duplicate or nested path",
  "commit.edits_refused": "An edit cannot apply to the files as they are",
  "commit.parent_not_found": "The workspace holds no such commit to build on",
  "commit.parent_refused": "A commit builds only on the workspace's head or the change's base",
  "repo.ref_not_found": "The project's trunk has no such branch or commit",
  "repo.path_not_found": "Nothing of that kind at this path",
  "agent.state_refused": "The agent's standing does not allow this",
  "invitation.state_refused": "The agent's invitation does not allow this",
  "project.name_taken": "The namespace already has a project by that name",
  "project.import_refused": "Nothing was imported from that URL",
  "project.import_too_large": "The repository's history is larger than Keel imports",
  "quota.exceeded": "The namespace is at its quota",
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

/** How long a client is told to wait before it sends again a request Keel could not serve just now. */
const RETRY_SECONDS = 2;

/** What a request that met the database while it was away is told. */
export const DATABASE_AWAY =
  "Keel's database did not answer just now. Send the request again after retryAfterMs, with the same Idempotency-Key if it carried one.";

/**
 * What Keel answers when it could not serve a request just now and nothing is
 * wrong with what was sent: a 503 that says how long to wait three ways, in
 * the header an HTTP client reads, in `retryAfterMs` and as its one next
 * action. This is a handler's result; `unavailable` is the same as a Response.
 */
export function unavailableResult(
  requestId: string,
  detail: string,
): {
  readonly status: 503;
  readonly body: ProblemBody;
  readonly headers: { readonly "retry-after": number };
} {
  return {
    status: 503,
    body: problem(503, "service.unavailable", requestId, {
      detail,
      retryAfterMs: RETRY_SECONDS * 1000,
      nextActions: [{ kind: "wait", title: "Send the request again after retryAfterMs" }],
    }),
    headers: { "retry-after": RETRY_SECONDS },
  };
}

/** `unavailableResult` as a raw Response, for middleware that answers before any route does. */
export function unavailable(requestId: string, detail: string): Response {
  const { status, body, headers } = unavailableResult(requestId, detail);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/problem+json",
      "retry-after": String(headers["retry-after"]),
    },
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
