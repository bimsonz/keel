// What answers Keel's refusal of a change to how an account signs in. Keel takes one only from a session signed
// in by a passkey in the last ten minutes, and takes an account's first passkey from any sign-in of its own
// that new. Either way the answer is to sign in again, and the page offers the way this person has.

/** Keel's code for a change to how an account signs in asked by a session that is not fresh. */
export const FRESH_SIGN_IN_REQUIRED = "FRESH_SIGN_IN_REQUIRED";

/**
 * How this person signs in afresh, or null where Keel refused for another reason or the page does not yet know
 * what they hold. With a passkey it is one touch of it, here on the page. With none they have none to touch:
 * they sign in again the way they came, by a code or a provider, and come back.
 */
export function wayToFresh(
  refused: string | undefined,
  passkeys: number | null,
): "passkey" | "sign-in" | null {
  if (refused !== FRESH_SIGN_IN_REQUIRED || passkeys === null) return null;
  return passkeys > 0 ? "passkey" : "sign-in";
}
