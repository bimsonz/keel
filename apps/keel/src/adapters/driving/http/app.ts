import { openApiDocument } from "@keeltown/contracts";
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
import type { Handlers } from "./handlers.ts";
import { type InboxStreams, registerInboxStreams } from "./inbox-streams.ts";
import { problemResponse } from "./problems.ts";
import { type BoundGate, routeDeps } from "./route-deps.ts";
import { registerSigners } from "./signers.ts";

export interface AppOptions {
  readonly handlers: Handlers;
  /** Who is calling: every /v1 operation passes it, and `authorizeHandlers` decides on what it admits. */
  readonly gate: BoundGate;
  readonly mcp: (request: Request) => Promise<Response>;
  /** Users, sessions, orgs and the device grant (Better Auth), at `/v1/auth/*`. */
  readonly auth: AuthMount;
  /** The token endpoint's limiter: whether this key may exchange again now (the Workers Rate Limiting binding). */
  readonly tokens: { readonly admit: (key: string) => Promise<boolean> };
  /** The agent's live inbox: SSE and WebSocket, outside the spec until the emitter upgrade. */
  readonly streams: InboxStreams;
  /** Keel's allowed-signers file, as it reads now: the keys its commits verify against. */
  readonly signers: () => string;
  /** Tests rethrow contract drift so it fails loudly; production logs it and answers 500. */
  readonly rethrowContractDrift: boolean;
}

/** The OpenAPI document, under /v1 so keel.town routes it to Keel ahead of the console. */
export const DOCUMENT_PATH = "/v1/openapi.json";

/** The spec's `Auth_exchangeToken`: open to anyone, so each address is limited ahead of it. */
const TOKEN_PATH = "/v1/oauth/token";

/** The limiter's window (`TOKEN_LIMIT`'s period in wrangler.jsonc): the longest a refused address waits. */
const TOKEN_WINDOW_SECONDS = 60;

/** The HTTP doorway: middleware, the generated routes, the agent's inbox streams, the MCP endpoint, Better Auth, the document and the signers file. */
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
  // By address alone: a key that named the client would let anyone lock an agent out with its public client id.
  app.use(TOKEN_PATH, async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (await options.tokens.admit(`token:${ip}`)) return next();
    const refused = problemResponse(429, "rate.limited", c.get("requestId"), {
      detail: "Too many token requests from this address; wait a minute.",
      retryAfterMs: TOKEN_WINDOW_SECONDS * 1000,
    });
    refused.headers.set("retry-after", String(TOKEN_WINDOW_SECONDS));
    return refused;
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "keel" }));
  app.get(DOCUMENT_PATH, (c) => c.json(openApiDocument));
  registerSigners(app, options.signers);
  app.all("/mcp", (c) => options.mcp(c.req.raw));
  const deps = routeDeps(options.gate);
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

  const routed = registerRoutes(app, () => options.handlers, deps);
  // After the spec's routes, so one under /v1/auth (SignIn_methods) answers before Better Auth's catch-all.
  registerAuth(routed, options.auth);
  return routed;
}
