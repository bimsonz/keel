/**
 * A fresh sign-in: what a session needs before it may change how its account
 * signs in (add or remove a passkey, link or unlink a provider, change the
 * address). An account has no second factor and no recovery, so a session that
 * could do this at any age would make whoever holds it the account's owner for
 * good. Only a session signed in by a passkey within the last ten minutes may.
 *
 * An account that holds no passkey has none to sign in with, so it adds its
 * first with any sign-in of its own from the last ten minutes, and nothing
 * else: every other change waits for that passkey.
 *
 * Giving an agent standing (inviting it to a namespace or a project, taking it
 * off, approving or ending a sponsorship) asks a little less: such a session,
 * or a device sign-in approved with a passkey, within ten minutes of that
 * passkey. The terminal's session carries the passkey's time from the
 * approval, and keeps saying it was signed in by the device grant, so it never
 * changes how its account signs in.
 */

/** How a session was signed in. */
export type SignInMethod = "passkey" | "email-otp" | "github" | "device" | "other";

/** How long after its passkey sign-in a session stays fresh. */
export const FRESH_FOR_MS = 600_000;

/**
 * How a session is signed in, by the path of the Better Auth endpoint making
 * it, as Better Auth names its routes: both passkey ceremonies, the email
 * code, the OAuth callback (GitHub is the only provider Keel mounts) and the
 * device grant's token endpoint. Any other endpoint's session is `other`.
 */
export function signInMethod(path: string): SignInMethod {
  switch (path) {
    case "/passkey/verify-authentication":
    case "/passkey/verify-registration":
      return "passkey";
    case "/sign-in/email-otp":
      return "email-otp";
    case "/callback/:id":
      return "github";
    case "/device/token":
      return "device";
    default:
      return "other";
  }
}

/**
 * What a session's row says of its sign-in: how, and when. A device sign-in
 * also holds `passkeyAt`, the time of the passkey its approval was made with,
 * when that approval was fresh; nothing after the approval writes it.
 */
export interface SignedIn {
  readonly signedInBy?: string | null;
  readonly createdAt: Date;
  readonly passkeyAt?: Date | null;
}

/**
 * The ways a person signs in themselves, with something only they hold: a
 * passkey, a code sent to their address, or their GitHub account. The device
 * grant is not one: any session of the account approves it, at any age, so
 * its session is only as much the person's as the one that approved it.
 */
const OWN_SIGN_INS: ReadonlySet<string> = new Set<SignInMethod>(["passkey", "email-otp", "github"]);

/** Whether the session was made within the last ten minutes. One whose time of making can't be read was not. */
const recent = (session: SignedIn, now: Date): boolean =>
  now.getTime() - session.createdAt.getTime() <= FRESH_FOR_MS;

/**
 * Whether a session may change how its account signs in at `now`. A session
 * with no method, as every one made before the method was recorded, is not
 * fresh, nor is one whose time of making can't be read.
 */
export function isFresh(session: SignedIn, now: Date): boolean {
  if (session.signedInBy !== "passkey") return false;
  return recent(session, now);
}

/**
 * The passkey a session's standing for agents rests on at `now`: a fresh
 * passkey sign-in's own time, or a device sign-in's `passkeyAt` while that is
 * within ten minutes. None for any other session. A device code approved by
 * this session is given this time, so the clock is passed on and never reset.
 */
export function approvalPasskeyAt(session: SignedIn, now: Date): Date | undefined {
  if (isFresh(session, now)) return session.createdAt;
  if (session.signedInBy !== "device" || !session.passkeyAt) return undefined;
  // A passkey ahead of the clock is none of the last ten minutes, so a clock stepped back can't stretch the window.
  const since = now.getTime() - session.passkeyAt.getTime();
  return since >= 0 && since <= FRESH_FOR_MS ? session.passkeyAt : undefined;
}

/**
 * Whether a session may give or take an agent's standing at `now`: a passkey
 * sign-in within ten minutes, or a device sign-in within ten minutes of the
 * passkey that approved it.
 */
export function isFreshForApproval(session: SignedIn, now: Date): boolean {
  return approvalPasskeyAt(session, now) !== undefined;
}

/**
 * Whether a session may add its account's first passkey at `now`: one the
 * person signed in themselves within the last ten minutes. It is asked only
 * of an account that holds no passkey.
 */
export function mayAddFirstPasskey(session: SignedIn, now: Date): boolean {
  if (typeof session.signedInBy !== "string" || !OWN_SIGN_INS.has(session.signedInBy)) return false;
  return recent(session, now);
}
