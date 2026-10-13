// A person's accounts on Keel, as a code host lists them: their own, then the
// orgs they made or joined. A person needs no org: their handle is a namespace
// of its own kind, `user`, and Keel keeps no org for it. So a person's own
// account is never among the orgs Keel lists for them: a page never calls it
// an org, gives it no members and no settings, and lists it first, as theirs.

import { hrefOf } from "../places.ts";
import type { Org } from "./account.ts";

/** One account in the frame's dropdown. */
export interface AccountEntry {
  name: string;
  href: string;
  note?: string;
}

/** Whether a handle is this person's own: their account, and no org. */
export function isOwn(
  namespace: { handle: string },
  who: { handle?: string | undefined },
): boolean {
  return who.handle !== undefined && namespace.handle === who.handle;
}

/** What the frame's dropdown lists: the person's own handle first, marked as theirs, then their orgs. */
export function accountsOf(
  orgs: readonly Org[],
  who: { handle?: string | undefined },
): AccountEntry[] {
  // Someone who has not chosen a handle yet has no account to go to.
  const own: AccountEntry[] =
    who.handle === undefined
      ? []
      : [
          {
            name: who.handle,
            href: hrefOf({ at: "namespace", handle: who.handle }),
            note: "you",
          },
        ];
  return [
    ...own,
    ...orgs.map((org) => ({
      name: org.handle,
      href: hrefOf({ at: "namespace", handle: org.handle }),
      ...(org.name === org.handle ? {} : { note: org.name }),
    })),
  ];
}
