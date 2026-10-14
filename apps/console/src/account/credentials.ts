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

/** What the settings say of each outcome, and whether it is good news. */
export const CONNECT_SAID: Readonly<
  Record<ConnectOutcome, { readonly ok: boolean; readonly said: string }>
> = {
  connected: { ok: true, said: "Connected. Keel made its deploy token on the account you ticked." },
  denied: { ok: false, said: "Cloudflare's consent was declined, so nothing was connected." },
  expired: {
    ok: false,
    said: "That consent was for a Connect that has ended: it lasts ten minutes and is used once. Continue with Cloudflare again.",
  },
  accounts: {
    ok: false,
    said: "Tick exactly one account on Cloudflare's consent screen: a target deploys to one. Nothing was connected.",
  },
  refused: {
    ok: false,
    said: "Cloudflare refused Keel's request, so nothing was connected. Continue with Cloudflare again; if it is refused again, your role on the account may not let you make API tokens.",
  },
  unreachable: {
    ok: false,
    said: "Keel made its token, but it does not reach the account's Workers, so no target was set.",
  },
  "no-workers-dev": {
    ok: false,
    said: "The account has no workers.dev subdomain to serve previews from. Set one in Cloudflare's dashboard (Workers & Pages → your subdomain), then connect again: Keel's token is stored, so choose it below.",
  },
  full: {
    ok: false,
    said: "The project already has all the deploy targets it may. Remove one, then connect again.",
  },
};

/** The step of a Connect Cloudflare refused, as Keel's callback names it in `?step=`, in words. */
export const REFUSED_AT: Readonly<Record<string, string>> = {
  exchange: "Cloudflare refused to exchange the consent for access",
  accounts: "Cloudflare refused to say which account you ticked",
  mint: "Cloudflare refused to let Keel make its token on the account",
  unconfigured: "this instance has no OAuth client registered with Cloudflare",
  check: "Cloudflare's answer to Keel's check of the account with its new token",
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
