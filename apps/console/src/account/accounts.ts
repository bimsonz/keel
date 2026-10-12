// A person's accounts on Keel, as a code host lists them: their own, then the
// orgs they made or joined. A person needs no org. Keel keeps a person's own
// namespace, `/<handle>`, as an org named by their handle, and that is how it
// is stored and nothing more: a page never calls it an org, gives it no
// members and no settings, and lists it first, as theirs.

import { hrefOf } from "../places.ts";
import type { Org } from "./account.ts";

/** One account in the frame's dropdown. */
export interface AccountEntry {
  name: string;
  href: string;
  note?: string;
}

/** Whether this is the reader's own namespace: the one Keel made for them, named by their handle. */
export function isOwn(org: { handle: string }, who: { handle?: string | undefined }): boolean {
  return who.handle !== undefined && org.handle === who.handle;
}

/** The orgs a person made or joined: every one Keel lists for them but their own namespace. */
export function orgsOf(orgs: readonly Org[], who: { handle?: string | undefined }): Org[] {
  return orgs.filter((org) => !isOwn(org, who));
}

/** What the frame's dropdown lists: the person's own handle first, marked as theirs, then their orgs. */
export function accountsOf(
  orgs: readonly Org[],
  who: { handle?: string | undefined },
): AccountEntry[] {
  const own = orgs.filter((org) => isOwn(org, who));
  return [...own, ...orgsOf(orgs, who)].map((org) => ({
    name: org.handle,
    href: hrefOf({ at: "org", org: org.handle, tab: "home" }),
    ...(isOwn(org, who) ? { note: "you" } : org.name === org.handle ? {} : { note: org.name }),
  }));
}
