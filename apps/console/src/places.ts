// The addresses above every project: the pages a user has whatever project they are in. Each is one of the
// reserved first segments (route.ts), so none can be taken for a project or an org.

/** A page above every project. */
export type Place =
  | { at: "login" }
  | { at: "signup" }
  | { at: "settings" }
  /** Where `keeltown login` sends a person, with the code their terminal is showing. */
  | { at: "device"; userCode: string };

/** The place an address names, or null where it names none of them. */
export function placeOf(pathname: string, search = ""): Place | null {
  const [segment, ...more] = pathname.split("/").filter((part) => part !== "");
  if (more.length > 0) return null;
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

export function hrefOf(place: Place, next?: string): string {
  const query = new URLSearchParams();
  if (place.at === "device" && place.userCode !== "") query.set("user_code", place.userCode);
  if (next !== undefined && next !== "/") query.set("next", next);
  return `/${place.at}${query.size > 0 ? `?${query.toString()}` : ""}`;
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
