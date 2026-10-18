import { openApiDocument } from "@keeltown/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { registerRoutes } from "../../../generated/http/app.gen.ts";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";
import { type AuthMount, registerAuth } from "./auth-mount.ts";
import { type GitClone, registerGitClone } from "./git-clone.ts";
import { type Handlers, REGISTER_PATH } from "./handlers.ts";
import { type InboxStreams, registerInboxStreams } from "./inbox-streams.ts";
import { problemResponse } from "./problems.ts";
import { type BoundGate, routeDeps } from "./route-deps.ts";
import { answerUnhandled, type DatabaseAway, logRefusals } from "./run.ts";
import { registerSigners } from "./signers.ts";
import { registerWellKnown, type WellKnown } from "./well-known.ts";
import { registerFrontDoor } from "./front-door.ts";
import { limitedExchange, type TokenLimits } from "./token-limits.ts";

export interface AppOptions {
  readonly handlers: Handlers;
  /** Who is calling: every /v1 operation passes it, and `authorizeHandlers` decides on what it admits. */
  readonly gate: BoundGate;
  readonly mcp: (request: Request) => Promise<Response>;
  /** Users, sessions, orgs and the device grant (Better Auth), at `/v1/auth/*`. */
  readonly auth: AuthMount;
  /** The token limits, on the token endpoint as on the agents' exchange under `/v1/auth`. */
  readonly tokens: TokenLimits;
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
  /** Whether what a request died of is the database being away for a moment: answered 503 with a wait, never 500. */
  readonly databaseAway: DatabaseAway;
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
  app.use(logRefusals);
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
  // An agent is counted by the token it was issued, an address by its failures (token-limits.ts).
  app.use(TOKEN_PATH, async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    let handled = false;
    const answer = await limitedExchange(ip, c.get("requestId"), options.tokens, async () => {
      await next();
      handled = true;
      return c.res;
    });
    if (!handled) return answer;
    if (answer === c.res) return undefined;
    // Cleared first, so the answer replacing it keeps none of the dropped answer's headers.
    c.res = undefined;
    c.res = answer;
    return undefined;
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
    answerUnhandled(
      error,
      c.get("requestId") ?? crypto.randomUUID(),
      options.rethrowContractDrift,
      options.databaseAway,
    ),
  );

  const routed = registerRoutes(app, () => options.handlers, deps);
  // After the spec's routes, so one under /v1/auth (SignIn_methods) answers before Better Auth's catch-all.
  registerAuth(routed, options.auth);
  return routed;
}
