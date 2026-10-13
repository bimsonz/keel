import { openApiDocument } from "@keeltown/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { registerRoutes } from "../../../generated/http/app.gen.ts";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";
import { type AuthMount, registerAuth, TOKEN_WINDOW_SECONDS } from "./auth-mount.ts";
import { type GitClone, registerGitClone } from "./git-clone.ts";
import { type Handlers, REGISTER_PATH } from "./handlers.ts";
import { type InboxStreams, registerInboxStreams } from "./inbox-streams.ts";
import { problemResponse } from "./problems.ts";
import { type BoundGate, routeDeps } from "./route-deps.ts";
import { answerUnhandled } from "./run.ts";
import { registerSigners } from "./signers.ts";
import { registerWellKnown, type WellKnown } from "./well-known.ts";
import { registerFrontDoor } from "./front-door.ts";

export interface AppOptions {
  readonly handlers: Handlers;
  /** Who is calling: every /v1 operation passes it, and `authorizeHandlers` decides on what it admits. */
  readonly gate: BoundGate;
  readonly mcp: (request: Request) => Promise<Response>;
  /** Users, sessions, orgs and the device grant (Better Auth), at `/v1/auth/*`. */
  readonly auth: AuthMount;
  /** The token endpoint's limiter: whether this key may exchange again now (the Workers Rate Limiting binding). */
  readonly tokens: { readonly admit: (key: string) => Promise<boolean> };
  /** The discovery documents at the origin's root (RFC 8414, RFC 9728). */
  readonly wellKnown: WellKnown;
  /** The agent's live inbox: SSE and WebSocket, outside the spec until the emitter upgrade. */
  readonly streams: InboxStreams;
  /** Keel's allowed-signers file, as it reads now: the keys its commits verify against. */
  readonly signers: () => string;
  /** The clone URL, `/<namespace>/<project>.git`: who may fetch a project, and its host's answer. */
  readonly git: GitClone;
  /** Tests rethrow contract drift so it fails loudly; production logs it and answers 500. */
  readonly rethrowContractDrift: boolean;
}

/** The OpenAPI document, under /v1 so keel.town routes it to Keel ahead of the console. */
export const DOCUMENT_PATH = "/v1/openapi.json";

/** The spec's `Auth_exchangeToken`: open to anyone, so each address is limited ahead of it. */
const TOKEN_PATH = "/v1/oauth/token";

/** The HTTP doorway: middleware, the clone URL, the generated routes, the agent's inbox streams, the MCP endpoint, Better Auth, the document, the signers file and the front door. */
export function makeApp(options: AppOptions) {
  const app = new Hono<AppEnv>();

  // Middleware first: Hono applies it only to routes registered after it.
  app.use(requestId());
  app.use(secureHeaders());
  // Ahead of the 1 MiB limit: a fetch's negotiation has its own cap, and a clone URL is no /v1 operation.
  registerGitClone(app, options.git);
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

  // An agent's sign-up is counted as a person's is: by address, under the sign-in limit.
  app.use(REGISTER_PATH, async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (await options.auth.admit(`auth:${ip}`)) return next();
    return problemResponse(429, "rate.limited", c.get("requestId"), {
      detail: "Too many sign-ups from this address; wait a minute.",
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "keel" }));
  app.get(DOCUMENT_PATH, (c) => c.json(openApiDocument));
  registerSigners(app, options.signers);
  app.all("/mcp", (c) => options.mcp(c.req.raw));
  registerWellKnown(app, options.wellKnown);
  registerFrontDoor(app, options.wellKnown);
  const deps = routeDeps(options.gate);
  registerInboxStreams(app, deps, options.streams);

  app.notFound((c) => problemResponse(404, "resource.not_found", c.get("requestId")));
  app.onError((error, c) =>
    answerUnhandled(error, c.get("requestId") ?? crypto.randomUUID(), options.rethrowContractDrift),
  );

  const routed = registerRoutes(app, () => options.handlers, deps);
  // After the spec's routes, so one under /v1/auth (SignIn_methods) answers before Better Auth's catch-all.
  registerAuth(routed, options.auth);
  return routed;
}
