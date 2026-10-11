import { describe, expect, it } from "vitest";
import type { AnyEvent } from "../../../../src/contract/events.ts";
import type { KeelEventSource } from "../../../../src/source/types.ts";
import { createMockSource } from "../../../fixtures/mock/MockSource.ts";

/** Follows `nextCursor` page by page until a page comes back empty. */
async function readAll(
  source: KeelEventSource,
  limit: number,
  cursor?: string,
  sofar: AnyEvent[] = [],
): Promise<AnyEvent[]> {
  const result = await source.readEvents({ ...(cursor === undefined ? {} : { cursor }), limit });
  if (result.items.length === 0) return sofar;
  return readAll(source, limit, result.nextCursor, [...sofar, ...result.items]);
}

describe("the mock source", () => {
  it("serves the same sequence whatever the page size", async () => {
    const small = await readAll(createMockSource({ scenario: "s1", seed: 42 }), 7);
    const large = await readAll(createMockSource({ scenario: "s1", seed: 42 }), 500);
    expect(small.map((event) => event.eventId)).toEqual(large.map((event) => event.eventId));
    expect(new Set(small.map((event) => event.eventId)).size).toBe(small.length);
  });

  it("plays the scripted ruling by default, and names no open question", async () => {
    const source = createMockSource({ scenario: "s1", seed: 42 });
    const events = await readAll(source, 500);
    expect(source.openGate()).toBeUndefined();
    const ruling = events.find((event) => event.type === "RulingGiven");
    expect(ruling?.payload).toMatchObject({ option: "invalidate" });
  });

  it("holds at the question when asked to, and continues only when someone rules", async () => {
    const source = createMockSource({ scenario: "s1", seed: 42, ruling: "live" });
    const before = await readAll(source, 500);
    const gate = source.openGate();
    expect(gate).toBeDefined();
    expect(before.some((event) => event.type === "RulingGiven")).toBe(false);

    // A reader waiting at the tail is woken by the ruling, not by a timer.
    const tail = source.readEvents({ cursor: String(before.length), waitSec: 30 });
    await source.giveRuling({
      escalationId: gate?.escalationId ?? "",
      option: "no-cache",
      idempotencyKey: "test-ruling-1",
    });
    const after = await tail;
    expect(after.items[0]?.type).toBe("RulingGiven");
    expect(after.items[0]?.payload).toMatchObject({ option: "no-cache" });
    expect(source.openGate()).toBeUndefined();
  });

  it("converges: a live ruling ends on the same log as a deep link naming that ruling", async () => {
    const live = createMockSource({ scenario: "s1", seed: 42, ruling: "live" });
    const gate = live.openGate();
    await live.giveRuling({
      escalationId: gate?.escalationId ?? "",
      option: "allow-stale",
      idempotencyKey: "test-ruling-2",
    });
    const linked = createMockSource({ scenario: "s1", seed: 42, ruling: "allow-stale" });
    expect(JSON.stringify(await readAll(live, 500))).toBe(
      JSON.stringify(await readAll(linked, 500)),
    );
  });

  it("refuses a ruling on a question that is not open, or an option it does not have", async () => {
    const source = createMockSource({ scenario: "s1", seed: 42, ruling: "live" });
    const gate = source.openGate();
    await expect(
      source.giveRuling({
        escalationId: "esc_unknown",
        option: "invalidate",
        idempotencyKey: "test-ruling-3",
      }),
    ).rejects.toThrow("is not open");
    await expect(
      source.giveRuling({
        escalationId: gate?.escalationId ?? "",
        option: "flip-a-coin",
        idempotencyKey: "test-ruling-4",
      }),
    ).rejects.toThrow("is not one of its options");
    expect(source.openGate()).toBeDefined();
  });
});
