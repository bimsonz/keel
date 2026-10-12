import { describe, expect, it } from "vitest";
import type { ProjectView } from "../../../src/contract/keel/index.ts";
import { Player } from "../../../src/engine/player.ts";
import { type RepoAddress, repositoryOf } from "../../../src/engine/repository.ts";
import { changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { createHttpDirectory, createHttpSource } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import { type Role, SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";

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
    org: "acme",
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

/**
 * The page reading the stand-in Keel as `who`. The browser's part is played here: it sends the session's cookie
 * to its own origin, and says which page a request that changes something came from. What the page's own code
 * put on a request is kept apart, in `fromThePage`.
 */
function reading(who: Who, visibility: "public" | "private" = "private") {
  const keel = createFakeKeel({
    visibility,
    sessions: { owner: "owner", maintainer: "maintainer", member: "member", stranger: "stranger" },
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

/** The project as `who` is shown it, with a playhead on it. */
async function opened(who: Who, visibility: "public" | "private" = "private") {
  const r = reading(who, visibility);
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
    // No such project, and a project in another org of the same name, are the same answer.
    expect(await shut.directory.findProject("acme", "no-such")).toBeNull();

    const open = await opened("visitor", "public");
    expect(open.found).toMatchObject({ org: "acme", name: "demo", visibility: "public" });
    expect(open.found.viewer).toBeUndefined();
    expect(await open.directory.listProjects()).toMatchObject([{ org: "acme", name: "demo" }]);
    await open.player.load();
    await settled();
    open.player.seek(open.player.end);
    expect(open.player.world.conflicts.size).toBe(1);
    expect(open.player.unread).toBe(0);
    expect(open.source.canRule?.(open.question)).toBe(false);
  });

  it("[http.org] finds a project under its own org and under no other", async () => {
    const r = reading("owner");
    expect(await r.directory.findProject("acme", "demo")).toMatchObject({ name: "demo" });
    expect(await r.directory.findProject("other", "demo")).toBeNull();
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
    // Someone signed in who is in no org of the project's is shown nothing of it.
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

  it("reads a verdict's evidence from Keel's view of the verdict: the event carries only references", async () => {
    const { player, keel } = await opened("member");
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

const ruled = (keel: ReturnType<typeof reading>["keel"]): boolean =>
  keel.events().some((event) => event.type === "RulingGiven");

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

  it("[http.ruling] answers as the member signed in, by Keel's own operation: the question in the path, the key in the header, the ruling as the body", async () => {
    const { source, question, keel } = await opened("member");
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
    expect(late).toMatchObject({ status: 409, code: "escalation.state_refused" });
  });
});
