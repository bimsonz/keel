/**
 * A fresh sign-in: what a session needs before it may change how its account
 * signs in (add or remove a passkey, link or unlink a provider, change the
 * address). An account has no second factor and no recovery, so a session that
 * could do this at any age would make whoever holds it the account's owner for
 * good. Only a session signed in by a passkey within the last ten minutes may.
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
 * Whether a session may change how its account signs in at `now`. A session
 * with no method, as every one made before the method was recorded, is not
 * fresh, nor is one whose time of making can't be read.
 */
export function isFresh(
  session: { readonly signedInBy?: string | null; readonly createdAt: Date },
  now: Date,
): boolean {
  if (session.signedInBy !== "passkey") return false;
  return now.getTime() - session.createdAt.getTime() <= FRESH_FOR_MS;
}
