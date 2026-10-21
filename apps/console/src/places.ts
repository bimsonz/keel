// The addresses above every project: the pages a user has whatever project they are in, a namespace's own
// page, and an org's. A namespace's page is at its handle, `/<handle>`, as an owner's is on a code host: a
// person's projects, an agent's, or an org's home. Every other one is at a first segment Keel reserves, in
// its own list, so none can be taken for a handle.

import { appRequestAgain, isAppRequest } from "./account/apps.ts";
import { RESERVED_SEGMENTS } from "./contract/keel/index.ts";

export type OrgTab = "home" | "members" | "credentials" | "settings";

/** A page above every project. */
export type Place =
  | { at: "login" }
  | { at: "signup" }
  | { at: "settings" }
  /** Where `keeltown login` sends a person, with the code their terminal is showing. */
  | { at: "device"; userCode: string }
  /** Where Keel's sign-in sends a person to allow an app to act as them, the app's request signed into the address. */
  | { at: "consent" }
  | { at: "new-org" }
  /**
   * Making a project. `owner` is the namespace the link here named, where it named one; `start` is how the link
   * asked for it to start, where it asked for an import.
   */
  | { at: "new-project"; owner?: string; start?: "import" }
  /** Forking a project, at the project's own address with `fork` after it, as a code host has it. */
  | { at: "fork"; namespace: string; project: string }
  /**
   * A namespace's own page, at its handle. Whose the handle is, Keel says: the address does not. `tab` is one of
   * its sections under that address, as a code host has `?tab=` on an owner's page: its projects, or a person's
   * orgs.
   */
  | { at: "namespace"; handle: string; tab?: "projects" | "orgs" }
  /** An org's members, its credentials and its settings, under `/orgs/<org>/…`. Its home is its namespace's page. */
  | { at: "org"; org: string; tab: Exclude<OrgTab, "home"> }
  /** An invitation to an org, as the person it was made to opens it. */
  | { at: "invite"; id: string }
  /** Where an agent sends the person it asks to sponsor it. What it asks is in the fragment, never here. */
  | { at: "sponsor" };

/**
 * A first segment that could be a handle: Keel's handles are letters, digits and single hyphens, at most 39, read
 * in any case. Anything else at the top (`/sitemap.xml`) names no namespace, and is no page here.
 */
const HANDLE_LIKE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/i;

const UNDER_ORGS: readonly Exclude<OrgTab, "home">[] = ["members", "credentials", "settings"];

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
    HANDLE_LIKE.test(segment) &&
    !RESERVED_SEGMENTS.some((word) => word === segment)
  ) {
    const tab = new URLSearchParams(search).get("tab");
    return {
      at: "namespace",
      handle: segment,
      ...(tab === "projects" || tab === "orgs" ? { tab } : {}),
    };
  }
  // A project's own address with `fork` after it is the form that forks it: no page of a project has that name.
  if (
    segment !== undefined &&
    second !== undefined &&
    third === "fork" &&
    !RESERVED_SEGMENTS.some((word) => word === segment)
  )
    return { at: "fork", namespace: segment, project: second };
  switch (segment) {
    case "new": {
      if (second === undefined) {
        const query = new URLSearchParams(search);
        const owner = query.get("owner");
        return {
          at: "new-project",
          ...(owner === null || owner === "" ? {} : { owner }),
          ...(query.get("start") === "import" ? { start: "import" as const } : {}),
        };
      }
      return second === "org" && third === undefined ? { at: "new-org" } : null;
    }
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
    case "sponsor":
      return { at: "sponsor" };
    case "device":
      return { at: "device", userCode: new URLSearchParams(search).get("user_code") ?? "" };
    case "consent":
      return { at: "consent" };
    default:
      return null;
  }
}

function pathOf(place: Place): string[] {
  switch (place.at) {
    case "new-org":
      return ["new", "org"];
    case "new-project":
      return ["new"];
    case "fork":
      return [place.namespace, place.project, "fork"];
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

const ORG_TAB_TITLE: Record<Exclude<OrgTab, "home">, string> = {
  members: "Members",
  credentials: "Credentials",
  settings: "Settings",
};

/** What a page above every project is titled, as a code host titles its own: the page, whose it is, then Keel. */
export function titleOfPlace(place: Place): string {
  const page = ((): string => {
    switch (place.at) {
      case "login":
        return "Sign in";
      case "signup":
        return "Sign up";
      case "settings":
        return "Settings";
      case "device":
        return "Device activation";
      case "consent":
        return "Authorize an app";
      case "new-org":
        return "New org";
      case "new-project":
        return "New project";
      case "fork":
        return `Fork ${place.namespace}/${place.project}`;
      case "org":
        return `${ORG_TAB_TITLE[place.tab]} · ${place.org}`;
      case "invite":
        return "Invitation";
      case "sponsor":
        return "Sponsor";
      default:
        // A namespace's page, by its handle: the one place left.
        return place.handle;
    }
  })();
  return `${page} · Keel`;
}

export function hrefOf(place: Place, next?: string): string {
  const query = new URLSearchParams();
  if (place.at === "device" && place.userCode !== "") query.set("user_code", place.userCode);
  if (place.at === "new-project" && place.owner !== undefined) query.set("owner", place.owner);
  if (place.at === "new-project" && place.start !== undefined) query.set("start", place.start);
  if (place.at === "namespace" && place.tab !== undefined) query.set("tab", place.tab);
  if (next !== undefined && next !== "/") query.set("next", next);
  const path = pathOf(place)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
}

/**
 * Where to go once signed in: the page that sent the reader to sign in, if it was one of this console's, or, where
 * Keel's sign-in sent them here for an app, the app's request again at Keel's own authorization endpoint.
 * Anything else an address asks for is not followed: a link must not be able to send a person who has just
 * signed in to another site.
 */
export function nextOf(search: string): string {
  if (isAppRequest(search)) return appRequestAgain(search);
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
  // The sponsor's page is too: its one tap signs a visitor in, and a trip to sign in would lose what the
  // agent's link carried, which is kept nowhere but in the page's memory.
  const open =
    place.at === "login" ||
    place.at === "signup" ||
    place.at === "namespace" ||
    place.at === "sponsor";
  if (reader.is === "visitor") return open ? null : hrefOf({ at: "login" }, asked);
  if (place.at === "login") return nextOf(here.search);
  if (place.at === "signup") return reader.handle === undefined ? null : nextOf(here.search);
  // These pages are for a user with a name on this Keel: Keel refuses them to one who has not chosen it.
  const above =
    place.at === "new-org" ||
    place.at === "new-project" ||
    place.at === "fork" ||
    place.at === "namespace" ||
    place.at === "org" ||
    place.at === "invite";
  return above && reader.handle === undefined ? hrefOf({ at: "signup" }, asked) : null;
}

/**
 * The address git clones a project from: this Keel's own origin, the project's place and `.git`. Keel serves
 * its trunk there to stock git, read-only.
 */
export function cloneAddress(origin: string, namespace: string, project: string): string {
  return `${origin}/${encodeURIComponent(namespace)}/${encodeURIComponent(project)}.git`;
}
