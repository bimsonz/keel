import type { SignedIn } from "@keeltown/core/application/identity";
import type {
  AgentClaims,
  AgentToken,
  Audience,
  Principal,
  Resource,
} from "@keeltown/core/domain/identity";

export type { AgentClaims, AgentToken };

/**
 * Who is calling, as the gate establishes it. The HTTP and MCP surfaces build
 * the same `Caller`, so one handler object serves both.
 */
export interface Caller {
  readonly requestId: string;
  /** Who is asking: a user, an agent, or anonymous. */
  readonly principal: Principal;
  /** The claims of the token an agent presented. One that names a project is what the work use-cases take. */
  readonly token?: AgentClaims;
  /** How and when a user's session was signed in: what an operation that wants a fresh sign-in asks. */
  readonly signedIn?: SignedIn;
  /** Who a granted read sees as: set by `authorizeHandlers` on reads. */
  readonly audience?: Audience;
  /** What the call was decided on, as `authorizeHandlers` resolved it: its handler reads the project from here. */
  readonly resource?: Resource;
  /** Aborted when the client goes away; the use-case's fiber is interrupted with it. */
  readonly signal: AbortSignal;
}

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
}

/**
 * The token an `Authorization` header carries and the scheme it is presented
 * under: `Bearer`, or `DPoP` for a token bound to a key (RFC 9449 §7.1).
 */
export function presentedToken(
  header: string,
): { readonly scheme: "Bearer" | "DPoP"; readonly token: string } | null {
  const found = /^(Bearer|DPoP)\s+(\S+)$/i.exec(header);
  if (found?.[1] === undefined || found[2] === undefined) return null;
  return { scheme: found[1].toLowerCase() === "dpop" ? "DPoP" : "Bearer", token: found[2] };
}
