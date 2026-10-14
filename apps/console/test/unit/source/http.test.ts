import { describe, expect, it } from "vitest";
import type { ProjectView } from "../../../src/contract/keel/index.ts";
import { heldUnder } from "../../../src/engine/holder.ts";
import { Player } from "../../../src/engine/player.ts";
import { type RepoAddress, repositoryOf } from "../../../src/engine/repository.ts";
import { changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { createHttpDirectory, createHttpSource } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import {
  MAINTAINERS_AFTER_MS,
  PUBLIC_REPOSITORY,
  type Role,
  SESSION_COOKIE,
  createFakeKeel,
} from "../../fixtures/mock/fakeKeel.ts";
import { S1_CHOICES, generateS1 } from "../../fixtures/mock/s1.ts";

const ORIGIN = "https://keel.example";

const addressOf = (input: RequestInfo | URL): URL =>
  new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ORIGIN,
  );

/** A stand-in for Keel's log: served by numeric cursor, always saying where to read next, as Keel's contract has it. */
function fakeLog(pageSize: number) {
  const log = generateS1(42, "invalidate");
  const created = log.events.find((event) => event.type === "ProjectCreated");
  const project: ProjectView = {
    id: created?.payload.projectId ?? "",
    namespace: { handle: "acme", kind: "org" },
    name: "demo",
    visibility: "private",
    createdAt: created?.at ?? "",
  };
  const calls: URL[] = [];
  const serve = (input: RequestInfo | URL): Promise<Response> => {
    const url = addressOf(input);
    calls.push(url);
    if (url.pathname === "/v1/events") {
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), pageSize);
      // Published records carry less than the internal envelope.
      const items = log.events
        .slice(start, start + limit)
        .map(({ eventId, type, entity, seq, at, payload, label, project: stamped }) => ({
          eventId,
          type,
          entity,
          seq,
          at,
          payload,
          ...(label === undefined ? {} : { label }),
          ...(stamped === undefined ? {} : { project: stamped }),
        }));
      return Promise.resolve(
        Response.json({
          items: [...items, { type: "NotInTheCatalogue", entity: {} }],
          nextCursor: String(start + items.length),
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { log, project, calls, serve };
}

describe("the HTTP source", () => {
  it("[http.by-project] reads the project's own log page by page and folds to the same world as the replay", async () => {
    const keel = fakeLog(7);
    const source = createHttpSource(keel.project, { fetch: keel.serve });
    expect(source.descriptor).toEqual({ mode: "live", project: keel.project });
    const player = new Player(source);
    await player.load();
    player.seek(9_999_000);
    expect(player.world.trunk).toMatchObject({
      advances: 2,
      changesLanded: 2,
      redCount: 0,
      humansAsked: 1,
    });
    expect(
      [...player.world.conflicts.values()].map((conflict) => [conflict.label, conflict.state]),
    ).toEqual([["C-1", "resolved"]]);
    // Every page was asked for by the cursor the last one returned, and each by the project's id: the log
    // read is that project's and no other's.
    const reads = keel.calls.filter((call) => call.pathname === "/v1/events");
    expect(reads.slice(0, 4).map((call) => call.searchParams.get("cursor"))).toEqual([
      null,
      "7",
      "14",
      "21",
    ]);
    expect(new Set(reads.map((call) => call.searchParams.get("project")))).toEqual(
      new Set([keel.project.id]),
    );
  });

  it("drops records that are not catalogue events instead of guessing at them", async () => {
    const keel = fakeLog(500);
    const page = await createHttpSource(keel.project, { fetch: keel.serve }).readEvents();
    expect(page.items).toHaveLength(keel.log.events.length);
    expect(page.items.map((event): string => event.type)).not.toContain("NotInTheCatalogue");
  });

  it("follows the tail: what arrives later is folded without re-reading what came before", async () => {
    const keel = fakeLog(500);
    const all = keel.log.events;
    let published = 60;
    let served = 0;
    const serve = (input: RequestInfo | URL): Promise<Response> => {
      const url = addressOf(input);
      if (url.pathname !== "/v1/events")
        return Promise.resolve(new Response("not found", { status: 404 }));
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const items = all.slice(cursor, published);
      served += items.length;
      // At the tail the page is empty and its cursor is where the reader already is.
      return Promise.resolve(Response.json({ items, nextCursor: String(cursor + items.length) }));
    };
    const player = new Player(createHttpSource(keel.project, { fetch: serve }));
    expect(player.loaded).toBe(false);
    await player.load();
    expect(player.loaded).toBe(true);
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
    const source = createHttpSource(fakeLog(1).project, {
      fetch: () => Promise.resolve(Response.json({ items: [] })),
    });
    await expect(source.readEvents()).rejects.toThrow("the page has no cursor");
  });

  it("says plainly what the API cannot give yet", async () => {
    const keel = fakeLog(500);
    const source = createHttpSource(keel.project, { fetch: keel.serve });
    await expect(source.getDiff("chg_01")).rejects.toThrow("no diff endpoint yet");
    await expect(source.readObservations()).resolves.toEqual({ items: [], nextCursor: "" });
  });
});

type Who = Role | "stranger" | "visitor";

/** The people the stand-in Keel knows by a session, each of whom has their own namespace. */
const PEOPLE: ReadonlySet<string> = new Set(["owner", "maintainer", "member", "stranger"]);

/**
 * The page reading the stand-in Keel as `who`. The browser's part is played here: it sends the session's cookie
 * to its own origin, and says which page a request that changes something came from. What the page's own code
 * put on a request is kept apart, in `fromThePage`.
 */
function reading(
  who: Who,
  visibility: "public" | "private" = "private",
  ahead = 0,
  /**
   * Who the question's agent names, where it names anyone, Keel's clock, the agents that signed themselves up,
   * and which story the project's log tells.
   */
  put: {
    sponsor?: Role;
    now?: () => number;
    signedUp?: Record<string, string>;
    story?: "s1" | "s2";
    imported?: { url: string; ref: string; head: string; diverged?: boolean };
  } = {},
) {
  const keel = createFakeKeel({
    visibility,
    ahead,
    // Each person signed in has a namespace of their own, at a handle that is their session's name.
    whose: (handle) => (PEOPLE.has(handle) ? { id: handle, kind: "user" } : undefined),
    sessions: { owner: "owner", maintainer: "maintainer", member: "member", stranger: "stranger" },
    ...put,
  });
  const fromThePage: Request[] = [];
  const serve: typeof fetch = (input, init) => {
    const asked = new Request(addressOf(input), init);
    fromThePage.push(asked.clone());
    const headers = new Headers(asked.headers);
    if (who !== "visitor") headers.set("cookie", `${SESSION_COOKIE}=${who}`);
    if (asked.method !== "GET") headers.set("origin", ORIGIN);
    return keel.fetch(new Request(asked, { headers }));
  };
  const question =
    keel
      .events()
      .flatMap((event) =>
        event.type === "EscalationRaised" ? [event.payload.escalationId] : [],
      )[0] ?? "";
  return { keel, serve, fromThePage, question, directory: createHttpDirectory({ fetch: serve }) };
}

/** What Keel answered a start: the project's address and who may read it, or its refusal as a page is handed it. */
const started = (
  directory: ReturnType<typeof reading>["directory"],
  asked: Parameters<ReturnType<typeof reading>["directory"]["createProject"]>[0],
  key: string,
) =>
  directory.createProject(asked, key).then(
    (made) => `${made.namespace.handle}/${made.name} ${made.visibility} ${made.viewer?.role}`,
    (error: unknown) =>
      error instanceof KeelRefused
        ? { status: error.status, code: error.code, said: error.message, next: [...error.next] }
        : String(error),
  );
const PRIVATE_SOURCE = {
  status: 403,
  code: "auth.forbidden",
  said: "Refused: private-source.",
  next: [
    "A private project forks only into its own namespace; ask whoever maintains it to make it public",
  ],
};

/** The project as `who` is shown it, with a playhead on it. */
async function opened(
  who: Who,
  visibility: "public" | "private" = "private",
  ahead = 0,
  put: Parameters<typeof reading>[3] = {},
) {
  const r = reading(who, visibility, ahead, put);
  const found = await r.directory.findProject("acme", "demo");
  if (found === null) throw new Error("Keel showed this reader no such project");
  const source = createHttpSource(found, { fetch: r.serve });
  return { ...r, found, source, player: new Player(source) };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("who the page reads as", () => {
  it("[http.visitor] is shown a public project and its log as a visitor, and a private one is to a visitor as none", async () => {
    const shut = reading("visitor");
    expect(await shut.directory.findProject("acme", "demo")).toBeNull();
    expect(await shut.directory.listProjects()).toEqual([]);
    // No such project, and a project in another namespace of the same name, are the same answer.
    expect(await shut.directory.findProject("acme", "no-such")).toBeNull();

    const open = await opened("visitor", "public");
    expect(open.found).toMatchObject({
      namespace: { handle: "acme", kind: "org" },
      name: "demo",
      visibility: "public",
    });
    expect(open.found.viewer).toBeUndefined();
    expect(await open.directory.listProjects()).toMatchObject([
      { namespace: { handle: "acme" }, name: "demo" },
    ]);
    await open.player.load();
    await settled();
    open.player.seek(open.player.end);
    expect(open.player.world.conflicts.size).toBe(1);
    expect(open.player.unread).toBe(0);
    expect(open.source.canRule?.(open.question)).toBe(false);
  });

  it("[http.audience] is read the public part of a public project's log as a visitor: no question, no ruling and no agent's enrolment", async () => {
    const visitor = await opened("visitor", "public");
    await visitor.player.load();
    visitor.player.seek(visitor.player.end);
    const member = await opened("member", "public");
    await member.player.load();
    member.player.seek(member.player.end);
    // The member is read all of it.
    expect(member.player.world.escalations.size).toBe(1);
    expect(member.player.world.agents.size).toBeGreaterThan(0);
    // The visitor is read the changes and the conflict, which says it waits on a ruling, and nothing of the rest.
    expect(visitor.player.world.changes.size).toBe(member.player.world.changes.size);
    expect([...visitor.player.world.conflicts.values()].map((conflict) => conflict.state)).toEqual([
      "escalated",
    ]);
    expect(visitor.player.world.escalations.size).toBe(0);
    expect(visitor.player.world.agents.size).toBe(0);
    expect(visitor.player.unread).toBe(0);
    // Someone signed in who is no member of the project's org is read what a visitor is.
    const stranger = await opened("stranger", "public");
    await stranger.player.load();
    stranger.player.seek(stranger.player.end);
    expect(stranger.player.world.escalations.size).toBe(0);
  });

  it("[http.agents] names a change's holder to a visitor by Keel's card, each card asked for once, and its run from the log", async () => {
    const visitor = await opened("visitor", "public", 0, { signedUp: { "Agent A": "tidy-otter" } });
    await visitor.player.load();
    visitor.player.seek(visitor.player.end);
    const { world, cards } = visitor.player;
    const idOf = (name: string): string =>
      visitor.keel
        .events()
        .flatMap((event) =>
          event.type === "AgentEnrolled" && event.payload.name === name
            ? [event.payload.agentId]
            : [],
        )[0] ?? "";
    const held = (agentId: string) => {
      const change = [...world.changes.values()].find((each) => each.agentId === agentId);
      return change === undefined ? undefined : heldUnder(cards, change);
    };
    // The log names each agent by its id alone: a visitor is read no enrolment, and no sign-up is in the log.
    expect(world.agents.size).toBe(0);
    // The run Keel wrote on an agent's entries reached the fold; the other agent's token named none.
    expect([held(idOf("Agent A"))?.run?.label, held(idOf("Agent B"))?.run]).toEqual([
      "collab-revocation",
      undefined,
    ]);
    const ids = [...world.work.keys()];
    visitor.player.wantCards(ids);
    visitor.player.wantCards(ids);
    await settled();
    // One that signed itself up has its handle, where its own page is. One a member enrolled has none.
    expect(held(idOf("Agent A"))?.handle).toBe("tidy-otter");
    expect(held(idOf("Agent B"))).not.toHaveProperty("handle");
    // No project's log holds an enrolment of an agent that signed itself up: a member is read Agent B's alone.
    const member = await opened("member", "public", 0, { signedUp: { "Agent A": "tidy-otter" } });
    await member.player.load();
    member.player.seek(member.player.end);
    expect([...member.player.world.agents.values()].map((enrolled) => enrolled.name)).toEqual([
      "Agent B",
    ]);
    // Each card was asked for once, by the agent's id, with nothing of the page's own on the request.
    const asked = visitor.fromThePage.filter((request) =>
      new URL(request.url).pathname.startsWith("/v1/agents/"),
    );
    expect(asked.map((request) => new URL(request.url).pathname).toSorted()).toEqual(
      ids.map((id) => `/v1/agents/${id}`).toSorted(),
    );
    expect(asked.map((request) => request.headers.get("authorization"))).toEqual([null, null]);
  });

  it("[new.call] makes a project by Keel's own operation: the attempt's key in its header, whose, what name and how it starts as the body, and no credential of the page's", async () => {
    const r = reading("member");
    const made = await r.directory.createProject(
      { namespace: "acme", name: "Notes", source: { kind: "empty" } },
      "console:new:key-one",
    );
    // Keel answers the project as it made it: under the name in its own case, private, with the maker's role.
    expect(made).toMatchObject({
      namespace: { handle: "acme", kind: "org" },
      name: "notes",
      visibility: "private",
      viewer: { role: "member" },
    });
    const sent = r.fromThePage.filter((request) => request.method === "POST");
    expect(sent.map((request) => new URL(request.url).pathname)).toEqual(["/v1/projects"]);
    expect(sent[0]?.headers.get("idempotency-key")).toBe("console:new:key-one");
    expect(sent[0]?.headers.get("authorization")).toBeNull();
    expect(await sent[0]?.json()).toEqual({
      namespace: "acme",
      name: "Notes",
      source: { kind: "empty" },
    });
    // It is there at once: found at its address, and among the projects Keel lists its maker.
    expect(await r.directory.findProject("acme", "notes")).toMatchObject({ id: made.id });
    expect((await r.directory.listProjects()).map((project) => project.name)).toEqual([
      "demo",
      "notes",
    ]);
  });

  it("[new.refused] gives Keel's refusal of a start in Keel's own words with the way forward it names, and makes nothing", async () => {
    const r = reading("member");
    let attempt = 0;
    const tried = (
      from: ReturnType<typeof reading>,
      asked: Parameters<typeof r.directory.createProject>[0],
    ) => {
      attempt += 1;
      return from.directory.createProject(asked, `console:new:attempt-${attempt}`).then(
        () => "made",
        (error: unknown) =>
          error instanceof KeelRefused
            ? { status: error.status, code: error.code, said: error.message, next: [...error.next] }
            : String(error),
      );
    };
    const empty = { kind: "empty" } as const;
    // A name the namespace has, in any case.
    expect(await tried(r, { namespace: "acme", name: "Demo", source: empty })).toEqual({
      status: 409,
      code: "project.name_taken",
      said: 'acme already has a project named "demo" (names ignore letter case).',
      next: ["Choose another name"],
    });
    // An address no public repository answers at: a private one reads the same.
    expect(
      await tried(r, {
        namespace: "acme",
        name: "forge",
        source: { kind: "import", url: "https://git.example/acme/private" },
      }),
    ).toEqual({
      status: 404,
      code: "project.import_refused",
      said: "No public repository answers at that URL. A private one reads the same. Nothing was imported, and no project was made (not-found).",
      next: ["Check the URL names a public repository, then create the project again"],
    });
    // An address Keel will not import from at all.
    expect(
      await tried(r, {
        namespace: "acme",
        name: "forge",
        source: { kind: "import", url: "http://git.example/acme/forge-lite" },
      }),
    ).toEqual({
      status: 400,
      code: "request.invalid",
      said: "The import's url must begin with https:// (not-https).",
      next: ["Correct the import's url, then create the project again"],
    });
    // A namespace nobody has, a signed-in person who is no member of the namespace, and a visitor.
    expect(await tried(r, { namespace: "nobody", name: "notes", source: empty })).toMatchObject({
      status: 404,
      code: "resource.not_found",
    });
    expect(
      await tried(reading("stranger"), { namespace: "acme", name: "notes", source: empty }),
    ).toEqual({
      status: 403,
      code: "auth.forbidden",
      said: "Refused: role.",
      next: ["Ask a member: this needs that role"],
    });
    expect(
      await tried(reading("visitor"), { namespace: "acme", name: "notes", source: empty }),
    ).toMatchObject({ status: 401, code: "auth.required" });
    // Nothing was made by any of them.
    expect((await r.directory.listProjects()).map((project) => project.name)).toEqual(["demo"]);
    expect(await r.directory.findProject("acme", "forge")).toBeNull();
  });

  it("[new.again] finishes the same project when the same request is asked again under its key, and is refused an old key for another request", async () => {
    const r = reading("member");
    const asked = {
      namespace: "acme",
      name: "forge",
      source: { kind: "import", url: PUBLIC_REPOSITORY, ref: "main" },
    } as const;
    const first = await r.directory.createProject(asked, "console:new:the-same");
    const second = await r.directory.createProject(asked, "console:new:the-same");
    expect(second.id).toBe(first.id);
    expect((await r.directory.listProjects()).map((project) => project.name)).toEqual([
      "demo",
      "forge",
    ]);
    await expect(
      r.directory.createProject({ ...asked, name: "forge-2" }, "console:new:the-same"),
    ).rejects.toMatchObject({
      code: "request.idempotency_conflict",
      message: "Idempotency-Key console:new:the-same was used for a different project.",
      next: ["Call again with a fresh Idempotency-Key"],
    });
  });

  it("[fork.call] forks a project by Keel's own operation, naming the source by Keel's id for it, and the fork is private whoever may read its source", async () => {
    // Someone signed in who is no member reads a public project, and forks it into their own namespace.
    const r = reading("stranger", "public");
    const source = await r.directory.findProject("acme", "demo");
    expect(source).toMatchObject({ visibility: "public" });
    const asked = {
      namespace: "stranger",
      name: "demo",
      source: { kind: "fork", project: source?.id ?? "" },
    } as const;
    expect(await started(r.directory, asked, "console:new:fork-one")).toBe(
      "stranger/demo private owner",
    );
    const sent = r.fromThePage.filter((request) => request.method === "POST");
    expect(sent.map((request) => new URL(request.url).pathname)).toEqual(["/v1/projects"]);
    expect(await sent[0]?.json()).toEqual(asked);
    expect(sent[0]?.headers.get("authorization")).toBeNull();
    // The fork is found at its own address by whoever made it, and the source is as it was.
    expect(await r.directory.findProject("stranger", "demo")).toMatchObject({
      visibility: "private",
    });
    expect(await r.directory.findProject("acme", "demo")).toMatchObject({ id: source?.id });
  });

  it("[fork.source-named] names a fork's source on the answer to its making and on its own read, to a reader Keel reads the source, and in no list", async () => {
    const r = reading("stranger", "public");
    const source = await r.directory.findProject("acme", "demo");
    const from = { id: source?.id, namespace: "acme", name: "demo" };
    const made = await r.directory.createProject(
      { namespace: "stranger", name: "mine", source: { kind: "fork", project: source?.id ?? "" } },
      "console:new:fork-named",
    );
    expect(made.forkedFrom).toEqual(from);
    expect((await r.directory.findProject("stranger", "mine"))?.forkedFrom).toEqual(from);
    // A fork of the fork names the fork, which is its maker's to read, and not the project that one came from.
    const again = await r.directory.createProject(
      { namespace: "stranger", name: "again", source: { kind: "fork", project: made.id } },
      "console:new:fork-again",
    );
    expect(again.forkedFrom).toEqual({ id: made.id, namespace: "stranger", name: "mine" });
    // The list names no source, and a project that is no fork has none anywhere.
    for (const listed of await r.directory.listProjects())
      expect(listed).not.toHaveProperty("forkedFrom");
    expect(source).not.toHaveProperty("forkedFrom");
    const plain = await r.directory.createProject(
      { namespace: "stranger", name: "plain", source: { kind: "empty" } },
      "console:new:plain",
    );
    expect(plain).not.toHaveProperty("forkedFrom");
    // Its source is made private: the fork is still its maker's, and names no project they are not read.
    const kept = `${ORIGIN}/v1/projects/${source?.id}/settings`;
    const asOwner = { cookie: `${SESSION_COOKIE}=owner`, origin: ORIGIN };
    const whole: unknown = await (
      await r.keel.fetch(new Request(kept, { headers: asOwner }))
    ).json();
    if (typeof whole !== "object" || whole === null)
      throw new Error("the stand-in read no settings");
    const settings = await r.keel.fetch(
      new Request(kept, {
        method: "PUT",
        headers: { ...asOwner, "content-type": "application/json" },
        body: JSON.stringify({ ...whole, visibility: "private" }),
      }),
    );
    expect(settings.status).toBe(200);
    expect(await r.directory.findProject("acme", "demo")).toBeNull();
    const after = await r.directory.findProject("stranger", "mine");
    expect(after).toMatchObject({ name: "mine" });
    expect(after).not.toHaveProperty("forkedFrom");
  });

  it("[fork.private] forks a private project only into its own namespace, and says Keel's rule with its way forward anywhere else", async () => {
    const r = reading("member");
    const source = await r.directory.findProject("acme", "demo");
    expect(source).toMatchObject({ visibility: "private" });
    const fork = { kind: "fork", project: source?.id ?? "" } as const;
    // Into the reader's own namespace: refused, though they may read the source and make projects there.
    expect(
      await started(
        r.directory,
        { namespace: "member", name: "demo", source: fork },
        "console:new:f1",
      ),
    ).toEqual(PRIVATE_SOURCE);
    expect(await r.directory.findProject("member", "demo")).toBeNull();
    // Into its own namespace, under a name that namespace does not have: made, and private.
    expect(
      await started(
        r.directory,
        { namespace: "acme", name: "demo-2", source: fork },
        "console:new:f2",
      ),
    ).toBe("acme/demo-2 private member");
    // Under the name the source has there: Keel's answer for a name taken, as for any start.
    expect(
      await started(
        r.directory,
        { namespace: "acme", name: "Demo", source: fork },
        "console:new:f3",
      ),
    ).toMatchObject({ status: 409, code: "project.name_taken", next: ["Choose another name"] });
    // The fork made is its maker's to fork again, into its own namespace, and no other.
    const again = await r.directory.findProject("acme", "demo-2");
    expect(
      await started(
        r.directory,
        { namespace: "member", name: "mine", source: { kind: "fork", project: again?.id ?? "" } },
        "console:new:f4",
      ),
    ).toEqual(PRIVATE_SOURCE);
  });

  it("[fork.unseen] answers a source its reader is not read as no project at all, after saying whether the namespace is theirs to make one in", async () => {
    // A private project, to someone who is no member: Keel has no such project, into their own namespace too.
    const stranger = reading("stranger");
    const member = reading("member");
    const id = (await member.directory.findProject("acme", "demo"))?.id ?? "";
    expect(id).toMatch(/^prj_/);
    const fork = { kind: "fork", project: id } as const;
    expect(
      await started(
        stranger.directory,
        { namespace: "stranger", name: "demo", source: fork },
        "console:new:u1",
      ),
    ).toMatchObject({ status: 404, code: "resource.not_found", next: [] });
    // The namespace is decided first: one they are no member of is refused as that, whatever the source.
    expect(
      await started(
        stranger.directory,
        { namespace: "acme", name: "demo-2", source: fork },
        "console:new:u2",
      ),
    ).toEqual({
      status: 403,
      code: "auth.forbidden",
      said: "Refused: role.",
      next: ["Ask a member: this needs that role"],
    });
    // An id Keel has no project under, and something that is no id of Keel's.
    expect(
      await started(
        member.directory,
        {
          namespace: "acme",
          name: "demo-3",
          source: { kind: "fork", project: "prj_00000000000000000000000000" },
        },
        "console:new:u3",
      ),
    ).toMatchObject({ status: 404, code: "resource.not_found" });
    expect(
      await started(
        member.directory,
        { namespace: "acme", name: "demo-3", source: { kind: "fork", project: "acme/demo" } },
        "console:new:u4",
      ),
    ).toMatchObject({ status: 400, code: "request.invalid" });
    // A visitor forks nothing.
    expect(
      await started(
        reading("visitor", "public").directory,
        { namespace: "acme", name: "demo-2", source: fork },
        "console:new:u5",
      ),
    ).toMatchObject({ status: 401, code: "auth.required" });
    expect((await member.directory.listProjects()).map((project) => project.name)).toEqual([
      "demo",
    ]);
  });

  it("[http.namespace] finds a project under its own namespace and under no other", async () => {
    const r = reading("owner");
    expect(await r.directory.findProject("acme", "demo")).toMatchObject({ name: "demo" });
    expect(await r.directory.findProject("other", "demo")).toBeNull();
    // It is asked for at the namespace's handle, and at no address of an org's.
    expect(r.keel.calls.map((call) => call.path)).toEqual([
      "/v1/namespaces/acme/projects/demo",
      "/v1/namespaces/other/projects/demo",
    ]);
  });

  it("[http.whose] asks Keel whose a handle is, as anyone may, and reads a handle nobody has as none", async () => {
    // A visitor is answered about a private project's namespace too: that a handle is someone's is no secret.
    const r = reading("visitor");
    expect(await r.directory.findNamespace("acme")).toEqual({
      id: "org_0000000000000000000000ACME",
      handle: "acme",
      kind: "org",
    });
    expect(await r.directory.findNamespace("nobody")).toBeNull();
    expect(r.keel.calls.map((call) => `${call.path} ${call.authorization}`)).toEqual([
      "/v1/namespaces/acme ",
      "/v1/namespaces/nobody ",
    ]);
  });

  it("[http.member] reads a private project as a member of its org, with the role Keel says they have", async () => {
    const { found, player, source, question, directory } = await opened("maintainer");
    expect(found).toMatchObject({ visibility: "private", viewer: { role: "maintainer" } });
    expect(await directory.listProjects()).toHaveLength(1);
    await player.load();
    player.seek(player.end);
    expect(player.projects.list.map((project) => project.name)).toEqual(["demo"]);
    expect(player.world.conflicts.size).toBe(1);
    expect(source.canRule?.(question)).toBe(true);
    // Someone signed in who is no member of the project's namespace is shown nothing of it.
    expect(await reading("stranger").directory.findProject("acme", "demo")).toBeNull();
  });

  it("[http.page-sends-nothing] puts no credential of its own on anything it asks, whoever is reading", async () => {
    for (const who of ["visitor", "owner"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two readers, one after the other
      const { player, source, question, fromThePage, keel } = await opened(who, "public");
      // oxlint-disable-next-line no-await-in-loop -- as above
      await player.load();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await source.getTree(keel.project.id, { path: "" });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await source
        .giveRuling({ escalationId: question, option: "invalidate", idempotencyKey: "k" })
        .catch(() => undefined);
      expect(fromThePage.length).toBeGreaterThan(4);
      expect(
        fromThePage.filter(
          (request) => request.headers.has("authorization") || request.headers.has("cookie"),
        ),
      ).toEqual([]);
      expect(keel.calls.every((call) => call.authorization === "")).toBe(true);
      // Everything asked is Keel's own, under /v1 on the page's origin.
      expect(fromThePage.every((request) => request.url.startsWith(`${ORIGIN}/v1/`))).toBe(true);
    }
  });
});

describe("a project's code, from the page", () => {
  it("[http.repo-visitor] reads a public project's code for a visitor, and is told there is none where it is private", async () => {
    const { source: visitor, keel } = await opened("visitor", "public");
    const { id } = keel.project;
    const root = await visitor.getTree(id, { path: "" });
    expect(root.entries.map((entry) => entry.name).toSorted()).toEqual([
      "README.md",
      "package.json",
      "src",
    ]);
    expect((await visitor.getBlob(id, { path: "README.md" })).content).toContain("#");
    const history = await visitor.getCommits(id, { limit: 1 });
    expect(history.items).toHaveLength(1);
    expect((await visitor.getCommit(id, history.items[0]?.sha ?? "")).commit.sha).toBe(
      history.items[0]?.sha,
    );
    // A file's path read as a directory is refused by Keel's own code for it.
    await expect(visitor.getTree(id, { path: "README.md" })).rejects.toMatchObject({
      code: "repo.path_not_found",
    });

    // Someone who has a private project's id all the same is told what Keel tells anyone it does not show it to.
    const shut = reading("visitor");
    const outsider = createHttpSource(shut.keel.project, { fetch: shut.serve });
    await expect(outsider.getTree(shut.keel.project.id, { path: "" })).rejects.toMatchObject({
      code: "resource.not_found",
      status: 404,
    });
  });

  it("[http.code-first] shows a member a private project's code before any of its log is read, at the project's main", async () => {
    const { player, fromThePage } = await opened("member");
    const look = async (address: RepoAddress) => {
      for (let turn = 0; turn < 6; turn += 1) {
        player.repository.want(address, player.world.trunk.head);
        // oxlint-disable-next-line no-await-in-loop -- each read says what to read next
        await settled();
      }
      return repositoryOf(player.world, player.repository, address);
    };
    const code = await look({ view: "code", path: "" });
    expect(code).toMatchObject({
      status: "ready",
      project: { name: "demo", visibility: "private" },
      ref: { head: true },
      view: { kind: "tree" },
    });
    expect(player.loaded).toBe(false);
    const asked = fromThePage.map((request) => new URL(request.url));
    expect(asked.map((url) => url.pathname)).not.toContain("/v1/events");
    // Nothing has said where trunk is yet, so no read names a ref, and Keel reads the project's `main`.
    const reads = asked.filter((url) => url.pathname.includes("/repo/"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((url) => url.searchParams.has("ref"))).toEqual([]);
    const atMain = code.status === "ready" ? code.ref.sha : "";

    // Once the log is read, trunk's head is the log's, and what was read at `main` is that commit.
    await player.load();
    player.seek(player.end);
    expect(player.world.trunk.head).toBe(atMain);
    // Trunk is where Keel read `main`, so what was read stands: the log's word for it costs Keel no second read.
    const readSoFar = fromThePage.length;
    expect(await look({ view: "code", path: "" })).toMatchObject({
      status: "ready",
      ref: { sha: atMain, head: true },
      view: { kind: "tree" },
    });
    expect(fromThePage.slice(readSoFar).map((request) => new URL(request.url).pathname)).toEqual(
      [],
    );
    const file = await look({ view: "code", path: "src/authz/check.ts" });
    expect(file).toMatchObject({ status: "ready", view: { kind: "file", notes: [] } });
    const history = await look({ view: "history", path: "" });
    expect(
      history.status === "ready" && history.view.kind === "history" && history.view.commits,
    ).toMatchObject([{ height: 0, message: "Start of trunk", changes: [] }]);
  });
});

describe("Keel's read models, from the page", () => {
  it("reads Keel's lattices, and draws the conflict's line from them", async () => {
    const { player } = await opened("member");
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

  it("[http.empty-pages] reads a project whose entries lie behind other projects' in the instance's log: an empty page whose cursor moved is not the log's end", async () => {
    // 1,200 entries of other projects come first. Keel answers each stretch of them with no items and a cursor
    // that has moved on, as keel.town does for every project but the first.
    const { player, keel } = await opened("visitor", "public", 1200);
    await player.load();
    player.seek(player.end);
    expect(player.world.changes.size).toBe(2);
    expect(player.world.conflicts.size).toBe(1);
    const asked = keel.calls.filter((call) => call.path === "/v1/events").map((call) => call.query);
    expect(asked.slice(0, 4).map((query) => new URLSearchParams(query).get("cursor"))).toEqual([
      null,
      "500",
      "1000",
      "1200",
    ]);
    // Reading what is already there waits for nothing.
    expect(asked.filter((query) => query.includes("wait="))).toEqual([]);
  });

  it("[probe.source] reads a probe's source from Keel when its conflict is looked at, file by file, with nothing of the page's own on the request", async () => {
    const { player, keel, found, fromThePage } = await opened("visitor", "public");
    await player.load();
    player.seek(player.end);
    const conflict = [...player.world.conflicts.keys()][0] ?? "";
    const probe = (): NonNullable<ReturnType<typeof conflictPageOf>>["probe"] =>
      conflictPageOf(player.world, conflict, player)?.probe;
    // Nothing is asked for until someone looks, and the page says it has not been read.
    expect(keel.calls.filter((call) => call.path.startsWith("/v1/probes/"))).toEqual([]);
    expect(probe()).toMatchObject({ label: "P-1", source: "unread" });

    player.wantProbe(probe()?.id ?? "");
    player.wantProbe(probe()?.id ?? "");
    await settled();
    expect(probe()?.source).toEqual([
      {
        path: "probes/authz.permission-evaluation/freshness.probe.ts",
        text: expect.stringContaining("probe("),
      },
    ]);
    // Asked once, by Keel's own operation: the probe in the path and its project beside it.
    expect(
      keel.calls
        .filter((call) => call.path.startsWith("/v1/probes/"))
        .map((call) => [call.method, call.path, call.query, call.authorization]),
    ).toEqual([["GET", `/v1/probes/${probe()?.id ?? ""}/source`, `project=${found.id}`, ""]]);
    expect(
      fromThePage.filter(
        (asked) => asked.headers.has("authorization") || asked.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[probe.refused] says Keel did not give a probe's source where it refuses, and shows none", async () => {
    const r = reading("visitor", "public");
    const found = await r.directory.findProject("acme", "demo");
    if (found === null) throw new Error("Keel showed this reader no such project");
    const source = createHttpSource(found, {
      fetch: (input, init) =>
        addressOf(input).pathname.startsWith("/v1/probes/")
          ? Promise.resolve(
              Response.json(
                { code: "resource.not_found", title: "No such resource" },
                { status: 404 },
              ),
            )
          : r.serve(input, init),
    });
    const player = new Player(source);
    await player.load();
    player.seek(player.end);
    const conflict = [...player.world.conflicts.keys()][0] ?? "";
    player.wantProbe(conflictPageOf(player.world, conflict, player)?.probe?.id ?? "");
    await settled();
    expect(conflictPageOf(player.world, conflict, player)?.probe?.source).toBe("refused");
    await expect(source.getProbeSource("prb_none")).rejects.toMatchObject({
      name: "KeelRefused",
      status: 404,
    });
  });

  it("[http.verdict-plan] reads the plan a verdict was issued under from Keel's view of it, each line of its evidence under the step it names", async () => {
    // Nine days on, a careless change has bounced on its batch's verdict. The verdict names the batch, and the
    // bounce ties it to the change. The verdict's event carries the lines of its evidence and the plan's hash.
    const { player, keel } = await opened("member", "private", 0, { story: "s2" });
    await player.load();
    player.seek(player.end);
    const bounced = keel.events().findLast((event) => event.type === "ChangeBounced");
    const { changeId: change = "", verdictId } =
      bounced?.type === "ChangeBounced" ? bounced.payload : {};
    const issued = keel
      .events()
      .flatMap((event) =>
        event.type === "VerdictIssued" && event.payload.verdictId === verdictId
          ? [event.payload]
          : [],
      )[0];
    const unread = changePageOf(player.world, change, player)?.verdict;
    expect(unread?.evidence).toEqual([]);
    expect(unread?.plan).toBeUndefined();
    player.wantVerdict(change);
    await settled();
    const verdict = changePageOf(player.world, change, player)?.verdict;
    // The plan the change compiled at Precheck: Keel runs a batch of one on its member's plan.
    expect(verdict?.plan?.hash).toBe(issued?.planHash);
    expect(verdict?.plan?.own).toBe(true);
    const [suite, typecheck, guard] = verdict?.plan?.steps ?? [];
    expect([suite?.id, typecheck?.id, guard?.id?.replace(/grd_\w+/, "<guard>")]).toEqual([
      "js-ts.suite",
      "worker-app.typecheck",
      "guard:<guard>",
    ]);
    // Only what failed is described on a bounce: both lines name the guard, and none is left without a step.
    expect(suite?.lines).toEqual([]);
    expect(guard?.lines).toEqual(issued?.evidence);
    expect(verdict?.evidence).toEqual([]);
    expect(guard?.guards).toMatchObject({
      predicate: "freshness",
      policy: "block",
      decision: {
        id:
          bounced?.type === "ChangeBounced"
            ? bounced.payload.nextActions?.[1]?.args?.["decisionId"]
            : undefined,
      },
    });
    expect(guard).toMatchObject({ tier: 1, kind: "probe", evidenceCeiling: "proof" });
    // The decision it holds is named by its label, as the page has read it.
    expect(guard?.decisionLabel).toBe("D-1");
  });
});

const ruled = (keel: ReturnType<typeof reading>["keel"]): boolean =>
  keel.events().some((event) => event.type === "RulingGiven");

/** When the stand-in's question was put, by its log. */
const raisedAt = (keel: ReturnType<typeof reading>["keel"]): number =>
  Date.parse(keel.events().find((event) => event.type === "EscalationRaised")?.at ?? "");

describe("ruling, from the page", () => {
  const answer = { option: "invalidate", idempotencyKey: "k" };

  it("[http.ruling-visitor] offers a visitor no way to answer, and Keel's refusal is what a visitor who tries is told", async () => {
    const { source, question, keel } = await opened("visitor", "public");
    expect(source.canRule?.(question)).toBe(false);
    const refused: unknown = await source
      .giveRuling({ escalationId: question, ...answer })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelRefused);
    expect(refused).toMatchObject({ status: 401, code: "auth.required" });
    expect(ruled(keel)).toBe(false);
  });

  it("[http.ruling-refused] gives someone Keel refuses its own words, with the way forward it names", async () => {
    const { source, question, keel } = await opened("stranger", "public");
    expect(source.canRule?.(question)).toBe(false);
    const refused: unknown = await source
      .giveRuling({ escalationId: question, ...answer })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelRefused);
    expect(refused).toMatchObject({
      status: 403,
      code: "auth.forbidden",
      next: ["Ask an owner of acme to make you a member"],
    });
    expect(ruled(keel)).toBe(false);
  });

  it("[http.ruling] answers as the maintainer signed in, by Keel's own operation: the question in the path, the key in the header, the ruling as the body", async () => {
    const { source, question, keel } = await opened("maintainer");
    expect(source.canRule?.(question)).toBe(true);
    await source.giveRuling({
      escalationId: question,
      option: "allow-stale",
      rationale: "It is read rarely",
      idempotencyKey: "console:k",
    });
    expect(keel.events().find((event) => event.type === "RulingGiven")?.payload).toMatchObject({
      option: "allow-stale",
    });
    expect(keel.calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/escalations/${question}/ruling`,
      idempotencyKey: "console:k",
      authorization: "",
      body: JSON.stringify({ option: "allow-stale", rationale: "It is read rarely" }),
    });
    // Another answer, later, finds the question closed. Keel says so, and not the page.
    const late: unknown = await source
      .giveRuling({ escalationId: question, option: "invalidate", idempotencyKey: "another" })
      .catch((error: unknown) => error);
    expect(late).toMatchObject({
      status: 409,
      code: "escalation.state_refused",
      message: `${question} is ruled: it takes one ruling, while it is open.`,
    });
  });

  it("[http.ruling-words] tells a refused ruling in Keel's words: an option the question does not offer with the ones it does, and a question that is not there", async () => {
    const { source, question, keel } = await opened("maintainer");
    const unknown: unknown = await source
      .giveRuling({ escalationId: question, option: "no-such", idempotencyKey: "k-unknown" })
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(KeelRefused);
    expect(unknown).toMatchObject({
      status: 400,
      code: "escalation.option_unknown",
      message: `${question} does not offer the option no-such.`,
      next: S1_CHOICES.map((choice) => choice.label),
    });
    const missing: unknown = await source
      .giveRuling({ escalationId: "esc_none", option: "invalidate", idempotencyKey: "k-missing" })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({
      status: 404,
      code: "escalation.not_found",
      message: "No escalation esc_none.",
      next: ["List the questions waiting for you"],
    });
    expect(ruled(keel)).toBe(false);
  });

  it("[http.offered] offers a ruling to a maintainer, and to a member only where Keel lists them the question", async () => {
    const maintainer = await opened("maintainer");
    expect(maintainer.source.canRule?.(maintainer.question)).toBe(true);
    // A maintainer is offered every question of the project, so Keel is not asked whose it is.
    await maintainer.source.readAsked?.();
    expect(maintainer.keel.calls.some((call) => call.path === "/v1/escalations")).toBe(false);

    // A member the question was not put to is offered nothing, and Keel would have refused them.
    const plain = await opened("member", "private", 0, { sponsor: "owner" });
    expect(plain.source.canRule?.(plain.question)).toBe(false);
    await plain.source.readAsked?.();
    expect(plain.source.canRule?.(plain.question)).toBe(false);
    const refused: unknown = await plain.source
      .giveRuling({ escalationId: plain.question, ...answer })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(ruled(plain.keel)).toBe(false);

    // The member it was put to is offered it once Keel has listed it to them, and Keel takes their answer.
    const asked = await opened("member", "private", 0, { sponsor: "member" });
    expect(asked.player.canRule(asked.question)).toBe(false);
    // The question's page asks, once, and is drawn again when Keel has answered.
    let drawn = 0;
    asked.player.subscribe(() => {
      drawn += 1;
    });
    asked.player.wantAsked();
    asked.player.wantAsked();
    await settled();
    expect(asked.player.canRule(asked.question)).toBe(true);
    expect(drawn).toBeGreaterThan(0);
    expect(asked.keel.calls.filter((call) => call.path === "/v1/escalations")).toHaveLength(1);
    await asked.source.giveRuling({ escalationId: asked.question, ...answer });
    expect(ruled(asked.keel)).toBe(true);

    // Whoever Keel reads only a project's public part is listed nothing of it, and their page does not ask.
    const visitor = await opened("visitor", "public");
    await visitor.source.readAsked?.();
    expect(visitor.keel.calls.some((call) => call.path === "/v1/escalations")).toBe(false);
  });
});

describe("the questions Keel has put to someone, from the page", () => {
  it("[http.waiting] asks Keel for the reader's open questions by its own operation, adds nothing to the request, and follows every cursor", async () => {
    const { directory, fromThePage, question } = reading("maintainer");
    expect(await directory.listWaiting()).toMatchObject([
      {
        id: question,
        label: "E-1",
        project: { namespace: "acme", name: "demo" },
        state: "open",
      },
    ]);
    const sent = fromThePage.at(-1);
    expect(sent?.url).toBe(`${ORIGIN}/v1/escalations?state=open&limit=100`);
    expect(
      sent?.headers.has("authorization") === true || sent?.headers.has("cookie") === true,
    ).toBe(false);

    // A page may hold fewer than its limit, none even, while its cursor says more follow.
    const [listed] = await directory.listWaiting();
    const asked: string[] = [];
    const paged = createHttpDirectory({
      fetch: (input) => {
        const url = addressOf(input);
        asked.push(url.search);
        return Promise.resolve(
          Response.json(
            url.searchParams.get("cursor") === null
              ? { items: [], nextCursor: "000000000007" }
              : { items: [listed] },
          ),
        );
      },
    });
    expect(await paged.listWaiting()).toHaveLength(1);
    expect(asked).toEqual(["?state=open&limit=100", "?state=open&limit=100&cursor=000000000007"]);
  });

  it("[http.waiting-whose] is listed a question as Keel lists it: to the person it was put to at once, to a maintainer once thirty minutes have passed, and to nobody else", async () => {
    const at = raisedAt(reading("owner").keel);
    const early = { sponsor: "member" as const, now: () => at + MAINTAINERS_AFTER_MS - 1 };
    expect(await reading("member", "private", 0, early).directory.listWaiting()).toHaveLength(1);
    expect(await reading("maintainer", "private", 0, early).directory.listWaiting()).toEqual([]);
    expect(await reading("owner", "private", 0, early).directory.listWaiting()).toEqual([]);
    const later = { sponsor: "member" as const, now: () => at + MAINTAINERS_AFTER_MS };
    expect(await reading("maintainer", "private", 0, later).directory.listWaiting()).toHaveLength(
      1,
    );
    expect(await reading("owner", "private", 0, later).directory.listWaiting()).toHaveLength(1);

    // A question that names nobody is its maintainers' at once, and never a plain member's.
    expect(await reading("maintainer").directory.listWaiting()).toHaveLength(1);
    expect(await reading("member").directory.listWaiting()).toEqual([]);
    // Someone signed in whom Keel reads no member's part of the project is listed nothing of it.
    expect(await reading("stranger", "public").directory.listWaiting()).toEqual([]);
    // A visitor's page never asks. One that did would be told what Keel says to anyone with no session.
    const refused: unknown = await reading("visitor", "public")
      .directory.listWaiting()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelRefused);
    expect(refused).toMatchObject({ status: 401, code: "auth.required" });
  });

  it("[http.own-feed] reads the reader's own feed with no project named, and hands on only what kind each entry is", async () => {
    const { directory, fromThePage } = reading("maintainer");
    const first = await directory.readOwnFeed({});
    expect(fromThePage.at(-1)?.url).toBe(`${ORIGIN}/v1/events?limit=500`);
    expect(first.items).toContain("EscalationRaised");
    expect(first.items.every((kind) => typeof kind === "string")).toBe(true);

    // The feed's head is asked for by Keel's own word for it: no entry from before, and where to read on from,
    // which is where reading the whole feed ends.
    const head = await directory.readOwnFeed({ cursor: "end" });
    expect(fromThePage.at(-1)?.url).toBe(`${ORIGIN}/v1/events?limit=500&cursor=end`);
    expect(head).toEqual({ items: [], nextCursor: first.nextCursor });
    // A cursor Keel gave on no page is refused, as Keel refuses one.
    expect(
      await directory.readOwnFeed({ cursor: "the-start" }).catch((error: unknown) => error),
    ).toMatchObject({ status: 400, code: "request.invalid" });

    // The cursor and the wait are Keel's own inputs, and the wait is never more than Keel allows.
    const asked: string[] = [];
    const tail = createHttpDirectory({
      fetch: (input) => {
        asked.push(addressOf(input).search);
        return Promise.resolve(Response.json({ items: [], nextCursor: "000000000009" }));
      },
    });
    await tail.readOwnFeed({ cursor: "000000000004", waitSec: 60 });
    expect(asked).toEqual(["?limit=500&cursor=000000000004&wait=30"]);

    // Someone signed in whom Keel reads nothing of a private project: no entry of it, and the cursor moves on.
    const stranger = await reading("stranger").directory.readOwnFeed({});
    expect(stranger).toEqual({ items: [], nextCursor: first.nextCursor });
    // A public project's feed is read to them less what is its members': no question, no ruling.
    const passerBy = await reading("stranger", "public").directory.readOwnFeed({});
    expect(passerBy.items.length).toBeGreaterThan(0);
    expect(passerBy.items).not.toContain("EscalationRaised");
    // A visitor has no feed of their own.
    const refused: unknown = await reading("visitor", "public")
      .directory.readOwnFeed({})
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 401, code: "auth.required" });
  });
});

describe("a project's settings, from the page", () => {
  it("[settings.read] reads a member what Keel holds for the project, and gives anyone Keel refuses its own words", async () => {
    const { source, fromThePage, keel } = await opened("member");
    expect(await source.getSettings()).toEqual({
      protectedPaths: ["infra/**"],
      maxBatchSize: 8,
      verification: "required",
      visibility: "private",
    });
    expect(fromThePage.at(-1)?.url).toBe(`${ORIGIN}/v1/projects/${keel.project.id}/settings`);

    const visitor = await opened("visitor", "public");
    expect(await visitor.source.getSettings().catch((error: unknown) => error)).toMatchObject({
      status: 401,
      code: "auth.required",
    });
    // Someone signed in who is no member of the project's org reads a public project, and not its settings.
    const stranger = await opened("stranger", "public");
    const refused: unknown = await stranger.source.getSettings().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelRefused);
    expect(refused).toMatchObject({
      status: 403,
      code: "auth.forbidden",
      next: ["Ask a member: this needs that role"],
    });
  });

  it("[settings.put] replaces the settings whole, as the maintainer signed in, and says what Keel then holds", async () => {
    const { source, keel, fromThePage } = await opened("maintainer");
    const held = await source.getSettings();
    const answered = await source.putSettings({ ...held, visibility: "public" });
    expect(answered).toEqual({ ...held, visibility: "public" });
    expect(keel.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: `/v1/projects/${keel.project.id}/settings`,
      authorization: "",
      body: JSON.stringify({ ...held, visibility: "public" }),
    });
    expect(
      fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
    // Keel now shows the project to anyone.
    expect(await source.getSettings()).toMatchObject({ visibility: "public" });
    expect(keel.project.visibility).toBe("public");
  });

  it("[settings.frame] has the frame say who may read the project as Keel last answered, and tells the views when that changed", async () => {
    const { player } = await opened("maintainer");
    const heard: number[] = [];
    player.subscribe(() => heard.push(player.version));
    expect(player.projects.named("demo")?.visibility).toBe("private");
    player.readBy("public");
    expect(player.projects.named("demo")?.visibility).toBe("public");
    expect(heard).toHaveLength(1);
    // Told what it already holds, it tells nobody.
    player.readBy("public");
    expect(heard).toHaveLength(1);
  });

  it("[settings.refused] gives a member who is no maintainer Keel's refusal and its way forward, and changes nothing", async () => {
    const { source, keel } = await opened("member");
    const held = await source.getSettings();
    const refused: unknown = await source
      .putSettings({ ...held, visibility: "public" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelRefused);
    expect(refused).toMatchObject({
      status: 403,
      code: "auth.forbidden",
      next: ["Ask a maintainer or an owner: this needs that role"],
    });
    expect(await source.getSettings()).toEqual(held);
    expect(keel.project.visibility).toBe("private");
  });
});

/** Where the stand-in's trunk was imported from, and upstream's head now: a commit trunk has not got. */
const UPSTREAM = {
  url: "https://github.com/acme/demo",
  ref: "refs/heads/main",
  head: "5f0e1d2c3b4a5968778695a4b3c2d1e0f9e8d7c6",
};

/** A refusal as a test compares it: Keel's status, code, sentence and ways forward. */
const refusedAs = (error: unknown) =>
  error instanceof KeelRefused
    ? { status: error.status, code: error.code, said: error.message, next: [...error.next] }
    : String(error);

describe("syncing a project from upstream, from the page", () => {
  it("[sync.call] fast-forwards trunk as the owner signed in, and reads trunk at upstream's head after", async () => {
    const { source, keel, fromThePage, player } = await opened("owner", "private", 0, {
      imported: UPSTREAM,
    });
    await player.load();
    player.seek(player.end);
    const before = player.world.trunk.head;
    expect(player.world.trunk.upstream).toEqual({ url: UPSTREAM.url, ref: UPSTREAM.ref });

    expect(await source.syncUpstream()).toEqual({ from: before, to: UPSTREAM.head, synced: true });
    // The operation's whole input is the project in the path: no body, and nothing of the page's beside it.
    expect(keel.calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/projects/${keel.project.id}/sync`,
      authorization: "",
      body: "",
    });
    expect(
      fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);

    // The log's sync moves trunk's head and height as Keel counts them.
    await player.load();
    player.seek(player.end);
    const synced = keel.events().findLast((event) => event.type === "TrunkSynced");
    expect(synced?.type === "TrunkSynced" ? synced.payload.height : 0).toBeGreaterThan(0);
    expect(player.world.trunk.head).toBe(UPSTREAM.head);
    expect(player.world.trunk.advances).toBe(
      synced?.type === "TrunkSynced" ? synced.payload.height : -1,
    );

    // Asked again, trunk is level with upstream: Keel moves nothing and commits nothing.
    const entries = keel.events().length;
    expect(await source.syncUpstream()).toEqual({
      from: UPSTREAM.head,
      to: UPSTREAM.head,
      synced: false,
    });
    expect(keel.events()).toHaveLength(entries);
  });

  it("[sync.refused] gives Keel's refusal in its words to anyone but the owner, and where trunk is no fast-forward or was not imported", async () => {
    const maintainer = await opened("maintainer", "private", 0, { imported: UPSTREAM });
    const entries = maintainer.keel.events().length;
    expect(await maintainer.source.syncUpstream().catch(refusedAs)).toMatchObject({
      status: 403,
      code: "auth.forbidden",
      next: ["Ask an owner: this needs that role"],
    });

    const diverged = await opened("owner", "private", 0, {
      imported: { ...UPSTREAM, diverged: true },
    });
    const refused: unknown = await diverged.source.syncUpstream().catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, code: "trunk.not_fast_forward" });
    const sentence = refused instanceof KeelRefused ? refused.message : String(refused);
    // Keel's sentence names both heads.
    const trunkHead = diverged.keel
      .events()
      .findLast((event) => event.type === "TrunkAdvanced" || event.type === "TrunkInitialized");
    const head =
      trunkHead?.type === "TrunkAdvanced"
        ? trunkHead.payload.to
        : trunkHead?.type === "TrunkInitialized"
          ? trunkHead.payload.head
          : "";
    expect(head).not.toBe("");
    expect(sentence).toContain(head);
    expect(sentence).toContain(UPSTREAM.head);

    const empty = await opened("owner");
    expect(await empty.source.syncUpstream().catch(refusedAs)).toMatchObject({
      status: 409,
      code: "project.not_imported",
    });

    // None of them moved trunk.
    for (const keel of [maintainer.keel, diverged.keel, empty.keel])
      expect(keel.events().some((event) => event.type === "TrunkSynced")).toBe(false);
    expect(maintainer.keel.events()).toHaveLength(entries);
  });

  it("[sync.upstream] names no upstream for a trunk its first entry does not say was imported", async () => {
    const { player } = await opened("owner");
    await player.load();
    player.seek(player.end);
    expect(player.world.trunk.head).not.toBe("");
    expect(player.world.trunk.upstream).toBeUndefined();
  });
});
