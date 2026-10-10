import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/env.ts";
import { sessionExpired, unauthenticated } from "../http/problem.ts";
import type { SessionRecord, UserRecord } from "../store/types.ts";
import { resolveToken } from "./sessions.ts";

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * Resolves an `Authorization: Bearer` header to a session and user. Requests
 * without the header continue anonymously; a header that is malformed,
 * unknown or expired is rejected outright rather than downgraded.
 */
export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const match = BEARER.exec(header);
      if (match?.[1] === undefined) throw unauthenticated("authorization header must be 'Bearer <token>'");
      const resolution = await resolveToken(c.var.deps, match[1]);
      if (resolution.status === "unknown") throw unauthenticated("the bearer token is not valid");
      if (resolution.status === "expired") throw sessionExpired();
      c.set("session", resolution.session);
      c.set("user", resolution.user);
    }
    await next();
  };
}

/** The signed-in user and session, or a 401 problem. */
export function requireUser(c: Context<AppEnv>): { user: UserRecord; session: SessionRecord } {
  const { user, session } = c.var;
  if (user === undefined || session === undefined) throw unauthenticated("this endpoint requires a bearer token");
  return { user, session };
}
