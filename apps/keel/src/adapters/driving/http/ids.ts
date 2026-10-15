/**
 * An id as Keel writes one, in either case: a type prefix, then a ULID in
 * Crockford base32, which reads the same upper-case or lower-case.
 */
const ID =
  /^(agt|ses|run|chg|wsp|sub|cnd|vrd|cfl|dec|prb|lse|esc|evt|prj|bat|grd|tnt|dpl|usr|org|crd)_[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The id as Keel writes it, its ULID upper-case; any other string as it came. */
export const canonicalId = (value: string): string =>
  ID.test(value) ? `${value.slice(0, 4).toLowerCase()}${value.slice(4).toUpperCase()}` : value;

/**
 * Every string in a JSON value that is wholly an id, written as Keel writes
 * ids. A string that only holds an id among other text is left as it is, so a
 * file's contents or a goal are never touched.
 */
export function canonicalIds(value: unknown): unknown {
  if (typeof value === "string") return canonicalId(value);
  if (Array.isArray(value)) return value.map(canonicalIds);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, canonicalIds(item)]),
    );
  return value;
}

/** Where a request's ids are read in either case: the API and the MCP door. */
const DOORS = /^\/(v1\/|mcp$)/;

/**
 * The request as Keel reads it: at the API and the MCP door, each path
 * segment, query value and JSON body string that is wholly an id is written as
 * Keel writes ids, before any route or validator sees it, so `prj_nx568p…` is
 * `prj_NX568P…`. Anything else, and a body that is not JSON, comes through as
 * it was sent.
 */
export async function canonicalRequest(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (!DOORS.test(url.pathname)) return request;
  const path = url.pathname
    .split("/")
    .map((segment) => {
      const decoded = safeDecode(segment);
      const written = decoded === undefined ? segment : canonicalId(decoded);
      return written === decoded ? segment : encodeURIComponent(written);
    })
    .join("/");
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) query.append(key, canonicalId(value));
  const written = query.toString();
  const search = written === url.searchParams.toString() ? url.search : `?${written}`;
  const json = (request.headers.get("content-type") ?? "").includes("json");
  const sent = json && request.body !== null ? await request.text() : undefined;
  const body = sent === undefined ? undefined : rewrittenJson(sent);
  // A JSON body was read to see it, so the request is made again even when nothing changed.
  if (sent === undefined && path === url.pathname && search === url.search) return request;
  const headers = new Headers(request.headers);
  // A body written anew has a length of its own.
  if (body !== sent) headers.delete("content-length");
  return new Request(`${url.origin}${path}${search}`, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(body === undefined ? (request.body === null ? {} : { body: request.body }) : { body }),
  });
}

/** A JSON body with its ids written as Keel writes them; one with none to write, or that does not parse, as it was sent. */
function rewrittenJson(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const written = JSON.stringify(canonicalIds(parsed));
    return written === JSON.stringify(parsed) ? text : written;
  } catch {
    return text;
  }
}

const safeDecode = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};
