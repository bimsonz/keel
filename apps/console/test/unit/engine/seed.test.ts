import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectView } from "../../../src/contract/keel/index.ts";
import { Player } from "../../../src/engine/player.ts";
import { holdersShown } from "../../../src/engine/holder.ts";
import { changesOf } from "../../../src/engine/lists.ts";
import { ConsoleProvider } from "../../../src/engine/react.tsx";
import { drawable } from "../../../src/engine/seed.ts";
import { ChangesPage } from "../../../src/pages/Changes.tsx";
import { WhereProvider } from "../../../src/router.tsx";
import { NamesProvider } from "../../../src/views/links.tsx";
import { createHttpSource } from "../../../src/source/http.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";

const ORIGIN = "https://keel.example";

const nothing = (): void => undefined;

/** The events in a page of the stand-in's log: a few, so the scenario's log takes many pages. */
const PAGE = 20;

/**
 * A stand-in for Keel: the scenario's log, and a snapshot of every change it declares, newest first as Keel
 * answers it, each queued. What is held (the log, the log after its first page, or the snapshot) is answered
 * once released; with no snapshot, Keel has none to give.
 */
function heldKeel(held: "log" | "log after its first page" | "snapshot" | "no snapshot") {
  const log = generateS1(42, "invalidate");
  const created = log.events.find((event) => event.type === "ProjectCreated");
  const declarations = log.events.flatMap((event) =>
    event.type === "IntentDeclared" && event.payload.revision === 1 ? [event] : [],
  );
  const [declared] = declarations;
  if (created === undefined || declared === undefined)
    throw new Error("the scenario declares no change");
  const project: ProjectView = {
    id: created.payload.projectId,
    namespace: { handle: "acme", kind: "org" },
    name: "demo",
    visibility: "private",
    createdAt: created.at,
  };
  let release: () => void = nothing;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serve = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ORIGIN,
    );
    if (
      url.pathname === "/v1/events/snapshot" &&
      url.searchParams.get("project") === project.id &&
      held !== "no snapshot"
    ) {
      if (held === "snapshot") await released;
      return Response.json({
        cursor: String(log.events.length),
        changes: declarations
          .map((each, index) => ({
            changeId: each.payload.changeId,
            number: index + 1,
            state: "queued",
            agentId: each.payload.agentId,
            goal: each.payload.goal,
            revision: 1,
            declaredAt: each.at,
            updatedAt: each.at,
          }))
          .toReversed(),
      });
    }
    if (url.pathname === "/v1/events") {
      const start = Number(url.searchParams.get("cursor") ?? "0");
      if (held === "log" || (held === "log after its first page" && start > 0)) await released;
      const items = log.events
        .slice(start, start + PAGE)
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
      return Response.json({ items, nextCursor: String(start + items.length) });
    }
    if (url.pathname === "/v1/lattices") return Response.json({ items: [] });
    return Response.json({}, { status: 404 });
  };
  return {
    project,
    serve,
    release,
    changeId: declared.payload.changeId,
    agentId: declared.payload.agentId,
    goal: declared.payload.goal,
    declared: declarations.length,
  };
}

/** The open changes' page as the console draws it for this player. */
function drawnList(player: Player): string {
  const list = createElement(ChangesPage, { filter: "open", shown: 50 });
  // A unit test draws with no JSX, and every provider's props name its children.
  return renderToStaticMarkup(
    createElement(ConsoleProvider, {
      player,
      // oxlint-disable-next-line react/no-children-prop
      children: createElement(WhereProvider, {
        namespace: "acme",
        project: "demo",
        route: { at: "changes", filter: "open", shown: 50 },
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(NamesProvider, { children: list }),
      }),
    }),
  );
}

describe("a project drawn while its log is read", () => {
  it("[seed.snapshot] a live project's changes are drawn from Keel's snapshot while the log is read, and the world folded from the log takes their place once it is", async () => {
    const keel = heldKeel("log");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    // The log is held: the snapshot's change is drawn, by its number, as Keel's snapshot says it stands.
    await vi.waitFor(() => expect(player.seeded?.changes.get(keel.changeId)?.label).toBe("#1"));
    // The list of changes is drawn from it, and one change's page as the log is read; a page that reads what
    // only the log holds waits for the log.
    expect(drawable(player, "changes")).toBe(true);
    expect(drawable(player, "change")).toBe(true);
    expect(drawable(player, "conflicts")).toBe(false);
    expect(player.seeded?.changes.get(keel.changeId)).toMatchObject({
      state: "queued",
      footprint: [],
    });
    expect(player.world.changes.size).toBe(0);
    expect(player.loaded).toBe(false);

    keel.release();
    await loading;
    // Read to its end, the log's own world is shown, folded to its end: the world a player with no snapshot shows
    // once the page stands it at the end.
    const unseeded = await unseededWorld();
    expect(player.loaded).toBe(true);
    expect(player.provisional).toBe(false);
    expect(player.seeded).toBeNull();
    expect(drawable(player, "conflicts")).toBe(true);
    expect(player.t).toBe(player.end);
    expect(player.world.changes.size).toBeGreaterThan(1);
    expect(player.world.changes).toEqual(unseeded);
  });

  it("[seed.apart] the log is folded as it is read beside the snapshot's world, and never into it", async () => {
    const keel = heldKeel("log after its first page");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    // The snapshot is drawn and the log's first page is folded; the rest of the log is held.
    await vi.waitFor(() => {
      expect(player.provisional).toBe(true);
      expect(player.world.changes.has(keel.changeId)).toBe(true);
    });
    // The first change's own entries are in the log's world, as a change's page draws it while the log is read.
    expect(player.world.changes.get(keel.changeId)?.footprint).not.toEqual([]);
    // The snapshot's world holds what the snapshot said and nothing the log brought.
    expect(player.seeded?.changes.size).toBe(keel.declared);
    expect(player.seeded?.changes.get(keel.changeId)).toMatchObject({
      state: "queued",
      footprint: [],
    });

    keel.release();
    await loading;
    expect(player.seeded).toBeNull();
    expect(player.world.changes).toEqual(await unseededWorld());
  });

  it("[seed.list] the list of changes is drawn from the snapshot's world while the log is read", async () => {
    // A link names the address's carried parameters, which a browser's address holds.
    vi.stubGlobal("window", { location: { search: "" } });
    const keel = heldKeel("log");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    await vi.waitFor(() => expect(player.provisional).toBe(true));
    // The log's own world holds nothing yet; the list names the snapshot's change.
    expect(drawnList(player)).toContain(keel.goal);

    keel.release();
    await loading;
    vi.unstubAllGlobals();
  });

  it("[seed.order] the list drawn from the snapshot lists the changes in the order the list drawn from the log does", async () => {
    const keel = heldKeel("log");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    await vi.waitFor(() => expect(player.provisional).toBe(true));
    const early = changesOf(player.seeded ?? player.world, "open", 1000).rows.map((row) => row.id);
    expect(early).toHaveLength(keel.declared);
    expect(keel.declared).toBeGreaterThan(1);

    keel.release();
    await loading;
    // Every change the snapshot named, as the log's own list orders them, open and closed alike.
    const late = changesOf(player.world, "open", 1000)
      .rows.concat(changesOf(player.world, "closed", 1000).rows)
      .map((row) => row.id);
    const listed = new Set(late);
    const order = [...player.world.changes.keys()].toReversed().filter((id) => listed.has(id));
    expect(early).toEqual(order.filter((id) => early.includes(id)));
  });

  it("[seed.holders] the holders of a list drawn from the snapshot are asked for while the log is read", async () => {
    const keel = heldKeel("log");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    await vi.waitFor(() => expect(player.provisional).toBe(true));
    expect(holdersShown(player, [keel.changeId])).toEqual([keel.agentId]);

    keel.release();
    await loading;
    expect(holdersShown(player, [keel.changeId])).toEqual([keel.agentId]);
  });

  it("[seed.seek-back] going back in time while the log is read puts the snapshot of its head away", async () => {
    const keel = heldKeel("log after its first page");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    const loading = player.load();
    await vi.waitFor(() => {
      expect(player.provisional).toBe(true);
      expect(player.t).toBeGreaterThan(0);
    });
    // A list drawn at the log's start shows the changes as they were then, not as the head has them.
    player.seek(0);
    expect(player.provisional).toBe(false);
    expect(drawable(player, "changes")).toBe(false);

    keel.release();
    await loading;
  });

  it("[seed.late] a snapshot that comes after the log is read is not drawn over the world folded from it", async () => {
    const keel = heldKeel("snapshot");
    const player = new Player(
      createHttpSource(keel.project, {
        origin: ORIGIN,
        fetch: keel.serve,
        cache: null,
        logPages: null,
      }),
    );
    await player.load();
    player.seek(player.end);
    const unseeded = await unseededWorld();
    expect(player.world.changes).toEqual(unseeded);

    keel.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(player.provisional).toBe(false);
    expect(player.world.changes).toEqual(unseeded);
  });
});

/** The changes a player shows with no snapshot to draw, once the page stands it at the log's end. */
async function unseededWorld(): Promise<Player["world"]["changes"]> {
  const keel = heldKeel("no snapshot");
  const player = new Player(
    createHttpSource(keel.project, {
      origin: ORIGIN,
      fetch: keel.serve,
      cache: null,
      logPages: null,
    }),
  );
  await player.load();
  player.seek(player.end);
  return player.world.changes;
}
