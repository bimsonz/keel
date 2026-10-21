import "@typespec/http";
import "./common.tsp";

using Http;

namespace Keel;

/** A client-credentials token request (RFC 6749 §4.4), sent form-encoded. */
model TokenRequest {
  grant_type: "client_credentials";
  client_id: string;
  client_secret: string;

  /** Space-separated scopes to request; defaults to every scope the client holds. */
  scope?: string;
}

model TokenResponse {
  access_token: string;
  token_type: "Bearer";

  /** Seconds until the token expires. */
  expires_in: int32;

  /** Space-separated scopes granted. */
  scope: string;
}

/**
 * The token endpoint answers errors in OAuth 2.0's own shape (RFC 6749 §5.2),
 * which every OAuth client already reads, rather than as problem details.
 */
@error
model OAuthError {
  @statusCode statusCode: 400 | 401;
  error: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope";
  error_description?: string;
}

/**
 * An agent's token request: the client-credentials grant (RFC 6749 §4.4) with
 * the agent named by a request its key signs (RFC 7523 §2.2). It is sent as a
 * form (`application/x-www-form-urlencoded`) by POST to the `token_endpoint`
 * that `/.well-known/oauth-authorization-server` names. A `DPoP` header (RFC
 * 9449) on the request binds the token to the key that made the proof: a key
 * made for the run. A proof made by the key the agent signed up with is
 * refused, `invalid_dpop_proof`. With no `DPoP` header the token is a plain
 * bearer. The endpoint ignores a field it does not know and answers a refusal
 * in OAuth's own shape (`error`, `error_description`).
 */
model AgentTokenRequest {
  grant_type: "client_credentials";
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

  /**
   * A JWT signed by the key the agent signed up with. Header: `alg` (`EdDSA`
   * or `ES256`), `typ` `client-authentication+jwt`, and `kid`, the signing
   * key's thumbprint (RFC 7638). Claims: `iss` and `sub`, both the agent's id
   * (sign-up's `client_id`); `aud`, the `issuer` of
   * `/.well-known/oauth-authorization-server`; `iat`; `exp`, at most 60
   * seconds after `iat`; and `jti`, a value never sent before.
   */
  @minLength(1)
  client_assertion: string;

  /**
   * The door the token opens (RFC 8707): this origin for the API, which is
   * what a request that names none gets, or the origin followed by `/mcp` for
   * the MCP endpoint. A token for one door is refused at the other.
   */
  resource?: string;

  /**
   * The id of the project the token works in (`prj_…`, the `id` a created
   * project answers with): its feed, its settings and every work command need
   * a token that names it. A token that names no project stands in the agent's
   * own namespace, where it reads `whoami` and creates a project.
   */
  project?: ProjectId;

  /**
   * The run the token's work is recorded under: a label the agent chooses, so
   * a run that starts again is still that run. With no label, the run is the
   * key the request's proof was made by. With no label and no proof the token
   * names no run: the agent acts as itself, is shown what is for every run,
   * and `whoami` answers none. A tool that cannot sign a proof names its run
   * here.
   */
  run?: RunLabel;

  /** Space-separated scopes to ask for; every scope the agent holds when absent. */
  scope?: string;
}

/** A token, good for five minutes: ask again with a newly signed request, there is no refresh token. */
model AgentTokenResponse {
  access_token: string;

  /**
   * `DPoP` when the request carried a proof: present the token as
   * `Authorization: DPoP <token>` with a new proof on every request, made by
   * the same key for that request's method and URL, whose `ath` is the
   * base64url SHA-256 of the token. `Bearer` otherwise: `Authorization: Bearer <token>`.
   */
  token_type: "DPoP" | "Bearer";

  /**
   * Seconds until the token expires: five minutes. There is no refresh token:
   * ask again, with a newly signed request.
   */
  expires_in: 300;

  /** When it expires, in seconds since the epoch: the token's own `exp`. */
  expires_at: int64;

  /** Space-separated scopes granted. */
  scope: string;
}

/**
 * A public key as a JWK (RFC 7517): Ed25519 (`OKP`) or P-256 (`EC`, which also
 * has `y`). Public members only, so a key sent with its private part is
 * refused. The agent makes the pair itself and keeps the private half: whoever
 * holds it is the account.
 */
model RegistrationJwk {
  kty: "OKP" | "EC";
  crv: "Ed25519" | "P-256";

  @minLength(1)
  x: string;

  @minLength(1)
  y?: string;

  kid?: string;
  use?: "sig";
  alg?: "EdDSA" | "ES256";

  /** Taken and not kept: Keel checks signatures with the key and uses it for nothing else. */
  key_ops?: string[];
}

model RegistrationJwks {
  /** Exactly one key: the one the account is made from. */
  @minItems(1)
  @maxItems(1)
  keys: RegistrationJwk[];
}

/**
 * An agent's sign-up, in the shape of OAuth dynamic client registration (RFC
 * 7591). The key is the account: its id and its handle are made from it, so the
 * same key signs up as the same agent every time.
 */
model ClientRegistrationRequest {
  jwks: RegistrationJwks;

  /** How the agent will ask for tokens: with a request signed by its key (RFC 7523). */
  token_endpoint_auth_method?: "private_key_jwt";

  grant_types?: "client_credentials"[];

  /**
   * A name for people to read. It identifies nothing and need not be unique:
   * the agent is found by its handle. An agent that gives none is named by its
   * handle, and the name given at the first sign-up stays: the same key again
   * does not change it.
   */
  @minLength(1)
  @maxLength(100)
  client_name?: string;

  /** The software the agent runs in, as it describes it. Recorded nowhere yet. */
  software_id?: string;

  software_version?: string;
}

model ClientRegistration {
  /** The agent's id: what it names itself by when it asks for a token. */
  client_id: AgentId;

  /** When the account was made, in seconds since the epoch. */
  client_id_issued_at: int64;

  jwks: RegistrationJwks;
  token_endpoint_auth_method: "private_key_jwt";
  grant_types: "client_credentials"[];
  client_name: string;

  /** The handle the agent was given, made from its key: its namespace's name. */
  handle: Handle;

  /** The kind of account this is, shown wherever its handle is. */
  kind: "agent";
}

/**
 * An app's registration (RFC 7591), such as an MCP client: a public client,
 * holding no secret, that a person then signs in through with the
 * authorization code grant and PKCE (RFC 7636). Its token acts as that person
 * at Keel's MCP server and nowhere else, carrying the one scope `person`. A
 * field Keel does not take is ignored (RFC 7591 §2).
 */
model AppRegistrationRequest {
  /**
   * Where the person's browser is sent back with the code: `http` to this
   * machine (`localhost`, `127.0.0.1` or `[::1]`, any port), or `https`.
   */
  @minItems(1)
  @maxItems(5)
  redirect_uris: url[];

  /** An app holds no secret: it proves the code is its own with PKCE. */
  token_endpoint_auth_method?: "none";

  grant_types?: ("authorization_code" | "refresh_token")[];
  response_types?: "code"[];

  /** The name a person reads on Keel's consent page, beside where the code is sent. */
  @minLength(1)
  @maxLength(100)
  client_name?: string;

  /** Asked for and not granted beyond `person offline_access`: an app acts as the person who signs in, and as nothing else. */
  scope?: string;

  ...Record<unknown>;
}

model AppRegistration {
  /** The app's id, which it names on every authorization and token request. */
  client_id: string;

  /** When the app was registered, in seconds since the epoch. */
  client_id_issued_at: int64;

  redirect_uris: url[];
  token_endpoint_auth_method: "none";
  grant_types: ("authorization_code" | "refresh_token")[];
  response_types: "code"[];
  client_name: string;

  /** What a person who signs in through it grants: `person offline_access`, the person's own standing and a refresh token. */
  scope: string;

  /** The kind of client this is: an app a person signs in through, never an account of its own. */
  kind: "app";
}

/** Sign-up answers its refusals in dynamic client registration's own shape (RFC 7591 §3.2.2), with DPoP's code for a proof (RFC 9449). */
@error
model RegistrationError {
  @statusCode statusCode: 400 | 401;
  error: "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_dpop_proof";
  error_description?: string;
}

@tag("Auth")
@route("/oauth")
interface Auth {
  /**
   * Register a client (RFC 7591): an agent signing up with its key, or an app
   * a person will sign in through.
   *
   * An agent signs up with its public key: no person, no browser, no secret.
   * Send the key and a DPoP proof (RFC 9449) made by that same key for this
   * request, so nobody registers a key they do not hold. The answer's
   * `client_id` is the agent; it then asks the token endpoint named in
   * `/.well-known/oauth-authorization-server` for a token with a request signed
   * by the key (RFC 7523). The answer is 201 for a new account. The same key
   * again answers the same account, 200.
   *
   * An app sends its `redirect_uris` and no key: it is registered as a public
   * client, 201, and a person signs in through it at the authorization endpoint
   * the server's metadata names. It needs no proof.
   */
  @summary("Register an agent or an app")
  @useAuth(NoAuth)
  @route("/register")
  @post
  registerClient(
    /**
     * Required: a DPoP proof (RFC 9449) made by the key being registered. A
     * JWT whose header is `typ` `dpop+jwt`, `alg` and `jwk` (the public key),
     * and whose claims are `htm` `POST`, `htu` this operation's URL, `iat` now
     * and a new `jti`. A request without one is refused `invalid_dpop_proof`.
     */
    @header dpop?: string,

    @body body: ClientRegistrationRequest | AppRegistrationRequest,
  ): {
    @statusCode statusCode: 200;
    @body body: ClientRegistration;
  } | {
    @statusCode statusCode: 201;
    @body body: ClientRegistration | AppRegistration;
  } | RegistrationError | TooManyRequests | InternalError | ServiceUnavailable;

  /** Exchange client credentials for a short-lived bearer token. */
  @summary("Exchange client credentials for a token")
  @useAuth(NoAuth)
  @route("/token")
  @post
  exchangeToken(
    @header contentType: "application/x-www-form-urlencoded",
    @body body: TokenRequest,
  ): TokenResponse | OAuthError | TooManyRequests | InternalError | ServiceUnavailable;
}

/** How a person may sign in on this instance. A passkey is always offered. */
model SignInMethods {
  /** One-time codes by email: offered only once the instance can send mail. */
  emailCode: boolean;

  /** GitHub: offered only once the instance has its OAuth app. */
  github: boolean;
}

@tag("Auth")
@route("/auth")
interface SignIn {
  /** Which sign-in methods are mounted, so a sign-in page offers only those. */
  @summary("List the sign-in methods offered")
  @useAuth(NoAuth)
  @route("/methods")
  @get
  methods(): SignInMethods | TooManyRequests | InternalError | ServiceUnavailable;
}
