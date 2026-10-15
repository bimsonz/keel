import { describe, expect, it } from "vitest";
import { type Card, type CardCache, SITE, placeOf, readCard } from "../../../src/worker/cards.ts";
import { type Env, createConsole } from "../../../src/worker/handler.ts";

const ORIGIN = "https://keel.example";
const TWITTER = "Twitterbot/1.0";
const PERSON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

/** The Cache API, as a map: what is put is matched until the test ends. */
function memoryCache(): CardCache & { size: () => number } {
  const kept = new Map<string, Response>();
  return {
    match: (request) => Promise.resolve(kept.get(request.url)?.clone()),
    put: (request, response) => {
      kept.set(request.url, response);
      return Promise.resolve();
    },
    size: () => kept.size,
  };
}

/**
 * The Worker with a stand-in Keel that knows `keel/keel` as public and no other project, and a rewrite that says
 * what it was given: a test of the handler has no HTMLRewriter.
 */
function rig(keelAnswer: (request: Request) => Promise<Response> = knowsKeel) {
  const keel: Request[] = [];
  const retagged: { card: Card; url: string; image: string }[] = [];
  const env: Env = {
    ASSETS: {
      fetch: () =>
        Promise.resolve(new Response("the page", { headers: { "content-type": "text/html" } })),
    },
    KEEL: {
      fetch: (request) => {
        keel.push(request);
        return keelAnswer(request);
      },
    },
  };
  const mission = createConsole({
    cache: memoryCache(),
    retag: (_page, card, url, image) => {
      retagged.push({ card, url, image });
      return new Response(`the page as ${card.title}`);
    },
  });
  return {
    keel,
    retagged,
    ask: (path: string, agent: string, headers: Record<string, string> = {}) =>
      mission.fetch(
        new Request(`${ORIGIN}${path}`, { headers: { "user-agent": agent, ...headers } }),
        env,
      ),
  };
}

function knowsKeel(request: Request): Promise<Response> {
  return Promise.resolve(
    new URL(request.url).pathname === "/v1/namespaces/keel/projects/keel"
      ? Response.json({
          id: "prj_1",
          namespace: { handle: "keel", kind: "org" },
          name: "keel",
          visibility: "public",
        })
      : Response.json({ code: "resource.not_found" }, { status: 404 }),
  );
}

describe("a link's card", () => {
  it("[cards.crawler-only] gives a crawler a project's card from an anonymous read, and a person the page with no read of Keel", async () => {
    const r = rig();
    // A person's request is the page, and Keel is not read for it.
    expect(await (await r.ask("/keel/keel", PERSON)).text()).toBe("the page");
    expect(r.keel).toEqual([]);

    // A crawler's is the project's card, read as anyone reads it: nothing of its request goes with the read.
    const shared = await r.ask("/keel/keel/changes", TWITTER, {
      cookie: "__Secure-keel.session_token=s",
      authorization: "Bearer anything",
    });
    expect(await shared.text()).toBe("the page as keel/keel");
    expect(r.keel.map((asked) => [asked.method, new URL(asked.url).pathname])).toEqual([
      ["GET", "/v1/namespaces/keel/projects/keel"],
    ]);
    expect(r.keel[0]?.headers.get("cookie")).toBeNull();
    expect(r.keel[0]?.headers.get("authorization")).toBeNull();
    // Keel gives a project no description yet: the card says the site's line under the project's place.
    expect(r.retagged).toEqual([
      {
        card: { title: "keel/keel", description: SITE.description },
        url: `${ORIGIN}/keel/keel/changes`,
        image: `${ORIGIN}/og.png`,
      },
    ]);

    // A path that is no project's is the page: a reserved first segment, a namespace alone, a clone address.
    for (const path of ["/orgs/acme/members", "/settings/sessions", "/keel", "/"])
      expect(await (await r.ask(path, TWITTER)).text()).toBe("the page");
    expect(r.keel).toHaveLength(1);
  });

  it("[cards.fallback] serves the site's card where Keel shows no project, and never waits on Keel past its bound", async () => {
    const r = rig();
    // A private project, or none, is no project to an anonymous read: the page, as built.
    expect(await (await r.ask("/acme/secret", TWITTER)).text()).toBe("the page");
    expect(r.retagged).toEqual([]);

    // A Keel that does not answer: the card is given up at the bound.
    const silent = { fetch: () => new Promise<Response>(() => undefined) };
    const started = Date.now();
    expect(
      await readCard(
        silent,
        ORIGIN,
        { namespace: "keel", project: "keel" },
        undefined,
        undefined,
        50,
      ),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(placeOf("/keel/forge.git/info/refs", new Set())).toBeNull();
  });

  it("[cards.kept] reads Keel once for a burst of crawlers on one project, and keeps a project with no card too", async () => {
    const r = rig();
    for (const path of ["/keel/keel", "/keel/keel/changes", "/keel/keel/pipeline"])
      // oxlint-disable-next-line no-await-in-loop -- one crawler after another, as a share fans out
      expect(await (await r.ask(path, TWITTER)).text()).toBe("the page as keel/keel");
    for (let crawler = 0; crawler < 3; crawler += 1)
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await (await r.ask("/acme/secret", TWITTER)).text()).toBe("the page");
    expect(r.keel.map((asked) => new URL(asked.url).pathname)).toEqual([
      "/v1/namespaces/keel/projects/keel",
      "/v1/namespaces/acme/projects/secret",
    ]);
  });

  it("[cards.late-kept] keeps a card Keel brings after the wait for the next crawler, and never keeps Keel's being away", async () => {
    const place = { namespace: "keel", project: "keel" };
    const cache = memoryCache();
    let asked = 0;
    // Keel answers in 100 ms, past a wait of 20.
    const slow = {
      fetch: (request: Request) => {
        asked += 1;
        return new Promise<Response>((resolve) => {
          setTimeout(() => void knowsKeel(request).then(resolve), 100);
        });
      },
    };
    const deferred: Promise<unknown>[] = [];
    expect(
      await readCard(slow, ORIGIN, place, cache, (work) => deferred.push(work), 20),
    ).toBeNull();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    // The next crawler is given what the late read brought, and Keel is not asked again.
    expect(await readCard(slow, ORIGIN, place, cache, undefined, 20)).toEqual({
      title: "keel/keel",
      description: SITE.description,
    });
    expect(asked).toBe(1);

    // Keel away, or a read that fails on the way, is no answer: nothing is kept, and the next asks again.
    const away = memoryCache();
    let tries = 0;
    const struggling = {
      fetch: (): Promise<Response> => {
        tries += 1;
        return tries === 1
          ? Promise.resolve(Response.json({ code: "service.unavailable" }, { status: 503 }))
          : Promise.reject(new Error("dropped"));
      },
    };
    expect(await readCard(struggling, ORIGIN, place, away)).toBeNull();
    expect(await readCard(struggling, ORIGIN, place, away)).toBeNull();
    expect([tries, away.size()]).toEqual([2, 0]);
  });
});
