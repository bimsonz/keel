// The addresses above every project: the pages a user has whatever project they are in. Each is one of the
// reserved first segments (route.ts), so none can be taken for a project or an org.

export type OrgTab = "home" | "members" | "settings";

/** A page above every project. */
export type Place =
  | { at: "login" }
  | { at: "signup" }
  | { at: "settings" }
  /** Where `keeltown login` sends a person, with the code their terminal is showing. */
  | { at: "device"; userCode: string }
  | { at: "new-org" }
  /** An org's own pages. Its home is here until an org's handle is the first segment of an address. */
  | { at: "org"; org: string; tab: OrgTab }
  /** An invitation to an org, as the person it was made to opens it. */
  | { at: "invite"; id: string };

const ORG_TABS: readonly OrgTab[] = ["home", "members", "settings"];

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
  switch (segment) {
    case "new":
      return second === "org" && third === undefined ? { at: "new-org" } : null;
    case "orgs": {
      const tab = third === undefined ? "home" : ORG_TABS.slice(1).find((held) => held === third);
      return second === undefined || tab === undefined ? null : { at: "org", org: second, tab };
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
    case "org":
      return ["orgs", place.org, ...(place.tab === "home" ? [] : [place.tab])];
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
  if (reader.is === "visitor")
    return place.at === "login" || place.at === "signup" ? null : hrefOf({ at: "login" }, asked);
  if (place.at === "login") return nextOf(here.search);
  if (place.at === "signup") return reader.handle === undefined ? null : nextOf(here.search);
  // An org's pages are for a user with a name on this Keel: Keel refuses them to one who has not chosen it.
  const above = place.at === "new-org" || place.at === "org" || place.at === "invite";
  return above && reader.handle === undefined ? hrefOf({ at: "signup" }, asked) : null;
}
