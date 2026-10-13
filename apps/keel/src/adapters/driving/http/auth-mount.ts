import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";
import { SESSION_COOKIE } from "./gate.ts";
import { problemResponse } from "./problems.ts";

/** Better Auth's mount: outside the TypeSpec document and problem+json, like the token endpoint. */
export interface AuthMount {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
  /** Whether this key may make another request now (the Workers Rate Limiting binding). */
  readonly admit: (key: string) => Promise<boolean>;
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

/** Mounts Better Auth under its base path, each IP limited on everything but reads. */
export function registerAuth(app: Hono<AppEnv>, mount: AuthMount): void {
  app.all(`${mount.basePath}/*`, async (c) => {
    const request = c.req.raw;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await mount.admit(`auth:${ip}`)))
        return problemResponse(429, "rate.limited", c.get("requestId"), {
          detail: "Too many sign-in requests from this address; wait a minute.",
        });
    }
    const path = new URL(request.url).pathname.slice(mount.basePath.length);
    return withoutSessionTokens(path, await mount.handler(oneCredential(request)));
  });
}
