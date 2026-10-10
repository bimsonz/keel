import { Context, type Effect } from "effect";
import type { Principal, TokenRejected } from "../../domain/identity/index.ts";
import type { Instant } from "../../domain/kernel/index.ts";

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: Instant;
}

/** Mints and verifies the bearer tokens agents present (Ed25519-signed JWTs). */
export class TokenIssuer extends Context.Service<
  TokenIssuer,
  {
    readonly issue: (principal: Principal, ttlSeconds: number) => Effect.Effect<IssuedToken>;
    readonly verify: (token: string) => Effect.Effect<Principal, TokenRejected>;
  }
>()("keel/TokenIssuer") {}
