import { isFresh } from "../adapters/driven/better-auth/fresh.ts";
import type { Doorway } from "../adapters/driving/http/handlers.ts";

/**
 * The doorway the handlers stand in: Keel's own origin, where the console's
 * pages are, and the sign-in adapter's rule for a fresh sign-in, asked of the
 * session the gate admitted the caller on. A caller with no session, an agent
 * among them, is never fresh.
 */
export function doorwayOf(host: string, now: () => Date = () => new Date()): Doorway {
  return {
    origin: `https://${host}`,
    fresh: (caller) =>
      caller.signedIn !== undefined &&
      isFresh({ signedInBy: caller.signedIn.by, createdAt: new Date(caller.signedIn.at) }, now()),
  };
}
