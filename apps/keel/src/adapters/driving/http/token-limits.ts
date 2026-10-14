import { problemResponse } from "./problems.ts";

/** How long a refused agent or address waits: the limiters' own window (their period in wrangler.jsonc). */
export const TOKEN_WINDOW_SECONDS = 60;

/** The addresses refused token exchanges for the rest of a window, read before the provider is asked. */
export interface TokenBlocks {
  readonly has: (address: string) => Promise<boolean>;
  readonly add: (address: string, seconds: number) => Promise<void>;
}

/**
 * The limits on a token exchange. An agent is counted by the token Keel has
 * just issued it, never by the client its request names: a client id is
 * public, and a count it chose would let anyone spend an agent's allowance.
 * An address is counted only for the exchanges that fail, since a forged or
 * refused credential is what costs Keel a lookup and a signature check; past
 * that limit the address is refused before the provider for the rest of the
 * window. Honest traffic from one address is never held to a number.
 */
export interface TokenLimits {
  /** Counts one token issued to `agent`: false once the agent is past its limit. */
  readonly issued: (agent: string) => Promise<boolean>;
  /** Counts one failed exchange from `address`: false once the address is past the failure limit. */
  readonly failed: (address: string) => Promise<boolean>;
  readonly blocks: TokenBlocks;
}

/** The agent a token was issued to: its `sub`, read from a token Keel has just signed, so not verified again. */
export function issuedTo(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    const sub: unknown = Reflect.get(Object(claims), "sub");
    return typeof sub === "string" ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The answer's access token, if it is a token answer. */
async function accessTokenOf(answer: Response): Promise<string | undefined> {
  try {
    const body: unknown = await answer.clone().json();
    const token: unknown = Reflect.get(Object(body), "access_token");
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

const refused = (requestId: string, detail: string): Response => {
  const answer = problemResponse(429, "rate.limited", requestId, {
    detail,
    retryAfterMs: TOKEN_WINDOW_SECONDS * 1000,
  });
  answer.headers.set("retry-after", String(TOKEN_WINDOW_SECONDS));
  return answer;
};

/** A credential the provider refused: what an address is counted for. A 5xx is Keel's own, never the caller's. */
const isRefusal = (status: number) => status === 400 || status === 401 || status === 403;

/**
 * One token exchange under `limits`. A blocked address is refused before the
 * provider is asked. A token issued past its agent's limit is dropped, and
 * nothing else is spent: the only grant served here issues an access token
 * and rotates nothing. A refusal counts against the address that sent it.
 */
export async function limitedExchange(
  address: string,
  requestId: string,
  limits: TokenLimits,
  exchange: () => Promise<Response>,
): Promise<Response> {
  if (await limits.blocks.has(address))
    return refused(requestId, "Too many failed token requests from this address; wait a minute.");
  const answer = await exchange();
  if (answer.status === 200) {
    const token = await accessTokenOf(answer);
    const agent = token === undefined ? undefined : issuedTo(token);
    if (agent !== undefined && !(await limits.issued(`token:agent:${agent}`)))
      return refused(requestId, "Too many token requests for this agent; wait a minute.");
    return answer;
  }
  if (isRefusal(answer.status) && !(await limits.failed(`token-failed:${address}`)))
    await limits.blocks.add(address, TOKEN_WINDOW_SECONDS);
  return answer;
}
