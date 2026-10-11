import { describe, expect, it, vi } from "vitest";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { Player } from "../../../src/engine/player.ts";
import { type SubjectDetail, subjectDetailOf } from "../../../src/engine/subject.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const KEY = "authz.permission-evaluation";

async function playerAt(
  scenario: "s1" | "s2" | "swarm",
  seconds: number,
  ruling?: string,
): Promise<Player> {
  const player = showing(
    createMockSource({ scenario, seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return player;
}

async function detailAt(
  scenario: "s1" | "s2" | "swarm",
  seconds: number,
  ruling?: string,
  key = KEY,
): Promise<SubjectDetail | null> {
  return subjectDetailOf((await playerAt(scenario, seconds, ruling)).world, key);
}

describe("one subject, read off the world", () => {
  it("while a person is being asked: both changes parked, the premise live, the guard already admitted", async () => {
    const detail = await detailAt("s1", 465, "live");
    expect(detail).toMatchObject({
      key: KEY,
      gloss: "How a request's permissions are decided",
      tone: "person",
      tenets: 0,
    });
    expect(detail?.premises).toContainEqual({
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
      live: 1,
      landed: 0,
    });
    expect(detail?.guards).toMatchObject([
      { label: "G-1", state: "admitted", probe: "P-1", conflict: "C-1" },
    ]);
    expect(detail?.decisions).toEqual([]);
    expect(detail?.conflicts).toMatchObject([
      { label: "C-1", kind: "semantic", state: "escalated" },
    ]);
    expect(detail?.changes).toMatchObject({ total: 2, byState: [["parked", 2]] });
    expect(
      detail?.changes.listed.map((change) => [change.label, change.state, change.agentClass]),
    ).toEqual([
      ["#2", "parked", "real"],
      ["#1", "parked", "real"],
    ]);
  });

  it("once it is settled: nothing in flight, the premise held by what landed, the decision on record", async () => {
    const detail = await detailAt("s1", 9999);
    expect(detail?.tone).toBe("pass");
    expect(detail?.premises).toContainEqual({
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
      live: 0,
      landed: 1,
    });
    expect(detail?.decisions).toMatchObject([
      { label: "D-1", chosen: "Cache allowed if revocation invalidates it", state: "active" },
    ]);
    expect(detail?.conflicts).toMatchObject([{ label: "C-1", state: "resolved" }]);
    expect(detail?.changes).toEqual({ total: 0, byState: [], listed: [] });
    expect(detail?.tenets).toBe(1);
  });

  it("nine days on: both conflicts, newest first, and the change the guard bounced", async () => {
    const detail = await detailAt("s2", 9999);
    expect(detail?.conflicts.map((conflict) => [conflict.label, conflict.kind])).toEqual([
      ["C-2", "precedent"],
      ["C-1", "semantic"],
    ]);
    expect(detail?.changes.listed).toMatchObject([
      { label: "#1205", state: "bounced", agentClass: "hosted" },
    ]);
    expect(detail?.premises[0]).toMatchObject({ value: "per-request", live: 0, landed: 2 });
  });

  it("at swarm scale: premises grouped by what they say, every change in flight counted, the contested ones named first", async () => {
    const detail = await detailAt("swarm", 95, undefined, "storage.gc.safety");
    // A person is being asked about a conflict here.
    expect(detail?.tone).toBe("person");
    expect(detail?.premises).toEqual([
      {
        predicate: "cardinality",
        relation: "at-most",
        value: "exactly-once",
        live: 21,
        landed: 22,
      },
      {
        predicate: "cardinality",
        relation: "at-most",
        value: "at-most-once",
        live: 10,
        landed: 11,
      },
    ]);
    // Each change in flight holds one premise here, so the two counts must agree.
    expect(detail?.changes.total).toBe(31);
    expect(detail?.changes.byState.reduce((sum, [, count]) => sum + count, 0)).toBe(31);
    expect(detail?.changes.listed).toHaveLength(8);
    // The party still in flight is named first: the parked one, a load generator's, by Keel's own number for it.
    expect(detail?.changes.listed[0]).toMatchObject({
      label: "#496",
      state: "parked",
      agentClass: "synthetic",
    });
    expect(detail?.conflicts.map((conflict) => `${conflict.label} ${conflict.state}`)).toEqual([
      "C-7 escalated",
    ]);
    expect(detail?.guards.map((guard) => guard.label)).toEqual(["G-4"]);
  });

  it("at swarm scale, on a subject with a history: conflicts newest first, both parties of the open ones named first", async () => {
    const player = await playerAt("swarm", 110);
    const detail = subjectDetailOf(player.world, "authz.permission-evaluation");
    // Two false alarms are being looked at; two real conflicts were settled earlier and left a guard each.
    expect(detail?.tone).toBe("suspected");
    expect(detail?.conflicts.map((conflict) => `${conflict.label} ${conflict.state}`)).toEqual([
      "C-19 suspected",
      "C-18 probing",
      "C-6 resolved",
      "C-4 resolved",
    ]);
    expect(detail?.guards.map((guard) => `${guard.label} ${guard.state}`)).toEqual([
      "G-2 admitted",
      "G-3 admitted",
    ]);
    const open = new Set(["C-19", "C-18"]);
    const parties = [...player.world.conflicts.values()]
      .filter((conflict) => open.has(conflict.label))
      .flatMap((conflict) => conflict.parties);
    expect(
      detail?.changes.listed
        .slice(0, 4)
        .map((change) => change.id)
        .toSorted(),
    ).toEqual(parties.toSorted());
  });

  it("is nothing for a subject that does not exist", async () => {
    const player = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await player.load();
    player.seek(9_999_000);
    expect(subjectDetailOf(player.world, "no.such.subject")).toBeNull();
    // A subject can be asked for by its id as well as its key.
    const byKey = subjectDetailOf(player.world, KEY);
    expect(subjectDetailOf(player.world, byKey?.id ?? "")).toEqual(byKey);
  });
});
