import type { AppEnv, RouteDeps } from "../../../generated/http/runtime.gen.ts";
import type { Admitted } from "@keeltown/core/application/identity";
import type { Caller } from "./caller.ts";
import type { Gated } from "./gate.ts";
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

/** The gate, bound to its dependencies: an admitted caller, or the response that refuses it. */
export type BoundGate = (request: Request, requestId: string) => Promise<Gated | Response>;

const ADMITTED = new WeakMap<Request, Admitted>();

/**
 * How the generated routes reach the app: the gate every operation passes, the
 * caller each handler receives, and the responses for requests that never
 * reach a handler. The document's security requirements describe who may call
 * an operation; they decide nothing here. One policy, `authorizeHandlers`,
 * decides every operation for every principal the gate admits.
 */
export function routeDeps(gate: BoundGate): RouteDeps<AppEnv, Caller> {
  return {
    authorize: () => async (c, next) => {
      const gated = await gate(c.req.raw, c.get("requestId"));
      if (gated instanceof Response) return gated;
      ADMITTED.set(c.req.raw, gated.admitted);
      await next();
      c.res.headers.append("server-timing", gated.timing);
      return undefined;
    },
    context: (c) => {
      const admitted = ADMITTED.get(c.req.raw) ?? { principal: { _tag: "Anonymous" } };
      return {
        requestId: c.get("requestId"),
        principal: admitted.principal,
        ...(admitted.token === undefined ? {} : { token: admitted.token }),
        ...(admitted.signedIn === undefined ? {} : { signedIn: admitted.signedIn }),
        signal: c.req.raw.signal,
      };
    },
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
