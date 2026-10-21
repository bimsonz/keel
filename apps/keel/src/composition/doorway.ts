import {
  isFresh,
  isFreshForApproval,
  type SignedIn,
} from "../adapters/driven/better-auth/fresh.ts";
import { provenKey } from "../adapters/driven/better-auth/key-proofs.ts";
import type { Doorway } from "../adapters/driving/http/handlers.ts";

/**
 * The doorway the handlers stand in: Keel's own origin, where the console's
 * pages are, the sign-in adapter's rules for a fresh sign-in, asked of the
 * session the gate admitted the caller on, and the identity adapter's check of
 * the key a sign-up registers, and its registration of an app a person signs
 * in through. A caller with no session, an agent among them, is never fresh. A
 * move that takes a device sign-in approved with a passkey (`{ device: true }`)
 * asks the rule for an agent's standing.
 */
export function doorwayOf(
  host: string,
  registerApp: Doorway["registerApp"],
  now: () => Date = () => new Date(),
): Doorway {
  return {
    registerApp,
    origin: `https://${host}`,
    fresh: (caller, also) => {
      if (caller.signedIn === undefined) return false;
      const { by, at, passkeyAt } = caller.signedIn;
      const session: SignedIn = {
        signedInBy: by,
        createdAt: new Date(at),
        passkeyAt: typeof passkeyAt === "number" ? new Date(passkeyAt) : null,
      };
      return also?.device === true ? isFreshForApproval(session, now()) : isFresh(session, now());
    },
    provenKey,
  };
}
