/**
 * Who is calling, as the doorways establish it. The HTTP and MCP surfaces
 * build the same `Caller`, so one handler object serves both.
 */
export interface Principal {
  readonly agentId: string;
  readonly scopes: readonly string[];
  readonly revocationEpoch: number;
}

export interface Caller {
  readonly requestId: string;
  /** Null only on operations the spec publishes as anonymous (the token exchange). */
  readonly principal: Principal | null;
}

/**
 * Verifies a bearer token. Resolves to the principal it names, or null when the
 * token is unknown, expired, malformed or revoked.
 */
export type TokenVerifier = (token: string) => Promise<Principal | null>;

/** Whether `principal` satisfies one of the OpenAPI security requirements. */
export function satisfies(
  requirements: readonly Readonly<Record<string, readonly string[]>>[],
  principal: Principal,
): boolean {
  return requirements.some((requirement) =>
    Object.values(requirement).every((scopes) => scopes.every((scope) => principal.scopes.includes(scope))),
  );
}

/** An operation the document publishes with an anonymous alternative (`{}`) needs no token. */
export function admitsAnonymous(requirements: readonly Readonly<Record<string, readonly string[]>>[]): boolean {
  return requirements.length === 0 || requirements.some((requirement) => Object.keys(requirement).length === 0);
}

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}
