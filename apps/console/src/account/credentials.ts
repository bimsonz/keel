// A namespace's credentials and a project's Cloudflare account, in words: what the page says of each, and how a
// Connect through Cloudflare came back. Nothing here reads, keeps or sends a token.

import type { Credential, DeployProvider, DeployTargetView } from "../contract/keel/index.ts";

/** Cloudflare's page of an account's API tokens, where an owner revokes the one Keel made for a project. */
export const TOKENS_PAGE = "https://dash.cloudflare.com/?to=/:account/api-tokens";

/** How a Connect through Cloudflare ended, as Keel's callback names it in `?cloudflare=` on the project's settings. */
export const CONNECT_OUTCOMES = [
  "connected",
  "denied",
  "expired",
  "accounts",
  "refused",
  "unreachable",
  "no-workers-dev",
  "full",
] as const;
export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

/** What the settings say of each outcome, as a label, and whether it is good news. */
export const CONNECT_SAID: Readonly<
  Record<ConnectOutcome, { readonly ok: boolean; readonly said: string }>
> = {
  connected: { ok: true, said: "Connected" },
  denied: { ok: false, said: "Not connected: consent declined" },
  expired: { ok: false, said: "Not connected: consent expired, connect again" },
  accounts: { ok: false, said: "Not connected: choose exactly one account" },
  refused: { ok: false, said: "Not connected: refused by Cloudflare" },
  unreachable: { ok: false, said: "Not connected: the token cannot reach the account's Workers" },
  "no-workers-dev": { ok: false, said: "Not connected: the account has no workers.dev subdomain" },
  full: { ok: false, said: "Not connected: the project has all the targets it may" },
};

/** The step of a Connect Cloudflare refused, as Keel's callback names it in `?step=`, as a label. */
export const REFUSED_AT: Readonly<Record<string, string>> = {
  exchange: "at the code exchange",
  accounts: "at the account read",
  mint: "at the token",
  unconfigured: "no OAuth client on this instance",
  check: "at the account check",
};

/** Where a refused Connect stopped, in words, with Cloudflare's own error code, if the address names a step. */
export function refusedAtIn(search: string): string | undefined {
  const query = new URLSearchParams(search);
  const step = query.get("step");
  const at = step === null ? undefined : REFUSED_AT[step];
  const code = query.get("code");
  return at === undefined || code === null || !/^\d+$/.test(code)
    ? at
    : `${at}, Cloudflare error ${code}`;
}

/** The outcome an address's query names, if it names one Keel's callback gives. */
export function outcomeIn(search: string): ConnectOutcome | undefined {
  const named = new URLSearchParams(search).get("cloudflare");
  return CONNECT_OUTCOMES.find((outcome) => outcome === named);
}

/** What a target is called until its owner says otherwise: the name in Keel's own example of a project's deploy file. */
export const FIRST_TARGET = "production";

/** A provider by its own name. */
export const PROVIDER: Readonly<Record<DeployProvider, string>> = { cloudflare: "Cloudflare" };

const day = (iso: string): string => iso.slice(0, 10);

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
