import { describe, expect, it } from "vitest";
import { createRng } from "../../../fixtures/prng.ts";
import { ScriptBuilder } from "../../../fixtures/mock/builder.ts";

const EPOCH = "2026-10-13T16:00:00.000Z";

/** Two changes whose events are scripted out of time order, as a swarm script does. */
function script(seed: number) {
  const b = new ScriptBuilder(EPOCH, createRng(seed));
  const first = b.at(1).id("chg");
  const second = b.at(2).id("chg");
  const submitted = b.at(9).emit({
    type: "ChangeSubmitted",
    entity: { kind: "change", id: first },
    payload: { changeId: first, revision: 1, commitSha: "e5f6a7b", workspaceId: "wsp_1" },
  });
  b.at(10).emit({
    type: "PrecheckStarted",
    entity: { kind: "change", id: first },
    payload: { changeId: first, revision: 1, instanceId: "precheck-1" },
    causation: submitted,
  });
  // Said later, happened earlier.
  b.at(3).emit({
    type: "ChangeQueued",
    entity: { kind: "change", id: second },
    payload: { changeId: second, laneId: "lane-1" },
  });
  b.at(4).emit({
    type: "ChangeQueued",
    entity: { kind: "change", id: first },
    payload: { changeId: first, laneId: "lane-1" },
  });
  return b.build();
}

describe("ScriptBuilder", () => {
  it("writes the log in time order, whatever order the script said it in", () => {
    const log = script(42);
    expect(log.events.map((event) => event.type)).toEqual([
      "ChangeQueued",
      "ChangeQueued",
      "ChangeSubmitted",
      "PrecheckStarted",
    ]);
    expect(log.eventTimes).toEqual([3000, 4000, 9000, 10000]);
    expect(log.events.map((event) => event.at)).toEqual([
      "2026-10-13T16:00:03.000Z",
      "2026-10-13T16:00:04.000Z",
      "2026-10-13T16:00:09.000Z",
      "2026-10-13T16:00:10.000Z",
    ]);
  });

  it("numbers each entity's events from 1 with no gaps", () => {
    const log = script(42);
    const seqs = new Map<string, number[]>();
    for (const event of log.events) {
      const list = seqs.get(event.entity.id) ?? [];
      list.push(event.seq);
      seqs.set(event.entity.id, list);
    }
    expect([...seqs.values()].toSorted((a, b) => a.length - b.length)).toEqual([[1], [1, 2, 3]]);
  });

  it("mints ids in Keel's format, and event ids that sort in log order", () => {
    const log = script(42);
    for (const event of log.events) {
      expect(event.eventId).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(event.entity.id).toMatch(/^chg_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    const ids = log.events.map((event) => event.eventId);
    expect(ids.toSorted()).toEqual(ids);
  });

  it("writes each payload as Keel publishes it, tagged with its event's type", () => {
    const log = script(42);
    expect(log.events.map((event): string => event.payload._tag)).toEqual(
      log.events.map((event) => event.type),
    );
    // And nothing of an envelope Keel keeps to itself, but what caused the event, which only the fixtures' own checks read.
    expect([...new Set(log.events.flatMap((event) => Object.keys(event)))].toSorted()).toEqual([
      "at",
      "causation",
      "entity",
      "eventId",
      "payload",
      "seq",
      "type",
    ]);
  });

  it("resolves causation to the causing event's id", () => {
    const log = script(42);
    const submitted = log.events.find((event) => event.type === "ChangeSubmitted");
    const started = log.events.find((event) => event.type === "PrecheckStarted");
    expect(started?.causation).toBe(submitted?.eventId);
    expect(submitted?.causation).toBeUndefined();
  });

  it("gives the same log for the same seed, and a different one for another", () => {
    expect(JSON.stringify(script(42))).toBe(JSON.stringify(script(42)));
    expect(JSON.stringify(script(42).events)).not.toBe(JSON.stringify(script(43).events));
  });
});
