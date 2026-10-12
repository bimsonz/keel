import type { Admitted, Credential } from "@keeltown/core/application/identity";
import type { UserId } from "@keeltown/core/kernel";
import { bearerToken } from "./caller.ts";
import { problemResponse } from "./problems.ts";

/** The session cookie Better Auth sets for Keel (`__Secure-` and the `keel` prefix). */
export const SESSION_COOKIE = "__Secure-keel.session_token";

/** Why the gate refused a credential, as composition reads it from the core gate's errors. */
export type GateRefusal =
  | { readonly refused: "invalid" }
  | { readonly refused: "revoked" }
  | { readonly refused: "unplaced"; readonly agentId: string };

export interface GateDeps {
  /** `https://<KEEL_HOST>`: the one origin a request authenticated by the session cookie may come from. */
  readonly origin: string;
  /**
   * The user a Better Auth session names, from these headers' cookie or bearer, or null when there is
   * none. It makes Better Auth for the call: never one kept beyond the request.
   */
  readonly sessionUser: (headers: Headers) => Promise<UserId | null>;
  /** The principal for a credential, or why it is refused. */
  readonly admit: (
    credential: Credential,
  ) => Promise<{ readonly admitted: Admitted } | GateRefusal>;
}

/** An admitted request, with the gate's cost in a `Server-Timing` value. */
export interface Gated {
  readonly admitted: Admitted;
  readonly timing: string;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function hasSessionCookie(cookie: string | null): boolean {
  return (
    cookie !== null &&
    cookie.split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
  );
}

/** The request's headers with only the one credential the gate reads, so Better Auth reads no other. */
function only(headers: Headers, name: "authorization" | "cookie"): Headers {
  const value = headers.get(name);
  return new Headers(value === null ? {} : { [name]: value });
}

function refusal(answer: GateRefusal, requestId: string): Response {
  switch (answer.refused) {
    case "revoked":
      return problemResponse(401, "auth.revoked", requestId, {
        nextActions: [{ kind: "escalate", title: "Ask the agent's sponsor to reinstate it" }],
      });
    case "unplaced":
      console.error("agent unplaced", { requestId, agentId: answer.agentId });
      return problemResponse(403, "auth.agent_unplaced", requestId, {
        detail: `Agent ${answer.agentId} has no org or sponsor: it was enrolled before tenancy and has not been placed in an org.`,
        nextActions: [
          {
            kind: "escalate",
            title:
              "Ask a member of the project's org to enrol a new agent: this one was never placed",
          },
        ],
      });
    case "invalid":
      return problemResponse(401, "auth.invalid_token", requestId, {
        nextActions: [
          {
            kind: "call",
            title: "Exchange your client credentials for a token",
            operationId: "Auth_exchangeToken",
          },
        ],
      });
    default: {
      const unmapped: never = answer;
      return unmapped;
    }
  }
}

/**
 * The gate every /v1 operation passes: a Keel JWT
 * is an agent, a Better Auth session (its bearer, or the console's cookie) is a
 * user, and nothing is anonymous. A bearer that is presented and bad is refused,
 * never read as anonymous; a JWT never falls through to a session. A request the
 * cookie authenticates may change nothing unless it comes from Keel's own
 * origin: a mutation without that Origin is refused (fail closed). A stale
 * cookie reads as anonymous. MCP passes `cookies: false`: it takes bearers only.
 */
export async function gate(
  request: Request,
  requestId: string,
  deps: GateDeps,
  options: { readonly cookies: boolean } = { cookies: true },
): Promise<Gated | Response> {
  const started = Date.now();
  let sessionMs = 0;
  const session = async (headers: Headers): Promise<UserId | null> => {
    const at = Date.now();
    const user = await deps.sessionUser(headers);
    sessionMs = Date.now() - at;
    return user;
  };
  let credential: Credential = { _tag: "None" };
  const header = request.headers.get("authorization");
  if (header !== null) {
    const bearer = bearerToken(header);
    if (bearer === null) return refusal({ refused: "invalid" }, requestId);
    if (JWT.test(bearer)) credential = { _tag: "Token", token: bearer };
    else {
      const userId = await session(only(request.headers, "authorization"));
      if (userId === null) return refusal({ refused: "invalid" }, requestId);
      credential = { _tag: "Session", userId };
    }
  } else if (options.cookies && hasSessionCookie(request.headers.get("cookie"))) {
    if (!SAFE_METHODS.has(request.method) && request.headers.get("origin") !== deps.origin)
      return problemResponse(403, "auth.cross_site", requestId, {
        detail: `A request signed in by the session cookie may change something only from ${deps.origin}.`,
        nextActions: [
          { kind: "escalate", title: "Send it from Keel's own pages, or with a bearer token" },
        ],
      });
    const userId = await session(only(request.headers, "cookie"));
    if (userId !== null) credential = { _tag: "Session", userId };
  }
  const answer = await deps.admit(credential);
  if (!("admitted" in answer)) return refusal(answer, requestId);
  return {
    admitted: answer.admitted,
    timing: `gate;dur=${Date.now() - started}, session;dur=${sessionMs}`,
  };
}
