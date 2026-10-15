// Sponsoring an agent, as the sponsor's page does it and as a request on the home is approved: one tap is a
// passkey touch and then the approval.

import { KeelRefused } from "../source/types.ts";
import type { Who } from "./account.ts";
import type { SponsorLink } from "./sponsorLink.ts";

/** What the tap needs of the page: a passkey sign-in, and the one call that approves. */
export interface Sponsoring {
  signIn(): Promise<Who>;
  approve(agentId: string, code: string): Promise<void>;
}

/** What came of a tap: the approval went as the person who touched, or the touch was another account's. */
export type Stood = { is: "approved"; as: Who } | { is: "changed"; to: Who };

/**
 * One tap. The person signs in afresh with a passkey, which signs a visitor in too, and only then is the
 * approval sent, as whoever touched. Where someone was signed in and the passkey is another account's, nothing
 * is sent: the page reads as that account, and sponsoring the agent is theirs to tap for.
 */
export async function sponsorAgent(
  sponsoring: Sponsoring,
  link: SponsorLink,
  reader: Who | null,
): Promise<Stood> {
  const signedIn = await sponsoring.signIn();
  if (reader !== null && signedIn.id !== reader.id) return { is: "changed", to: signedIn };
  await sponsoring.approve(link.agentId, link.code);
  return { is: "approved", as: signedIn };
}

/** What Approve on a request waiting for the reader needs of the page: a passkey sign-in, and Keel's approval. */
export interface Answering {
  signIn(): Promise<Who>;
  approve(agentId: string, key: string): Promise<void>;
}

/**
 * Approve on a request on the reader's own list, as GitHub accepts an invitation from its dashboard, with the one
 * step GitHub's sudo mode adds: Keel takes an approval only from a passkey sign-in of the last ten minutes, so the
 * tap is a passkey touch and then the approval. A passkey that is another account's sends nothing: the request
 * was to the reader, by their handle, and the page then reads as whoever touched.
 */
export async function approveRequest(
  answering: Answering,
  agentId: string,
  reader: string,
  key: string,
): Promise<Stood> {
  const signedIn = await answering.signIn();
  if (signedIn.handle !== reader) return { is: "changed", to: signedIn };
  await answering.approve(agentId, key);
  return { is: "approved", as: signedIn };
}

/**
 * Whether Keel's refusal ends the link: the code was wrong, used or run out, or the agent is not there (one
 * answer, 404), or someone sponsors it already (409). The code is forgotten then. A sign-in that is not
 * fresh, a touch the person called off and a Keel that could not be reached leave it to be tried again.
 */
export const spent = (error: unknown): boolean =>
  error instanceof KeelRefused && (error.status === 404 || error.status === 409);
