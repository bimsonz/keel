// A link's card, as a code host gives a repository's: what a crawler that runs no script reads from the page's
// own tags when the link is shared. The page sets its title by script, which no crawler runs, so the built page
// carries the site's card, and for a project's own paths this Worker rewrites it to the project's: its place,
// `<namespace>/<project>`, read from Keel as anyone may read it, and its description where Keel gives one.
//
// Only a crawler is given the project's card, and only from a read that is anonymous (nothing of the request is
// passed on: a private project is no project to it), bounded, and kept for five minutes per project, so one
// share that fans out to many crawlers costs Keel one read. A person's request is never held for it.

import type { Fetcher } from "./handler.ts";

/** What a crawler announces itself as: those that read a link's card for a post, a chat or a search. */
const CRAWLERS =
  /bot\b|bot\/|crawler|spider|facebookexternalhit|facebookcatalog|embedly|slack|discord|telegram|whatsapp|linkedin|skypeuripreview|vkshare|pinterest|redditbot|mastodon|bluesky|cardyb|iframely|quora link preview|outbrain|flipboard|tumblr|nuzzel|bitlybot|google-inspectiontool|preview/i;

/** Whether a request is a crawler's, by what it says it is. */
export function isCrawler(userAgent: string | null): boolean {
  return userAgent !== null && CRAWLERS.test(userAgent);
}

/** The site's own card, as the built page carries it. */
export const SITE = {
  title: "Keel",
  description: "A Git platform for software agents, built on Cloudflare Workers and Artifacts.",
} as const;

/** How long a project's card is waited for, at most: past it, the site's card is served. */
export const CARD_WAIT_MS = 400;

/** How long a project's card, or Keel's having none to show, is kept for the next crawler. */
export const CARD_KEPT_S = 300;

/** A project's place, as its paths name it. */
export interface Place {
  namespace: string;
  project: string;
}

/**
 * The project a path is under, where it is one of a project's: `/<namespace>/<project>` and below, under a first
 * segment that is no word Keel reserves. A clone address is git's, not a page.
 */
export function placeOf(pathname: string, reserved: ReadonlySet<string>): Place | null {
  const [namespace, project] = pathname.split("/").slice(1);
  if (namespace === undefined || project === undefined || namespace === "" || project === "")
    return null;
  if (reserved.has(namespace) || project.endsWith(".git")) return null;
  try {
    return { namespace: decodeURIComponent(namespace), project: decodeURIComponent(project) };
  } catch {
    return null;
  }
}

/** A project's card: its place, and its description where it has one, else the site's line. */
export interface Card {
  title: string;
  description: string;
}

/** What a page's card is, out of what Keel answered of the project: anyone's read of its view. */
export function cardOf(place: Place, view: unknown): Card | null {
  if (typeof view !== "object" || view === null) return null;
  const { name, description } = view as { name?: unknown; description?: unknown };
  if (typeof name !== "string") return null;
  return {
    title: `${place.namespace}/${name}`,
    description:
      typeof description === "string" && description.trim() !== ""
        ? description.trim()
        : SITE.description,
  };
}

/** The Cache API's own shape, as much of it as the card needs. */
export interface CardCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * The project's card as Keel shows it to anyone, or null where it shows none (a private project, one that is not
 * there, or a Keel slower than `CARD_WAIT_MS`). Read with nothing of the asker's request: no cookie, no
 * credential. Kept for `CARD_KEPT_S` per project, a project with none to show among them.
 */
export async function readCard(
  keel: Fetcher,
  origin: string,
  place: Place,
  cache: CardCache | undefined,
  waitMs: number = CARD_WAIT_MS,
): Promise<Card | null> {
  const key = new Request(
    `${origin}/.card/${encodeURIComponent(place.namespace)}/${encodeURIComponent(place.project)}`,
  );
  const kept = await cache?.match(key).catch(() => undefined);
  if (kept !== undefined) return cardOf(place, await kept.json().catch(() => null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const view = await Promise.race([
    keel
      .fetch(
        new Request(
          `${origin}/v1/namespaces/${encodeURIComponent(place.namespace)}/projects/${encodeURIComponent(place.project)}`,
          { headers: { accept: "application/json" } },
        ),
      )
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .catch(() => null),
    new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), waitMs);
    }),
  ]);
  clearTimeout(timer);
  // A Keel too slow to answer is not remembered as having no card: the next crawler asks again.
  if (view === "late") return null;
  await cache
    ?.put(
      key,
      new Response(JSON.stringify(view), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CARD_KEPT_S}` },
      }),
    )
    .catch(() => undefined);
  return cardOf(place, view);
}

/** The tags a card sets, by the attribute each is found by and its value. */
export function tagsOf(
  card: Card,
  url: string,
  image: string,
): { selector: string; content: string }[] {
  return [
    { selector: 'meta[property="og:title"]', content: card.title },
    { selector: 'meta[name="twitter:title"]', content: card.title },
    { selector: 'meta[property="og:description"]', content: card.description },
    { selector: 'meta[name="twitter:description"]', content: card.description },
    { selector: 'meta[name="description"]', content: card.description },
    { selector: 'meta[property="og:url"]', content: url },
    { selector: 'meta[property="og:image"]', content: image },
    { selector: 'meta[name="twitter:image"]', content: image },
  ];
}
