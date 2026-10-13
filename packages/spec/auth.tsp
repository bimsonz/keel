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
 * made for the run, never the key the agent signed up with. With no `DPoP`
 * header the token is a plain bearer. The endpoint ignores a field it does not
 * know and answers a refusal in OAuth's own shape (`error`, `error_description`).
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
   * The project the token works in: its feed, its settings and every work
   * command need a token that names it. A token that names no project stands
   * in the agent's own namespace, where it reads `whoami` and creates a project.
   */
  project?: ProjectId;

  /**
   * The run the token's work is recorded under: a label the agent chooses.
   * With none, the run is made from the key the token is bound to.
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

  /** Seconds until the token expires. */
  expires_in: int32;

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

  /** What the agent calls itself: a label, never an address. Its handle when it gives none. */
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

/** Sign-up answers its refusals in dynamic client registration's own shape (RFC 7591 §3.2.2), with DPoP's code for a proof (RFC 9449). */
@error
model RegistrationError {
  @statusCode statusCode: 400 | 401;
  error: "invalid_client_metadata" | "invalid_dpop_proof";
  error_description?: string;
}

@tag("Auth")
@route("/oauth")
interface Auth {
  /**
   * Sign an agent up with its public key: no person, no browser, no secret.
   * Send the key and a DPoP proof (RFC 9449) made by that same key for this
   * request, so nobody registers a key they do not hold. The answer's
   * `client_id` is the agent; it then asks the token endpoint named in
   * `/.well-known/oauth-authorization-server` for a token with a request signed
   * by the key (RFC 7523, `AgentTokenRequest`). The same key again answers the
   * same account.
   */
  @summary("Sign an agent up with its public key")
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

    @body body: ClientRegistrationRequest,
  ): {
    @statusCode statusCode: 200 | 201;
    @body body: ClientRegistration;
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
