// A namespace's credentials and a project's Cloudflare account, in words: what the page says of each, and the
// two things it fills in for an owner before they type. Nothing here reads, keeps or sends a token.

import type { Credential, DeployProvider, DeployTargetView } from "../contract/keel/index.ts";

/** Cloudflare's page for making an API token, with the one permission Keel needs (Workers Scripts: Edit) chosen and the token named. */
export const TOKEN_LINK =
  "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&name=Keel%20deploys";

/** What a target is called until its owner says otherwise: the name in Keel's own example of a project's deploy file. */
export const FIRST_TARGET = "production";

/** The longest label Keel keeps. */
const LABEL_MOST = 64;

/** A provider by its own name. */
export const PROVIDER: Readonly<Record<DeployProvider, string>> = { cloudflare: "Cloudflare" };

const day = (iso: string): string => iso.slice(0, 10);

/**
 * The label a token pasted on a project's form is stored under until its owner changes it: the project's, for
 * its deploys, cut to the length Keel keeps and with no space at its end.
 */
export function labelFor(project: string): string {
  return `${project} deploys`.slice(0, LABEL_MOST).trim();
}

/** What a credential's row says beside its label: the provider, the day it was stored, and whether the reader did. */
export function storedOf(credential: Credential, readerId: string): string {
  const by = credential.createdBy === readerId ? " by you" : "";
  return `${PROVIDER[credential.provider]} · stored on ${day(credential.createdAt)}${by}`;
}

/**
 * The credential a target names, from the namespace's store as Keel lists it. Keel deletes a credential a target
 * still names, and the target keeps the id: then there is none, and the target cannot reach its account.
 */
export function credentialOf(
  target: Pick<DeployTargetView, "credential">,
  stored: readonly Credential[],
): Credential | undefined {
  return stored.find((credential) => credential.id === target.credential);
}
