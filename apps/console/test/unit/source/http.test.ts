import { describe, expect, it } from "vitest";
import { changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { createHttpSource } from "../../../src/source/http.ts";
import { createConsole } from "../../../src/worker/handler.ts";
import { createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";
import { showing } from "../showing.ts";

/** A stand-in for Keel's API: serves a log by numeric cursor, and always says where to read next, as Keel's contract has it. */
function fakeKeel(pageSize: number) {
  const log = generateS1(42, "invalidate");
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const serve = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://keel.test",
    );
    calls.push({ url: `${url.pathname}${url.search}`, init });
    if (url.pathname === "/api/v1/events") {
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), pageSize);
      // Published records carry less than the internal envelope.
      const items = log.events
        .slice(start, start + limit)
        .map(({ eventId, type, entity, seq, at, payload, label, project }) => ({
          eventId,
          type,
          entity,
          seq,
          at,
          payload,
          ...(label === undefined ? {} : { label }),
          ...(project === undefined ? {} : { project }),
        }));
      return Promise.resolve(
        Response.json({
          items: [...items, { type: "NotInTheCatalogue", entity: {} }],
          nextCursor: String(start + items.length),
        }),
      );
    }
    if (url.pathname.endsWith("/ruling")) return Promise.resolve(Response.json({ state: "ruled" }));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { log, calls, serve };
}

describe("the HTTP source", () => {
  it("reads the whole log page by page and folds to the same world as the replay", async () => {
    const keel = fakeKeel(7);
    const source = await createHttpSource({ fetch: keel.serve });
    const player = showing(source);
    await player.load();
    player.seek(9_999_000);
    expect(source.descriptor).toMatchObject({ mode: "live", epoch: keel.log.events[0]?.at });
    expect(player.world.trunk).toMatchObject({
      advances: 2,
      changesLanded: 2,
      redCount: 0,
      humansAsked: 1,
    });
    expect(
      [...player.world.conflicts.values()].map((conflict) => [conflict.label, conflict.state]),
    ).toEqual([["C-1", "resolved"]]);
    // Every page was asked for by the cursor the last one returned.
    const cursors = keel.calls
      .filter((call) => call.url.startsWith("/api/v1/events"))
      .map((call) => new URL(call.url, "https://keel.test").searchParams.get("cursor"));
    expect(cursors.slice(0, 4)).toEqual([null, "7", "14", "21"]);
  });

  it("drops records that are not catalogue events instead of guessing at them", async () => {
    const keel = fakeKeel(500);
    const source = await createHttpSource({ fetch: keel.serve });
    const page = await source.readEvents();
    expect(page.items).toHaveLength(keel.log.events.length);
    expect(page.items.map((event): string => event.type)).not.toContain("NotInTheCatalogue");
  });

  it("follows the tail: what arrives later is folded without re-reading what came before", async () => {
    const keel = fakeKeel(500);
    const all = keel.log.events;
    let published = 60;
    let served = 0;
    const serve = (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "https://keel.test",
      );
      if (url.pathname !== "/api/v1/events")
        return Promise.resolve(new Response("not found", { status: 404 }));
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const items = all.slice(cursor, published);
      served += items.length;
      // At the tail the page is empty and its cursor is where the reader already is.
      return Promise.resolve(Response.json({ items, nextCursor: String(cursor + items.length) }));
    };
    const player = showing(await createHttpSource({ fetch: serve }));
    await player.load();
    player.seek(player.end);
    player.play();
    const seenAtFirst = player.world.version;
    expect(player.world.trunk.changesLanded).toBe(0);

    const stop = new AbortController();
    const following = player.follow(stop.signal);
    published = all.length;
    // Give the follower two turns of its loop, then stop it.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    stop.abort();
    await following;
    expect(player.world.version).toBeGreaterThan(seenAtFirst);
    expect(player.world.trunk).toMatchObject({ advances: 2, changesLanded: 2, redCount: 0 });
    // Each event was asked for once: the reader went on from the cursor it was given, and never back.
    expect(served).toBe(all.length);
  });

  it("refuses a page that does not say where to read next, rather than starting again from the beginning", async () => {
    await expect(
      createHttpSource({ fetch: () => Promise.resolve(Response.json({ items: [] })) }),
    ).rejects.toThrow("the page has no cursor");
  });

  it("says plainly what the API cannot give yet", async () => {
    const source = await createHttpSource({ fetch: fakeKeel(500).serve });
    await expect(source.getDiff("chg_01")).rejects.toThrow("no diff endpoint yet");
    await expect(source.readObservations()).resolves.toEqual({ items: [], nextCursor: "" });
  });
});

/** The page's source, talking to the real Worker, which talks to a stand-in Keel. */
function behindTheWorker() {
  const keel = createFakeKeel({
    clients: [
      { id: "observer", secret: "s1", scopes: ["observer"] },
      { id: "operator", secret: "s2", scopes: ["operator"] },
    ],
  });
  const mission = createConsole();
  const requests: Request[] = [];
  const serve = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(
      new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "https://console.test",
      ),
      init,
    );
    requests.push(request.clone());
    return mission.fetch(request, {
      KEEL: keel,
      KEEL_API_HOST: "keel.example",
      ASSETS: { fetch: () => Promise.resolve(new Response("page")) },
      KEEL_OBSERVER_CLIENT_ID: "observer",
      KEEL_OBSERVER_CLIENT_SECRET: "s1",
      KEEL_OPERATOR_CLIENT_ID: "operator",
      KEEL_OPERATOR_CLIENT_SECRET: "s2",
      CONSOLE_CAPABILITY_KEY: "signing key",
      CONSOLE_PRESENTER_KEY: "presenter key",
    });
  };
  const question =
    keel
      .events()
      .flatMap((event) =>
        event.type === "EscalationRaised" ? [event.payload.escalationId] : [],
      )[0] ?? "";
  return { keel, serve, requests, question };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("who the page reads as", () => {
  it("[http.visitor] stands with a closed log for a visitor: no events, no asking again, and no credential sent", async () => {
    const { serve, requests, keel } = behindTheWorker();
    const source = await createHttpSource({ fetch: serve });
    expect(source.descriptor).toMatchObject({ mode: "live", log: "closed" });
    const player = showing(source);
    await player.load();
    expect(player.end).toBe(0);
    expect(player.projects.list).toEqual([]);
    // Following a closed log returns at once, where following an open one waits on its tail.
    await player.follow(new AbortController().signal);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/events",
      "/api/v1/lattices",
    ]);
    expect(requests.filter((request) => request.headers.has("authorization"))).toEqual([]);
    // Keel was asked with no token, and was never asked for one.
    expect(keel.calls.map((call) => `${call.path} ${call.authorization}`)).toEqual([
      "/v1/events ",
      "/v1/lattices ",
    ]);
  });

  it("[http.presenter-reads] shows the presenter's key on every read, and the Worker then reads as the observer", async () => {
    const { serve, requests, keel } = behindTheWorker();
    const source = await createHttpSource({ fetch: serve, presenterKey: "presenter key" });
    expect(source.descriptor.log).toBe("open");
    const player = showing(source);
    await player.load();
    await settled();
    expect(player.projects.list.map((project) => project.name)).toEqual(["demo"]);
    const reads = requests.filter((request) => new URL(request.url).pathname.startsWith("/api/"));
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.map((request) => request.headers.get("authorization"))).toEqual(
      reads.map(() => "Bearer presenter key"),
    );
    expect(
      keel.calls
        .filter((call) => call.path !== "/v1/oauth/token")
        .every((call) => /^Bearer tok_\d+_observer$/.test(call.authorization)),
    ).toBe(true);
  });

  it("[http.key-refused] says the key was refused when it is not the presenter's, and asks Keel nothing", async () => {
    const { serve, keel } = behindTheWorker();
    await expect(createHttpSource({ fetch: serve, presenterKey: "a guess" })).rejects.toThrow(
      "That is not the presenter's key",
    );
    expect(keel.calls).toEqual([]);
  });
});

describe("Keel's read models, from the page", () => {
  it("reads Keel's lattices through the Worker, and draws the conflict's line from them", async () => {
    const { serve } = behindTheWorker();
    const player = showing(await createHttpSource({ fetch: serve, presenterKey: "presenter key" }));
    await player.load();
    await settled();
    expect([...player.lattices.keys()]).toHaveLength(11);
    player.seek(player.end);
    const conflict = [...player.world.conflicts.keys()][0] ?? "";
    expect(conflictPageOf(player.world, conflict, player)?.lattice).toEqual({
      predicate: "freshness",
      values: ["per-call", "per-request", "per-session", "static"],
      standing: "ranked",
    });
  });

  it("reads a verdict's evidence from Keel's view of the verdict: the event carries only references", async () => {
    const { serve, keel } = behindTheWorker();
    const player = showing(await createHttpSource({ fetch: serve, presenterKey: "presenter key" }));
    await player.load();
    player.seek(player.end);
    const issued = keel.events().find((event) => event.type === "VerdictIssued");
    expect(issued?.payload.evidence.every((reference) => typeof reference === "string")).toBe(true);
    const change = issued?.payload.subject ?? "";
    expect(changePageOf(player.world, change, player)?.verdict?.evidence).toEqual([]);
    player.wantVerdict(change);
    await settled();
    const evidence = changePageOf(player.world, change, player)?.verdict?.evidence ?? [];
    expect(evidence.map((item) => item.class)).toEqual([
      "proof",
      "ruling",
      "ruling",
      "proof",
      "testimony",
      "opinion",
    ]);
    expect(evidence[0]?.summary).toBe("Probe P-1 fails in A+B, three runs out of three");
  });
});

describe("ruling, from the page", () => {
  it("only reads when it holds neither the presenter's key nor a capability", async () => {
    const { keel, serve, requests, question } = behindTheWorker();
    const source = await createHttpSource({ fetch: serve });
    expect(source.canRule?.(question)).toBe(false);
    expect(await source.capabilityFor?.(question)).toBeNull();
    await expect(
      source.giveRuling({ escalationId: question, option: "invalidate", idempotencyKey: "k" }),
    ).rejects.toThrow("This console is read-only.");
    expect(keel.events().some((event) => event.type === "RulingGiven")).toBe(false);
    // And it never sends a credential of its own: the Worker holds those.
    expect(requests.filter((request) => request.headers.has("authorization"))).toEqual([]);
  });

  it("with the presenter's key, asks the Worker for a capability and rules through it", async () => {
    const { keel, serve, requests, question } = behindTheWorker();
    const source = await createHttpSource({ fetch: serve, presenterKey: "presenter key" });
    expect(source.canRule?.(question)).toBe(true);
    await source.giveRuling({ escalationId: question, option: "allow-stale", idempotencyKey: "k" });
    expect(keel.events().find((event) => event.type === "RulingGiven")?.payload).toMatchObject({
      option: "allow-stale",
    });
    expect(
      requests.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname.replace(/\/rule\/.+/, "/rule/…")}`,
      ),
    ).toEqual(["GET /api/v1/events", "POST /present/capability", "POST /rule/…"]);
    // The same capability is handed to a phone as long as it is fresh: the Worker is asked once.
    await source.capabilityFor?.(question);
    await source.capabilityFor?.(question);
    expect(
      requests.filter((request) => new URL(request.url).pathname === "/present/capability"),
    ).toHaveLength(1);
  });

  it("opened with a capability, rules on that question and no other, once", async () => {
    const { keel, serve, question } = behindTheWorker();
    const presenter = await createHttpSource({ fetch: serve, presenterKey: "presenter key" });
    const capability = (await presenter.capabilityFor?.(question)) ?? "";
    const phone = await createHttpSource({ fetch: serve, capability });
    expect(phone.canRule?.(question)).toBe(true);
    expect(phone.canRule?.("esc_another")).toBe(false);
    await expect(
      phone.giveRuling({ escalationId: "esc_another", option: "invalidate", idempotencyKey: "k" }),
    ).rejects.toThrow("This console is read-only.");
    await phone.giveRuling({ escalationId: question, option: "no-cache", idempotencyKey: "k" });
    expect(keel.events().find((event) => event.type === "RulingGiven")?.payload).toMatchObject({
      option: "no-cache",
    });
    // The presenter's own tap, after the phone's, finds the question closed. Keel says so, not the page.
    const late = await createHttpSource({ fetch: serve, presenterKey: "presenter key" });
    await expect(
      late.giveRuling({ escalationId: question, option: "invalidate", idempotencyKey: "k" }),
    ).rejects.toThrow("This question has already been answered.");
  });
});
