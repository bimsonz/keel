import { openApiDocument, OPENAPI_DOCUMENT_PATH } from "@keeltown/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { registerRoutes } from "../../../generated/http/app.gen.ts";
import {
  type AppEnv,
  ResponseContractError,
  UndeclaredStatusError,
} from "../../../generated/http/runtime.gen.ts";
import { type AuthMount, registerAuth } from "./auth-mount.ts";
import type { TokenVerifier } from "./caller.ts";
import type { Handlers } from "./handlers.ts";
import { type InboxStreams, registerInboxStreams } from "./inbox-streams.ts";
import { problemResponse } from "./problems.ts";
import { routeDeps } from "./route-deps.ts";

export interface AppOptions {
  readonly handlers: Handlers;
  readonly verify: TokenVerifier;
  readonly mcp: (request: Request) => Promise<Response>;
  /** Users, sessions, orgs and the device grant (Better Auth), at `/v1/auth/*`. */
  readonly auth: AuthMount;
  /** The agent's live inbox: SSE and WebSocket, outside the spec until the emitter upgrade. */
  readonly streams: InboxStreams;
  /** Tests rethrow contract drift so it fails loudly; production logs it and answers 500. */
  readonly rethrowContractDrift: boolean;
}

/** The HTTP doorway: middleware, the generated routes, the agent's inbox streams, the MCP endpoint, Better Auth and the document. */
export function makeApp(options: AppOptions) {
  const app = new Hono<AppEnv>();

  // Middleware first: Hono applies it only to routes registered after it.
  app.use(requestId());
  app.use(secureHeaders());
  app.use(
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        problemResponse(413, "request.invalid", c.get("requestId"), {
          detail: "The body exceeds 1 MiB.",
        }),
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, service: "keel" }));
  app.get(OPENAPI_DOCUMENT_PATH, (c) => c.json(openApiDocument));
  app.all("/mcp", (c) => options.mcp(c.req.raw));
  registerAuth(app, options.auth);
  const deps = routeDeps(options.verify);
  registerInboxStreams(app, deps, options.streams);

  app.notFound((c) => problemResponse(404, "resource.not_found", c.get("requestId")));
  app.onError((error, c) => {
    if (error instanceof ResponseContractError || error instanceof UndeclaredStatusError) {
      console.error("contract drift", error);
      if (options.rethrowContractDrift) throw error;
    } else {
      console.error("defect", error);
    }
    return problemResponse(500, "internal.defect", c.get("requestId") ?? crypto.randomUUID());
  });

  return registerRoutes(app, () => options.handlers, deps);
}
