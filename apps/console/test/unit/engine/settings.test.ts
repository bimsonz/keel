import { describe, expect, it } from "vitest";
import type { ProjectSettings, TrunkOrigin } from "../../../src/contract/keel/index.ts";
import {
  branchOf,
  maintains,
  mayPublish,
  proposalsBy,
  proposalsSaid,
  readBy,
  syncedSaid,
} from "../../../src/engine/settings.ts";
import { World } from "../../../src/engine/world.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";

describe("a project's settings, as a page offers them", () => {
  it("[settings.maintainers] offers them to an owner and a maintainer of the project's org, and to nobody else", () => {
    expect(maintains({ viewer: { role: "owner" } })).toBe(true);
    expect(maintains({ viewer: { role: "maintainer" } })).toBe(true);
    expect(maintains({ viewer: { role: "member" } })).toBe(false);
    // A visitor, and someone signed in who is in no org of the project's: Keel names neither a viewer.
    expect(maintains({})).toBe(false);
  });

  it("[settings.typed] makes a project public only once its name has been typed, whole and as it is written", () => {
    const project = { name: "forge-lite" };
    expect(mayPublish(project, "forge-lite")).toBe(true);
    for (const typed of ["", "forge", "forge-lite ", "Forge-Lite", "keel/forge-lite"])
      expect(mayPublish(project, typed)).toBe(false);
  });

  it("[settings.whole] changes who may read a project and nothing else of what Keel holds for it", () => {
    const held: ProjectSettings = {
      protectedPaths: ["infra/**", ".keel/**"],
      maxBatchSize: 8,
      verification: "required",
      visibility: "private",
    };
    expect(readBy(held, "public")).toEqual({ ...held, visibility: "public" });
    expect(readBy(readBy(held, "public"), "private")).toEqual(held);
    // What was read is not written on.
    expect(held.visibility).toBe("private");
  });

  it("[console.settings-proposals] closes and opens a public project's proposals and changes nothing else; a private project takes none, whatever its settings say", () => {
    const held: ProjectSettings = {
      protectedPaths: ["infra/**"],
      maxBatchSize: 8,
      verification: "required",
      visibility: "public",
      proposals: "open",
    };
    expect(proposalsBy(held, "closed")).toEqual({ ...held, proposals: "closed" });
    expect(proposalsBy(proposalsBy(held, "closed"), "open")).toEqual(held);
    expect(held.proposals).toBe("open");
    expect(proposalsSaid(held)).toBe("open");
    expect(proposalsSaid({ ...held, proposals: "closed" })).toBe("closed");
    // Settings stored before proposals were kept read as open.
    const { proposals: _none, ...older } = held;
    expect(proposalsSaid(older)).toBe("open");
    expect(proposalsSaid({ ...held, visibility: "private" })).toBe("none");
  });

  it("[settings.sync-said] says a sync as a code host does: the branch by its short name, and level or moved", () => {
    expect(branchOf("refs/heads/main")).toBe("main");
    expect(branchOf("refs/heads/release/1.x")).toBe("release/1.x");
    expect(branchOf("main")).toBe("main");
    const from = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const to = "5f0e1d2c3b4a5968778695a4b3c2d1e0f9e8d7c6";
    expect(syncedSaid({ from, to, synced: true })).toBe(
      "Fast-forwarded trunk from a1b2c3d to 5f0e1d2.",
    );
    expect(syncedSaid({ from: to, to, synced: false })).toBe("Already up to date.");
    // Keel took the sync and the code host kept the move busy: the feed's TrunkSynced finishes it.
    expect(syncedSaid({ from, to, synced: false })).toBe(
      "Fast-forwarding trunk from a1b2c3d to 5f0e1d2.",
    );
  });

  it("[sync.origin] names an upstream for a trunk its first entry says was imported, and for no other", () => {
    const { events } = generateS1(42);
    const upstreamOf = (origin: TrunkOrigin | undefined): unknown => {
      const world = new World();
      for (const event of events)
        world.apply(
          event.type === "TrunkInitialized" && origin !== undefined
            ? { ...event, payload: { ...event.payload, origin } }
            : event,
          0,
        );
      return world.trunk.upstream;
    };
    const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    expect(
      upstreamOf({
        kind: "imported",
        url: "https://github.com/acme/demo",
        ref: "refs/heads/main",
        commit,
      }),
    ).toEqual({ url: "https://github.com/acme/demo", ref: "refs/heads/main" });
    expect(upstreamOf({ kind: "empty" })).toBeUndefined();
    expect(
      upstreamOf({ kind: "forked", project: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0", commit }),
    ).toBeUndefined();
    expect(upstreamOf({ kind: "template", name: "fixture-forge-lite", commit })).toBeUndefined();
    // A trunk started before Keel kept where trunks came from.
    expect(upstreamOf(undefined)).toBeUndefined();
  });
});
