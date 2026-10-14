import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";
import { SESSION_COOKIE } from "./gate.ts";
import { DATABASE_AWAY, problemResponse, unavailable } from "./problems.ts";
import { limitedExchange, type TokenLimits } from "./token-limits.ts";

/** Better Auth's mount: outside the TypeSpec document and problem+json, like the token endpoint. */
export interface AuthMount {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
  /** Whether this key may make another request now (the Workers Rate Limiting binding). */
  readonly admit: (key: string) => Promise<boolean>;
  /**
   * Where an agent asks for a token, under the base path. Those requests are
   * held to the token limits, not this one: an agent's runs ask every few
   * minutes, and must not spend what a person's sign-in is allowed.
   */
  readonly tokenPath: string;
  readonly tokenLimits: TokenLimits;
}

/**
 * The one answer that hands a session's token to its holder: the device grant's
 * token endpoint, which is how `keeltown login` gets its bearer.
 */
const TOKEN_ENDPOINT = "/device/token";

/**
 * A session's token belongs in its HttpOnly cookie, never in a page's script:
 * every JSON answer loses its `token` fields, at any depth, and the bearer
 * plugin's `set-auth-token` header is dropped.
 */
export async function withoutSessionTokens(path: string, response: Response): Promise<Response> {
  if (path === TOKEN_ENDPOINT) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-auth-token");
  const type = headers.get("content-type") ?? "";
  if (!/^application\/(.+\+)?json\b/i.test(type) || response.body === null)
    return new Response(response.body, { status: response.status, headers });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers });
  }
  headers.delete("content-length");
  return new Response(JSON.stringify(stripTokens(body)), { status: response.status, headers });
}

function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "token")
      .map(([key, inner]) => [key, stripTokens(inner)]),
  );
}

/**
 * The request as Better Auth is to read it: with one credential, as the gate
 * reads one (gate.ts). A request that presents an `Authorization` header is
 * that credential's alone, so its session cookie is taken out. Better Auth's
 * handlers do not agree on which of the two they act for, and Keel's checks
 * read one session. Every other cookie stays: a passkey ceremony's challenge
 * rides in one.
 */
export function oneCredential(request: Request): Request {
  const cookie = request.headers.get("cookie");
  if (cookie === null || request.headers.get("authorization") === null) return request;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith(`${SESSION_COOKIE}=`))
    .join("; ");
  const headers = new Headers(request.headers);
  if (kept === "") headers.delete("cookie");
  else headers.set("cookie", kept);
  return new Request(request, { headers });
}

/**
 * Mounts Better Auth under its base path. Every write but the token exchange
 * is limited by IP; the exchange is held to the token limits, which count an
 * agent by the token it was issued and an address by its failures. A 503 of
 * Better Auth's is answered as Keel's own, as its 429 is: a problem that says
 * when to send the request again.
 */
export function registerAuth(app: Hono<AppEnv>, mount: AuthMount): void {
  app.all(`${mount.basePath}/*`, async (c) => {
    const request = c.req.raw;
    const path = new URL(request.url).pathname.slice(mount.basePath.length);
    const answer = async () => {
      const answered = await mount.handler(oneCredential(request));
      // Of what Keel mounts, Better Auth answers 503 for one thing: its database was away.
      if (answered.status === 503) return unavailable(c.get("requestId"), DATABASE_AWAY);
      return withoutSessionTokens(path, answered);
    };
    if (request.method === "GET" || request.method === "HEAD") return answer();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (path === mount.tokenPath)
      return limitedExchange(ip, c.get("requestId"), mount.tokenLimits, answer);
    if (!(await mount.admit(`auth:${ip}`)))
      return problemResponse(429, "rate.limited", c.get("requestId"), {
        detail: "Too many sign-in requests from this address; wait a minute.",
      });
    return answer();
  });
}
