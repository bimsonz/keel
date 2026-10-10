import type { Principal } from "@keeltown/core/domain/identity";

export type { Principal };

/**
 * Who is calling, as the doorways establish it. The HTTP and MCP surfaces
 * build the same `Caller`, so one handler object serves both.
 */
export interface Caller {
  readonly requestId: string;
  /** Null only on operations the spec publishes as anonymous (the token exchange). */
  readonly principal: Principal | null;
  /** Aborted when the client goes away; the use-case's fiber is interrupted with it. */
  readonly signal: AbortSignal;
}

/** The outcome of verifying a bearer token. */
export type Verification =
  | { readonly principal: Principal }
  | { readonly refused: "invalid" | "revoked" };

/** Verifies a bearer token: its signature and expiry, then that its agent may still act at that epoch. */
export type TokenVerifier = (token: string) => Promise<Verification>;

/** Whether `principal` satisfies one of the OpenAPI security requirements. */
export function satisfies(
  requirements: readonly Readonly<Record<string, readonly string[]>>[],
  principal: Principal,
): boolean {
  return requirements.some((requirement) =>
    Object.values(requirement).every((scopes) =>
      scopes.every((scope) => principal.scopes.some((held) => held === scope)),
    ),
  );
}

/** An operation the document publishes with an anonymous alternative (`{}`) needs no token. */
export function admitsAnonymous(
  requirements: readonly Readonly<Record<string, readonly string[]>>[],
): boolean {
  return (
    requirements.length === 0 ||
    requirements.some((requirement) => Object.keys(requirement).length === 0)
  );
}

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
}
