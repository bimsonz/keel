import type {
  Admitted,
  Credential,
  PresentedToken,
  SignedIn,
  TokenRefusal,
  TokenUnchecked,
} from "@keeltown/core/application/identity";
import type { AgentClaims } from "@keeltown/core/domain/identity";
import type { UserId } from "@keeltown/core/kernel";
import { presentedToken } from "./caller.ts";
import { problemResponse } from "./problems.ts";

/** The session cookie Better Auth sets for Keel (`__Secure-` and the `keel` prefix). */
export const SESSION_COOKIE = "__Secure-keel.session_token";

/**
 * The door a request came in by. Each is a resource of its own (RFC 8707): an
 * agent's token says which it is for, and a door takes only its own.
 */
export type Door = "api" | "mcp";

/** Why the gate refused a credential, as composition reads it from the core gate's errors. */
export type GateRefusal =
  | { readonly refused: "invalid" }
  | { readonly refused: "revoked" }
  | { readonly refused: "unplaced"; readonly agentId: string };

/** The user a session names, with how and when that session was signed in. */
export interface SessionUser {
  readonly userId: UserId;
  readonly signedIn: SignedIn;
}

export interface GateDeps {
  /** `https://<KEEL_HOST>`: the one origin a request authenticated by the session cookie may come from. */
  readonly origin: string;
  /**
   * The user a Better Auth session names, from these headers' cookie or bearer, with the session's
   * sign-in method and time, or null when there is none. It makes Better Auth for the call: never
   * one kept beyond the request.
   */
  readonly sessionUser: (headers: Headers) => Promise<SessionUser | null>;
  /**
   * The claims of an agent's own token presented at `door`, once the identity adapter's checks
   * pass: its signature, issuer, expiry, that it is for this door, and its key binding.
   */
  readonly agentToken: (
    presented: PresentedToken,
    door: Door,
  ) => Promise<AgentClaims | TokenRefusal | TokenUnchecked>;
  /**
   * The `WWW-Authenticate` value of a 401 at `door`: where the door's metadata is, so a client
   * finds the server that issues its tokens, or for a refused proof what a proof must be.
   */
  readonly challenge: (door: Door, refusal?: TokenRefusal) => string;
  /** The principal for a credential, or why it is refused. */
  readonly admit: (
    credential: Credential,
  ) => Promise<{ readonly admitted: Admitted } | GateRefusal>;
}

/** An admitted request, with the gate's cost in a `Server-Timing` value. */
export interface Gated {
  readonly admitted: Admitted;
  readonly timing: string;
  /**
   * The door's challenge, for a 401 the policy makes after the gate: a request
   * with no credential is admitted as anonymous, and refused there.
   */
  readonly challenge: string;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** The type an agent's own token names in its header (RFC 9068); a token of the secret exchange says `JWT`. */
const ACCESS_TOKEN = "at+jwt";

/** What a JWT's header says its type is, unverified: it only chooses which check the token is given. */
function typeOf(jwt: string): string | undefined {
  try {
    const header: unknown = JSON.parse(
      atob((jwt.split(".")[0] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
    );
    const typ: unknown =
      typeof header === "object" && header !== null && "typ" in header ? header.typ : undefined;
    return typeof typ === "string" ? typ.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

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

/** A 401 with the door's challenge, so a client that holds no good token learns where to get one. */
function challenged(response: Response, challenge: string): Response {
  if (response.status === 401) response.headers.set("www-authenticate", challenge);
  return response;
}

/** How long a client is told to wait before it sends again a request whose token could not be checked. */
const RECHECK_SECONDS = 2;

/**
 * The answer to a token that could not be checked: the fault is Keel's, so it
 * is never a 401, which would tell the agent to throw a good token away.
 */
function notChecked(requestId: string): Response {
  const response = problemResponse(503, "service.unavailable", requestId, {
    detail: "Keel could not check this token just now. Nothing says the token is bad.",
    retryAfterMs: RECHECK_SECONDS * 1000,
    nextActions: [{ kind: "wait", title: "Send the request again after retryAfterMs" }],
  });
  response.headers.set("retry-after", String(RECHECK_SECONDS));
  return response;
}

function refusal(answer: GateRefusal, requestId: string): Response {
  switch (answer.refused) {
    case "revoked":
      return problemResponse(401, "auth.revoked", requestId, {
        nextActions: [
          {
            kind: "escalate",
            title:
              "This agent is revoked for good; ask a member of the project's org to enrol a new one",
          },
        ],
      });
    case "unplaced":
      console.error("agent unplaced", { requestId, agentId: answer.agentId });
      return problemResponse(403, "auth.agent_unplaced", requestId, {
        detail: `Agent ${answer.agentId} has no org: it was enrolled before tenancy and has not been placed in one.`,
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
 *
 * An agent that signed itself up presents its own token (`at+jwt`), as a plain
 * bearer or, bound to a key, under the `DPoP` scheme with a proof made by that
 * key for this request (RFC 9449). The identity adapter checks it for the door
 * the request came in by, and the core gate is handed its claims. Every 401
 * names the door's metadata in `WWW-Authenticate`: the gate's own, and the one
 * the policy answers a request with no credential, which carries the
 * challenge the gate hands on (`Gated.challenge`). A token the adapter could
 * not check (a store it reads did not answer) is answered 503 with a wait:
 * not admitted, and not told it is bad.
 *
 * A session is admitted with how and when it was signed in, so an operation
 * that wants a fresh sign-in can ask it of its caller. A paused agent is
 * admitted too: the policy answers it, not the gate.
 */
export async function gate(
  request: Request,
  requestId: string,
  deps: GateDeps,
  options: { readonly cookies: boolean; readonly door?: Door } = { cookies: true },
): Promise<Gated | Response> {
  const door = options.door ?? "api";
  const refused = (answer: GateRefusal) =>
    challenged(refusal(answer, requestId), deps.challenge(door));
  const started = Date.now();
  let sessionMs = 0;
  const session = async (headers: Headers): Promise<SessionUser | null> => {
    const at = Date.now();
    const user = await deps.sessionUser(headers);
    sessionMs = Date.now() - at;
    return user;
  };
  let credential: Credential = { _tag: "None" };
  const header = request.headers.get("authorization");
  if (header !== null) {
    const presented = presentedToken(header);
    if (presented === null) return refused({ refused: "invalid" });
    const { scheme, token } = presented;
    if (JWT.test(token) && typeOf(token) === ACCESS_TOKEN) {
      const answer = await deps.agentToken(
        {
          token,
          scheme,
          proof: request.headers.get("dpop") ?? undefined,
          method: request.method,
          // Keel's own origin, never the request's Host: a proof is for the address Keel answers on.
          url: `${deps.origin}${new URL(request.url).pathname}`,
        },
        door,
      );
      if ("unchecked" in answer) return notChecked(requestId);
      if ("refused" in answer)
        return challenged(
          problemResponse(401, "auth.invalid_token", requestId, {
            detail: answer.detail,
            nextActions: [
              {
                kind: "escalate",
                title:
                  "Ask the token endpoint named in /.well-known/oauth-authorization-server for a token for this address, with a request your key signs",
              },
            ],
          }),
          deps.challenge(door, answer),
        );
      credential = { _tag: "Claims", claims: answer };
    } else if (scheme !== "Bearer") return refused({ refused: "invalid" });
    else if (JWT.test(token)) credential = { _tag: "Token", token };
    else {
      const user = await session(only(request.headers, "authorization"));
      if (user === null) return refused({ refused: "invalid" });
      credential = { _tag: "Session", userId: user.userId, signedIn: user.signedIn };
    }
  } else if (options.cookies && hasSessionCookie(request.headers.get("cookie"))) {
    if (!SAFE_METHODS.has(request.method) && request.headers.get("origin") !== deps.origin)
      return problemResponse(403, "auth.cross_site", requestId, {
        detail: `A request signed in by the session cookie may change something only from ${deps.origin}.`,
        nextActions: [
          { kind: "escalate", title: "Send it from Keel's own pages, or with a bearer token" },
        ],
      });
    const user = await session(only(request.headers, "cookie"));
    if (user !== null)
      credential = { _tag: "Session", userId: user.userId, signedIn: user.signedIn };
  }
  const answer = await deps.admit(credential);
  if (!("admitted" in answer)) return refused(answer);
  return {
    admitted: answer.admitted,
    timing: `gate;dur=${Date.now() - started}, session;dur=${sessionMs}`,
    challenge: deps.challenge(door),
  };
}
