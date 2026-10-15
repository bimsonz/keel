import { describe, expect, it } from "vitest";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { KeelEventSource, ReadRequest } from "../../../src/source/types.ts";
import { showing } from "../showing.ts";

/**
 * A fixture's log served as Keel serves a big project's: from the real stream, two pages, the second held back
 * until `release` is called, as a page of a long log is still on its way while the first is drawn.
 */
function twoPagesLive<Source extends KeelEventSource>(source: Source) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live: Source = {
    ...source,
    descriptor: { ...source.descriptor, mode: "live" },
    async readEvents(request: ReadRequest = {}) {
      const { items } = await source.readEvents({});
      const half = Math.floor(items.length / 2);
      if (request.cursor === undefined) return { items: items.slice(0, half), nextCursor: "half" };
      if (request.cursor === "half") {
        await held;
        return { items: items.slice(half), nextCursor: "end" };
      }
      return { items: [], nextCursor: "end" };
    },
    readObservations: (request: ReadRequest = {}) =>
      Promise.resolve({ items: [], nextCursor: request.cursor ?? "" }),
  };
  return { live, release };
}

describe("reading a big project's log from Keel", () => {
  it("[player.as-read] folds each page as it arrives, so what the first page holds is shown before the last comes", async () => {
    const { live, release } = twoPagesLive(createMockSource({ scenario: "s1", seed: 42 }));
    const player = showing(live);
    const loading = player.load();
    // The first page is read, the second is held: what the first holds is already in the world.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(player.loaded).toBe(false);
    const early = player.world.changes.size;
    expect(early).toBeGreaterThan(0);
    release();
    await loading;
    expect(player.loaded).toBe(true);
    player.seek(player.end);
    expect(player.world.changes.size).toBeGreaterThanOrEqual(early);
  });
});
