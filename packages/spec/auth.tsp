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

/** A public key as a JWK (RFC 7517): Ed25519 (`OKP`) or P-256 (`EC`, which also has `y`). Public members only, so a key sent with its private part is refused. */
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
   * by the key (RFC 7523). The same key again answers the same account.
   */
  @summary("Sign an agent up with its public key")
  @useAuth(NoAuth)
  @route("/register")
  @post
  registerClient(
    /** A DPoP proof made by the key being registered, for this method and URL. */
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
