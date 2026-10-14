import { describe, expect, it } from "vitest";
import type { KeelEvent } from "../src/report.ts";
import { Watch } from "../src/watch.ts";

const isEvents = (x: unknown): x is KeelEvent[] => Array.isArray(x);
let seq = 0;
function events(...list: [project: string, tag: string, changeId: string][]): KeelEvent[] {
  const made: unknown = list.map(([project, tag, changeId]) => {
    seq += 1;
    return {
      eventId: `evt_${seq}`,
      type: tag,
      entity: { kind: "change", id: changeId },
      seq,
      at: "2026-10-14T16:00:00Z",
      project,
      payload: { _tag: tag, changeId },
    };
  });
  if (!isEvents(made)) throw new Error("not events");
  return made;
}

const never = { events: async () => ({ items: [], nextCursor: "c" }) };

describe("the run's one reader", () => {
  it("[loadgen.watch-nth] settles each submission of a change on its own event, never on an earlier one's, and only in its own project", async () => {
    const watch = new Watch(never, "prj_A", undefined);
    const first = watch.settled("chg_1", 1);
    const second = watch.settled("chg_1", 2);
    const seen: string[] = [];
    void second.then((s) => seen.push(`second ${s}`));
    watch.take(events(["prj_B", "ChangeLanded", "chg_1"], ["prj_A", "ChangeQueued", "chg_1"]));
    watch.take(events(["prj_A", "ChangeBounced", "chg_1"]));
    expect(await first).toBe("bounced");
    await Promise.resolve();
    expect(seen).toEqual([]);
    watch.take(events(["prj_A", "ChangeLanded", "chg_1"]));
    expect(await second).toBe("landed");
    // Asked after the fact, it answers from what it has seen.
    expect(await watch.settled("chg_1", 1)).toBe("bounced");
    expect(watch.events.map((e) => e.payload._tag)).toEqual([
      "ChangeQueued",
      "ChangeBounced",
      "ChangeLanded",
    ]);
  });

  it("[loadgen.watch-follow] reads page after page from where it was told to start, until it is done", async () => {
    const asked: (string | undefined)[] = [];
    const pages = [
      { items: events(["prj_A", "ChangeLanded", "chg_2"]), nextCursor: "c1" },
      { items: [], nextCursor: "c1" },
      { items: events(["prj_A", "ChangeParked", "chg_3"]), nextCursor: "c2" },
    ];
    const reader = {
      events: async (options: { readonly cursor?: string }) => {
        asked.push(options.cursor);
        return pages.shift() ?? { items: [], nextCursor: "c2" };
      },
    };
    const watch = new Watch(reader, "prj_A", "c0");
    const parked = watch.settled("chg_3", 1);
    await watch.follow(() => watch.events.length === 2);
    expect([await parked, asked, watch.cursor]).toEqual(["parked", ["c0", "c1", "c1"], "c2"]);
  });
});
