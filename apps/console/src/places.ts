// The addresses above every project: the pages a user has whatever project they are in, a namespace's own
// page, and an org's. A namespace's page is at its handle, `/<handle>`, as an owner's is on a code host: a
// person's projects, an agent's, or an org's home. Every other one is at a first segment Keel reserves, in
// its own list, so none can be taken for a handle.

import { RESERVED_SEGMENTS } from "./contract/keel/index.ts";

export type OrgTab = "home" | "members" | "settings";

/** A page above every project. */
export type Place =
  | { at: "login" }
  | { at: "signup" }
  | { at: "settings" }
  /** Where `keeltown login` sends a person, with the code their terminal is showing. */
  | { at: "device"; userCode: string }
  | { at: "new-org" }
  /** A namespace's own page, at its handle. Whose the handle is, Keel says: the address does not. */
  | { at: "namespace"; handle: string }
  /** An org's members and its settings, under `/orgs/<org>/…`. Its home is its namespace's page. */
  | { at: "org"; org: string; tab: Exclude<OrgTab, "home"> }
  /** An invitation to an org, as the person it was made to opens it. */
  | { at: "invite"; id: string };

const UNDER_ORGS: readonly Exclude<OrgTab, "home">[] = ["members", "settings"];

/** The place an address names, or null where it names none of them. */
export function placeOf(pathname: string, search = ""): Place | null {
  let segments: string[];
  try {
    segments = pathname
      .split("/")
      .filter((part) => part !== "")
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const [segment, second, third, ...more] = segments;
  if (more.length > 0) return null;
  // One segment that is no reserved word is a handle, and the address is that namespace's own page.
  if (
    segment !== undefined &&
    second === undefined &&
    !RESERVED_SEGMENTS.some((word) => word === segment)
  )
    return { at: "namespace", handle: segment };
  switch (segment) {
    case "new":
      return second === "org" && third === undefined ? { at: "new-org" } : null;
    case "orgs": {
      if (second === undefined) return null;
      // An org's home was once here. It is at its handle, and main.tsx corrects the address.
      if (third === undefined) return { at: "namespace", handle: second };
      const tab = UNDER_ORGS.find((held) => held === third);
      return tab === undefined ? null : { at: "org", org: second, tab };
    }
    case "invite":
      return second === undefined || third !== undefined ? null : { at: "invite", id: second };
    default:
  }
  if (second !== undefined) return null;
  switch (segment) {
    case "login":
      return { at: "login" };
    case "signup":
      return { at: "signup" };
    case "settings":
      return { at: "settings" };
    case "device":
      return { at: "device", userCode: new URLSearchParams(search).get("user_code") ?? "" };
    default:
      return null;
  }
}

function pathOf(place: Place): string[] {
  switch (place.at) {
    case "new-org":
      return ["new", "org"];
    case "namespace":
      return [place.handle];
    case "org":
      return ["orgs", place.org, place.tab];
    case "invite":
      return ["invite", place.id];
    default:
      return [place.at];
  }
}

export function hrefOf(place: Place, next?: string): string {
  const query = new URLSearchParams();
  if (place.at === "device" && place.userCode !== "") query.set("user_code", place.userCode);
  if (next !== undefined && next !== "/") query.set("next", next);
  const path = pathOf(place)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
}

/**
 * Where to go once signed in: the page that sent the reader to sign in, if it was one of this console's.
 * Anything else an address asks for is not followed: a link must not be able to send a person who has just
 * signed in to another site.
 */
export function nextOf(search: string): string {
  const asked = new URLSearchParams(search).get("next") ?? "";
  if (!asked.startsWith("/")) return "/";
  // Read as an address on a site of no name: one that is still on that site is a path here.
  const nowhere = "https://nowhere.invalid";
  try {
    const read = new URL(asked, nowhere);
    return read.origin === nowhere ? `${read.pathname}${read.search}` : "/";
  } catch {
    return "/";
  }
}

/**
 * Where a reader is sent in place of the page they asked for, or null where they stay. `here` is the address
 * they asked for, and it is where they come back to: someone who opens an invitation signed out signs in, and
 * is then at that invitation.
 */
export function sentFrom(
  place: Place,
  reader: { is: "visitor" } | { is: "user"; handle?: string | undefined },
  here: { pathname: string; search: string },
): string | null {
  const asked = `${here.pathname}${here.search}`;
  // A namespace's page is anyone's to open: Keel shows a visitor its public projects, and nothing else of it.
  const open = place.at === "login" || place.at === "signup" || place.at === "namespace";
  if (reader.is === "visitor") return open ? null : hrefOf({ at: "login" }, asked);
  if (place.at === "login") return nextOf(here.search);
  if (place.at === "signup") return reader.handle === undefined ? null : nextOf(here.search);
  // These pages are for a user with a name on this Keel: Keel refuses them to one who has not chosen it.
  const above =
    place.at === "new-org" ||
    place.at === "namespace" ||
    place.at === "org" ||
    place.at === "invite";
  return above && reader.handle === undefined ? hrefOf({ at: "signup" }, asked) : null;
}
