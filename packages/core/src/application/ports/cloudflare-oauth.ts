import { Context, type Effect, type Redacted } from "effect";
import type { CloudflareConnectFailed, GrantedAccount } from "../../domain/delivery/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";

/** Where to send an owner to consent, with the nonce its state carries and the PKCE verifier its code needs. */
export interface ConsentStart {
  readonly url: string;
  readonly nonce: string;
  readonly verifier: string;
}

/**
 * Cloudflare's OAuth, as Keel's registered client asks it: the consent screen
 * an owner is sent to, the exchange of the code they come back with, the
 * accounts that consent granted, and the one API token Keel mints on the
 * account, which may only edit its Workers. The consent's own access token is
 * used for those reads and that mint alone: no store, event or log holds it.
 * Every step fails `unconfigured` while this Keel has no client registered.
 */
export class CloudflareOAuth extends Context.Service<
  CloudflareOAuth,
  {
    readonly begin: (projectId: ProjectId) => Effect.Effect<ConsentStart, CloudflareConnectFailed>;
    readonly exchange: (
      code: string,
      verifier: string,
    ) => Effect.Effect<Redacted.Redacted, CloudflareConnectFailed>;
    readonly accounts: (
      access: Redacted.Redacted,
    ) => Effect.Effect<readonly GrantedAccount[], CloudflareConnectFailed>;
    readonly mint: (
      access: Redacted.Redacted,
      accountId: string,
      name: string,
    ) => Effect.Effect<Redacted.Redacted, CloudflareConnectFailed>;
  }
>()("keel/CloudflareOAuth") {}
