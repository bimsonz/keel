import { APIError } from "better-auth/api";

/**
 * Keel as an authorization server for the apps a person signs in through,
 * such as an MCP client, on the same Better Auth provider that serves agents.
 * An app is a public client (RFC 7591): it holds no secret and proves the code
 * is its own with PKCE (RFC 7636). The person signs in on Keel's own pages and
 * allows it there with a fresh passkey; its token carries the one scope
 * `person`, is for Keel's MCP server and no other door, and acts as that
 * person for as long as their consent stands.
 */

/** The scope that makes an app's token act as the person who allowed it, and as nothing else. */
export const PERSON_SCOPE = "person";

/**
 * What an app is granted: `person`, and `offline_access` so it is given a
 * refresh token (the provider gives none without it) and keeps working without
 * its person signing in again each quarter hour. Signing out of Keel's pages
 * leaves it working; withdrawing the consent ends it.
 */
export const APP_SCOPES = [PERSON_SCOPE, "offline_access"] as const;

/** How long an app's token lasts. Its consent is read on every request, so a revoked app stops at once. */
export const PERSON_TOKEN_SECONDS = 15 * 60;

/** How long an app may go on refreshing its token unused before its person signs in through it again. */
export const PERSON_REFRESH_SECONDS = 30 * 24 * 60 * 60;

/** The most callbacks one app may register. */
const REDIRECTS_MAX = 5;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the code may be sent to `uri`: `https` to another machine, or `http`
 * to this one (RFC 8252 §7.3, where a native app listens), and never with a
 * fragment or credentials in it.
 */
export function appRedirectAllowed(uri: string): boolean {
  const url = URL.parse(uri);
  if (url === null || url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return !LOOPBACK.has(url.hostname);
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/** A native app listens on this machine (RFC 8252); one whose callbacks are all https elsewhere is a web app. */
const applicationType = (uris: readonly string[]): "native" | "web" =>
  uris.some((uri) => URL.parse(uri)?.protocol === "http:") ? "native" : "web";

/** An app's registration as Keel takes it: where the code goes, and a name for people to read. */
export interface AppRequest {
  readonly redirect_uris: readonly string[];
  readonly client_name?: string | undefined;
}

/** An app Keel registered, in registration's own shape (RFC 7591 §3.2.1). */
export interface AppRegistered {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly redirect_uris: string[];
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: ("authorization_code" | "refresh_token")[];
  readonly response_types: "code"[];
  readonly client_name: string;
  readonly scope: string;
  readonly kind: "app";
}

/** A registration refused, in registration's own code (RFC 7591 §3.2.2). */
export interface AppRefused {
  readonly refused: "invalid_redirect_uri" | "invalid_client_metadata";
  readonly detail: string;
}

/** What the provider's registration route is, found by name: its plugin is handed to Better Auth untyped. */
type Register = (input: { body: Record<string, unknown> }) => Promise<unknown>;

function registerRoute(api: object): Register {
  const route: unknown = Reflect.get(api, "registerOAuthClient");
  if (typeof route !== "function") throw new Error("the OAuth provider is not mounted");
  return (input) => Promise.resolve(Reflect.apply(route, api, [input]));
}

const text = (value: unknown, name: string): string | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "string" && member !== "" ? member : undefined;
};

/**
 * Registers an app as a public client of the provider. Whatever else the
 * request asks, Keel registers it for the code grant with PKCE, refreshes, and
 * the scopes `person offline_access`: an app is never given an agent's scopes, a secret, or
 * another way in. Each callback must be one `appRedirectAllowed` takes.
 *
 * Better Auth is made (`api`) only once the request is one Keel registers:
 * made and left unawaited by a request that ends on a refusal, its
 * initialisation is dropped with that request and every later one on the
 * isolate waits for it.
 */
export async function registerApp(
  api: () => object,
  request: AppRequest,
  now: () => Date = () => new Date(),
): Promise<AppRegistered | AppRefused> {
  const uris = [...new Set(request.redirect_uris)];
  if (uris.length === 0 || uris.length > REDIRECTS_MAX)
    return {
      refused: "invalid_redirect_uri",
      detail: `An app names between one and ${REDIRECTS_MAX} redirect_uris.`,
    };
  const refused = uris.find((uri) => !appRedirectAllowed(uri));
  if (refused !== undefined)
    return {
      refused: "invalid_redirect_uri",
      detail: `${refused} is no callback Keel sends a code to: it takes https to another machine, or http to this one (localhost, 127.0.0.1 or [::1]), with no fragment.`,
    };
  const name = request.client_name?.trim();
  let registered: unknown;
  try {
    registered = await registerRoute(api())({
      body: {
        redirect_uris: uris,
        application_type: applicationType(uris),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: APP_SCOPES.join(" "),
        ...(name === undefined || name === "" ? {} : { client_name: name }),
      },
    });
  } catch (error) {
    // The provider's own refusal of the metadata is the app's to read, in registration's own codes.
    if (!(error instanceof APIError) || error.statusCode !== 400) throw error;
    const said: unknown = error.body;
    return {
      refused:
        text(said, "error") === "invalid_redirect_uri"
          ? "invalid_redirect_uri"
          : "invalid_client_metadata",
      detail: text(said, "error_description") ?? "Keel cannot register this app.",
    };
  }
  const clientId = text(registered, "client_id");
  if (clientId === undefined) throw new Error("the provider registered an app and named no client");
  const issued: unknown = Reflect.get(Object(registered), "client_id_issued_at");
  return {
    client_id: clientId,
    client_id_issued_at: typeof issued === "number" ? issued : Math.floor(now().getTime() / 1000),
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: name === undefined || name === "" ? clientId : name,
    scope: APP_SCOPES.join(" "),
    kind: "app",
  };
}

/** A refusal in OAuth's own shape, which the provider answers as it stands. */
const refuse = (error: string, description: string) =>
  new APIError("BAD_REQUEST", { error, error_description: description });

/**
 * An authorization request as Keel lets it through to the provider: for the
 * app's scopes alone, whatever it asked (RFC 6749 §3.3 lets the server grant
 * less), and for Keel's MCP server, named or not. A request for another of
 * Keel's resources is refused: an app's token acts at the MCP server only.
 */
export function appAuthorization(
  query: Record<string, unknown>,
  mcp: string,
): Record<string, unknown> {
  const resource: unknown = query["resource"];
  if (resource !== undefined && resource !== mcp)
    throw refuse(
      "invalid_target",
      `An app signs a person in for ${mcp}, Keel's MCP server, and for nothing else.`,
    );
  return { ...query, scope: APP_SCOPES.join(" "), resource: mcp };
}

/**
 * A token request of an app's, as Keel lets it through: for Keel's MCP server,
 * named or not. A request that names another resource is refused, so no app
 * holds a token for Keel's API.
 */
export function appTokenRequest(
  body: Record<string, unknown>,
  mcp: string,
): Record<string, unknown> {
  const resource: unknown = body["resource"];
  if (resource !== undefined && resource !== mcp)
    throw refuse(
      "invalid_target",
      `An app's token is for ${mcp}, Keel's MCP server, and for nothing else.`,
    );
  return { ...body, resource: mcp };
}

/** Whether a token request is an app's: the code grant, or a refresh of a token it gave. */
export const isAppGrant = (body: unknown): boolean => {
  const grant = text(body, "grant_type");
  return grant === "authorization_code" || grant === "refresh_token";
};

/**
 * Whether the person still allows the app: their consent to it, for the scope
 * `person`, stands. It is read on every request an app's token makes, so a
 * revoked app is refused at once, not when its token runs out.
 */
export async function appAllowed(
  db: D1Database,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT "scopes" FROM "oauthConsent" WHERE "clientId" = ?1 AND "userId" = ?2`)
    .bind(clientId, userId)
    .first<{ scopes: string | null }>();
  return scopesHold(row?.scopes ?? null, PERSON_SCOPE);
}

/** Whether a consent's stored scopes (a JSON array, or the provider's space-separated text) hold `scope`. */
function scopesHold(stored: string | null, scope: string): boolean {
  if (stored === null) return false;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed.includes(scope);
  } catch {
    // Not JSON: the provider keeps them as text.
  }
  return stored.split(/[\s,]+/).includes(scope);
}

/**
 * Ends what an app holds for a person whose consent to it is being withdrawn:
 * every refresh token and stored access token it was given for them, so it
 * cannot come back on a token it kept. The consent itself the provider deletes.
 * A consent that is not this person's ends nothing: the provider refuses it.
 */
export async function forgetAppTokens(
  db: D1Database,
  consentId: string,
  userId: string,
): Promise<void> {
  const consent = await db
    .prepare(`SELECT "clientId" FROM "oauthConsent" WHERE "id" = ?1 AND "userId" = ?2`)
    .bind(consentId, userId)
    .first<{ clientId: string }>();
  if (consent === null) return;
  await db.batch([
    db
      .prepare(`DELETE FROM "oauthAccessToken" WHERE "clientId" = ?1 AND "userId" = ?2`)
      .bind(consent.clientId, userId),
    db
      .prepare(`DELETE FROM "oauthRefreshToken" WHERE "clientId" = ?1 AND "userId" = ?2`)
      .bind(consent.clientId, userId),
  ]);
}
