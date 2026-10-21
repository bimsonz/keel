// An app a person signs in through, such as an MCP client: Keel's sign-in sends the person here to sign in and
// to allow it, with the app's request signed into the address. What the pages read of that address is here.

/** The fields Keel's sign-in adds to an app's request to sign it. Sent back to it, they are dropped. */
const SIGNING = new Set(["exp", "sig", "ba_iat", "ba_param", "ba_pl"]);

/** Where an app asks to sign its person in. */
export const AUTHORIZE_PATH = "/v1/auth/oauth2/authorize";

/** Whether an address's query is an app's request that Keel's sign-in sent here, signed. */
export function isAppRequest(search: string): boolean {
  const query = new URLSearchParams(search);
  return query.has("client_id") && query.get("response_type") === "code" && query.has("sig");
}

/**
 * Where a person who signed in for an app goes next: the app's request again, at Keel's authorization endpoint,
 * which now finds them signed in and asks them to allow it. It is always Keel's own address.
 */
export function appRequestAgain(search: string): string {
  const query = new URLSearchParams(search);
  for (const name of SIGNING) query.delete(name);
  return `${AUTHORIZE_PATH}?${query.toString()}`;
}

/** What the page that asks a person to allow an app shows: which app, and where it sends them back. */
export interface AppAsking {
  readonly clientId: string;
  /** The origin the code goes to: the app on this machine, or its site. */
  readonly returnsTo: string;
  /** The signed request, as Keel wants it back with the person's answer. */
  readonly query: string;
}

export function appAskingOf(search: string): AppAsking | null {
  const query = new URLSearchParams(search);
  const clientId = query.get("client_id");
  const redirect = URL.parse(query.get("redirect_uri") ?? "");
  if (clientId === null || clientId === "" || redirect === null || !query.has("sig")) return null;
  return {
    clientId,
    returnsTo: redirect.origin,
    query: search.startsWith("?") ? search.slice(1) : search,
  };
}

/** An app the person allowed, as their settings list it. */
export interface AllowedApp {
  /** The consent's id: what revoking it names. */
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly allowedAt: string;
}
