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

/**
 * Whether a handle is one of the reader's orgs, as Keel's list of their orgs says: undefined until it has said.
 * Only such a handle is read as an org; any other is a person's, an agent's or an org they are not in, and the
 * org read would only be refused. A person with no handle yet is in no org.
 */
export function inOrg(
  handle: string,
  who: { handle?: string | undefined },
  orgs: readonly { handle: string }[] | null,
): boolean | undefined {
  if (who.handle === undefined) return false;
  if (orgs === null) return undefined;
  return orgs.some((org) => org.handle.toLowerCase() === handle.toLowerCase());
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
