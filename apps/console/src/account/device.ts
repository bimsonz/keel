// Approving a terminal, as the device page does it: one tap is a passkey touch and then the approval, or for an
// account that holds no passkey the approval alone.

import type { Who } from "./account.ts";

/** What the tap needs of the page: a passkey sign-in, and the one call that approves the code. */
export interface Approving {
  signIn(): Promise<Who>;
  approve(): Promise<void>;
}

/** What came of a tap: the terminal was approved, or the touch was another account's and nothing was. */
export type Approval = { is: "approved" } | { is: "changed"; to: Who };

/**
 * One tap. The person signs in afresh with a passkey every time, however new their sign-in here already is, and
 * only then is the code approved. Keel gives the terminal its ten minutes from the passkey the approving session
 * signed in with, so a touch just now gives it all ten, and a code someone else sent them is approved only by a
 * touch of their own authenticator. The code was claimed for the account reading the page, and Keel approves it
 * for that account alone: where the passkey is another account's, nothing is sent.
 */
export async function approveWithPasskey(approving: Approving, reader: Who): Promise<Approval> {
  const signedIn = await approving.signIn();
  if (signedIn.id !== reader.id) return { is: "changed", to: signedIn };
  await approving.approve();
  return { is: "approved" };
}

/**
 * The tap, for whoever reads the page. An account that holds a passkey approves with it, every time. One that
 * holds none has nothing to touch, and is not shut out: the code is approved on the sign-in it has, and Keel gives
 * the terminal no fresh window, so it does all the reader may do but what a passkey from the last ten minutes is
 * needed for.
 */
export async function approveTerminal(
  approving: Approving,
  reader: Who,
  holdsPasskey: boolean,
): Promise<Approval> {
  if (holdsPasskey) return approveWithPasskey(approving, reader);
  await approving.approve();
  return { is: "approved" };
}
