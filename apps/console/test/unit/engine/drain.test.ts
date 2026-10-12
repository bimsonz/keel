import { describe, expect, it } from "vitest";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { KeelEventSource, ReadRequest } from "../../../src/source/types.ts";
import { showing } from "../showing.ts";

/**
 * A source as Keel's log is to a reader of one project: the log is the whole instance's, a page is the next
 * stretch of it with this project's entries picked out, and a stretch that holds none of them is an empty
 * page whose cursor has still moved on. The log's end is the page whose cursor has not moved.
 */
function behindEmptyPages<Source extends KeelEventSource>(source: Source, empty: number): Source {
  return {
    ...source,
    readEvents(request: ReadRequest = {}) {
      const skipped =
        request.cursor === undefined
          ? 0
          : request.cursor.startsWith("empty:")
            ? Number(request.cursor.slice("empty:".length))
            : undefined;
      if (skipped !== undefined && skipped < empty)
        return Promise.resolve({ items: [], nextCursor: `empty:${skipped + 1}` });
      const { cursor: _, ...rest } = request;
      return source.readEvents(skipped === undefined ? request : rest);
    },
    // Keel serves no observations: nothing but the log's own cursor says whether there is more to read.
    readObservations: (request: ReadRequest = {}) =>
      Promise.resolve({ items: [], nextCursor: request.cursor ?? "" }),
  };
}

describe("reading a project's log from Keel", () => {
  it("[player.drain] reads on past a page that holds none of the project's entries, to the page whose cursor has not moved", async () => {
    const source = behindEmptyPages(createMockSource({ scenario: "s1", seed: 42 }), 3);
    const player = showing(source);
    await player.load();
    player.seek(9_999_000);
    // Three stretches of the log held nothing of this project's. What follows them is its whole story.
    expect(player.world.changes.size).toBe(2);
    expect(player.world.conflicts.size).toBe(1);
    expect(player.loaded).toBe(true);
  });
});
