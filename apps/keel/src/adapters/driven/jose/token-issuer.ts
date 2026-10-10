import { type Principal, Scope, TokenRejected } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { Clock, TokenIssuer } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { errors, importJWK, type JWK, jwtVerify, SignJWT } from "jose";

export interface TokenIssuerOptions {
  /** The Ed25519 private key, as a JWK (the `KEEL_SIGNING_KEY` secret). */
  readonly privateJwk: string;
  /** Who issues the token: the host Keel answers on. */
  readonly issuer: string;
}

const Claims = Schema.Struct({
  sub: AgentId,
  scope: Schema.String,
  epoch: Schema.Int,
});

const AUDIENCE = "keel";

/**
 * Bearer tokens as Ed25519-signed JWTs. Issue and verify both take the time
 * from the Clock port, so TestClock drives expiry in tests exactly as the
 * platform clock does in production.
 */
export function TokenIssuerJose(options: TokenIssuerOptions) {
  return Layer.effect(
    TokenIssuer,
    Effect.gen(function* () {
      const clock = yield* Clock;
      const jwk: JWK = JSON.parse(options.privateJwk);
      const privateKey = yield* Effect.promise(() => importJWK({ ...jwk, alg: "EdDSA" }, "EdDSA"));
      // The public half: the same key without its private scalar or its signing-only usage.
      const { d: _private, key_ops: _usage, ...publicJwk } = jwk;
      const publicKey = yield* Effect.promise(() => importJWK({ ...publicJwk, alg: "EdDSA" }, "EdDSA"));
      const kid = jwk.kid ?? "keel";

      return TokenIssuer.of({
        issue: (principal: Principal, ttlSeconds: number) =>
          Effect.gen(function* () {
            const now = yield* clock.now;
            const issuedAt = Math.floor(now / 1000);
            const expiresAt = issuedAt + ttlSeconds;
            const token = yield* Effect.promise(() =>
              new SignJWT({ scope: principal.scopes.join(" "), epoch: principal.revocationEpoch })
                .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
                .setSubject(principal.agentId)
                .setIssuer(options.issuer)
                .setAudience(AUDIENCE)
                .setIssuedAt(issuedAt)
                .setExpirationTime(expiresAt)
                .sign(privateKey),
            );
            return { token, expiresAt: Instant(expiresAt * 1000) };
          }),
        verify: (token: string) =>
          Effect.gen(function* () {
            const now = yield* clock.now;
            const verified = yield* Effect.tryPromise({
              try: () => jwtVerify(token, publicKey, { issuer: options.issuer, audience: AUDIENCE, algorithms: ["EdDSA"], currentDate: new Date(now) }),
              catch: (error) =>
                new TokenRejected({
                  reason:
                    error instanceof errors.JWTExpired
                      ? "expired"
                      : error instanceof errors.JWSSignatureVerificationFailed
                        ? "signature"
                        : error instanceof errors.JWTClaimValidationFailed
                          ? "claims"
                          : "malformed",
                }),
            });
            const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload).pipe(
              Effect.mapError(() => new TokenRejected({ reason: "claims" })),
            );
            const scopes = yield* Schema.decodeUnknownEffect(Schema.Array(Scope))(claims.scope.split(" ").filter(Boolean)).pipe(
              Effect.mapError(() => new TokenRejected({ reason: "claims" })),
            );
            return { agentId: claims.sub, scopes, revocationEpoch: claims.epoch };
          }),
      });
    }),
  );
}
