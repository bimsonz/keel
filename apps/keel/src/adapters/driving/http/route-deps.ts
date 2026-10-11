import type { AppEnv, RouteDeps } from "../../../generated/http/runtime.gen.ts";
import {
  admitsAnonymous,
  bearerToken,
  type Caller,
  namesScheme,
  satisfies,
  type TokenVerifier,
} from "./caller.ts";
import { type ProblemBody, problemResponse } from "./problems.ts";

type Issues = NonNullable<ProblemBody["issues"]>;

/** Reads zod's issues off a failed validation without importing zod (rule R6). */
function issuesOf(result: { readonly success: boolean }): Issues {
  if (!("error" in result)) return [];
  const error: unknown = result.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("issues" in error) ||
    !Array.isArray(error.issues)
  )
    return [];
  return error.issues.flatMap((issue: unknown) => {
    if (
      typeof issue !== "object" ||
      issue === null ||
      !("message" in issue) ||
      typeof issue.message !== "string"
    )
      return [];
    const path = "path" in issue && Array.isArray(issue.path) ? issue.path : [];
    return [
      {
        path: path.filter(
          (p: unknown): p is string | number => typeof p === "string" || typeof p === "number",
        ),
        message: issue.message,
      },
    ];
  });
}

/**
 * How the generated routes reach the app: the auth gate the document publishes,
 * the caller each handler receives, and the responses for requests that never
 * reach a handler.
 */
export function routeDeps(verify: TokenVerifier): RouteDeps<AppEnv, Caller> {
  return {
    authorize: (requirements) => async (c, next) => {
      const header = c.req.header("authorization");
      // An optional route (anonymous beside a real scheme) still reads a presented
      // credential, so a token's own access applies; a bad one is refused, never
      // read as anonymous. A route with no real scheme ignores it.
      if (admitsAnonymous(requirements) && (header === undefined || !namesScheme(requirements)))
        return next();
      const requestId = c.get("requestId");
      const token = bearerToken(header);
      const verification = token === null ? ({ refused: "invalid" } as const) : await verify(token);
      if ("refused" in verification) {
        return verification.refused === "revoked"
          ? problemResponse(401, "auth.revoked", requestId, {
              nextActions: [{ kind: "escalate", title: "Ask an operator to reinstate the agent" }],
            })
          : problemResponse(401, "auth.invalid_token", requestId, {
              nextActions: [
                {
                  kind: "call",
                  title: "Exchange your client credentials for a token",
                  operationId: "Auth_exchangeToken",
                },
              ],
            });
      }
      const { principal } = verification;
      if (!satisfies(requirements, principal)) {
        return problemResponse(403, "auth.insufficient_scope", requestId, {
          detail: `This operation requires one of: ${requirements.map((r) => Object.values(r).flat().join(" + ")).join(", ")}.`,
        });
      }
      c.set("principal", principal);
      return next();
    },
    context: (c) => ({
      requestId: c.get("requestId"),
      principal: c.get("principal") ?? null,
      signal: c.req.raw.signal,
    }),
    noContext: (c) => problemResponse(401, "auth.invalid_token", c.get("requestId")),
    notAcceptable: (c, offered) =>
      problemResponse(406, "request.invalid", c.get("requestId"), {
        detail: `Acceptable media types: ${offered.join(", ")}`,
      }),
    invalid: (result, c) =>
      result.success
        ? undefined
        : problemResponse(400, "request.invalid", c.get("requestId"), { issues: issuesOf(result) }),
  };
}
