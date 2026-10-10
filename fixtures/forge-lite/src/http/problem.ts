import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * An error that maps to an RFC 9457 problem details response. Throw one from
 * any handler or middleware; the app's error handler renders it.
 */
export class Problem extends Error {
  readonly status: ContentfulStatusCode;
  readonly slug: string;
  readonly title: string;
  readonly detail: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: ContentfulStatusCode,
    slug: string,
    title: string,
    detail: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.name = "Problem";
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
    this.headers = headers;
  }

  toJSON(): { type: string; title: string; status: number; detail: string } {
    return { type: `/problems/${this.slug}`, title: this.title, status: this.status, detail: this.detail };
  }
}

const WWW_AUTHENTICATE = { "www-authenticate": 'Bearer realm="forge-lite"' };

export function malformedBody(detail: string): Problem {
  return new Problem(400, "malformed-body", "Malformed request body", detail);
}

export function validationFailed(detail: string): Problem {
  return new Problem(422, "validation-failed", "Validation failed", detail);
}

export function unauthenticated(detail: string): Problem {
  return new Problem(401, "unauthenticated", "Authentication required", detail, WWW_AUTHENTICATE);
}

export function invalidCredentials(): Problem {
  return new Problem(401, "invalid-credentials", "Invalid credentials", "username or password is incorrect");
}

export function sessionExpired(): Problem {
  return new Problem(401, "session-expired", "Session expired", "the session has expired; log in again", WWW_AUTHENTICATE);
}

export function forbidden(detail: string): Problem {
  return new Problem(403, "forbidden", "Forbidden", detail);
}

export function notFound(detail: string): Problem {
  return new Problem(404, "not-found", "Not found", detail);
}

export function conflict(slug: string, detail: string): Problem {
  return new Problem(409, slug, "Conflict", detail);
}

export function problemResponse(problem: Problem): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE, ...problem.headers },
  });
}

/**
 * The app's error handler. Problems render as themselves; anything else is a
 * bug, reported as a 500 that does not leak the error's message.
 */
export function handleError(error: Error, _c: Context): Response {
  if (error instanceof Problem) return problemResponse(error);
  if (error instanceof HTTPException) {
    const status = error.status as ContentfulStatusCode;
    return problemResponse(new Problem(status, "http-error", error.message || "HTTP error", error.message));
  }
  console.error(error);
  return problemResponse(new Problem(500, "internal", "Internal Server Error", "an unexpected error occurred"));
}
