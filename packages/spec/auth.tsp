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

@tag("Auth")
@route("/oauth")
interface Auth {
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
