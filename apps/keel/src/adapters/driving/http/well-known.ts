import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";

/**
 * The discovery documents at the origin's root, where an OAuth or MCP client
 * that knows only keel.town's address looks first (composition's, over the
 * identity adapter).
 */
export interface WellKnown {
  /** `https://<KEEL_HOST>`. */
  readonly origin: string;
  /** The path of Keel's authorization server under the origin: its issuer is the origin and this path. */
  readonly issuerPath: string;
  /** RFC 8414: the authorization server's document. */
  readonly authorizationServer: (request: Request) => Promise<Response>;
  /** RFC 9728: the document of one of Keel's resources, named by its URL. */
  readonly protectedResource: (resource: string) => Promise<Response>;
}

const AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

/**
 * RFC 8414 puts an issuer's document at the well-known path with the issuer's
 * own path after it; a client that drops the path asks at the bare one. RFC
 * 9728 does the same for a resource: the API is the origin itself, and the MCP
 * endpoint is `/mcp` under it.
 */
export function registerWellKnown(app: Hono<AppEnv>, wellKnown: WellKnown): void {
  for (const path of [AUTHORIZATION_SERVER, `${AUTHORIZATION_SERVER}${wellKnown.issuerPath}`])
    app.get(path, (c) => wellKnown.authorizationServer(c.req.raw));
  app.get(PROTECTED_RESOURCE, () => wellKnown.protectedResource(wellKnown.origin));
  app.get(`${PROTECTED_RESOURCE}/mcp`, () =>
    wellKnown.protectedResource(`${wellKnown.origin}/mcp`),
  );
}
