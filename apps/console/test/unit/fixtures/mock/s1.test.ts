import { describe, expect, it } from "vitest";
import { checkLog, finalStates } from "../../../fixtures/mock/conformance.ts";
import { type S1Ruling, generateS1 } from "../../../fixtures/mock/s1.ts";

const RULINGS: S1Ruling[] = ["no-cache", "invalidate", "allow-stale"];

function statesOf(kind: string, ruling: S1Ruling): string[] {
  return [...finalStates(generateS1(42, ruling).events)]
    .filter(([key]) => key.startsWith(`${kind}:`))
    .map(([, state]) => state)
    .toSorted();
}

describe("scenario 1", () => {
  it("conforms to the catalogue and the state machines, unruled and under every ruling", () => {
    expect(checkLog(generateS1(42).events)).toEqual([]);
    for (const ruling of RULINGS) expect(checkLog(generateS1(42, ruling).events)).toEqual([]);
  });

  it("is the same log for the same seed", () => {
    expect(JSON.stringify(generateS1(42, "invalidate"))).toBe(
      JSON.stringify(generateS1(42, "invalidate")),
    );
    expect(JSON.stringify(generateS1(42).events)).not.toBe(JSON.stringify(generateS1(7).events));
  });

  it("holds at the question until someone rules", () => {
    const unruled = generateS1(42);
    expect(unruled.gates).toHaveLength(1);
    expect(unruled.gates[0]?.options).toEqual(RULINGS);
    expect(unruled.events.some((event) => event.type === "RulingGiven")).toBe(false);
    expect(unruled.end).toBeLessThanOrEqual(unruled.gates[0]?.t ?? 0);
    expect(generateS1(42, "invalidate").gates).toEqual([]);
  });

  it("every ruling continues the same story: the unruled log is a prefix of each", () => {
    const unruled = generateS1(42);
    for (const ruling of RULINGS) {
      const ruled = generateS1(42, ruling);
      expect(ruled.events.length).toBeGreaterThan(unruled.events.length);
      expect(ruled.events.slice(0, unruled.events.length)).toEqual(unruled.events);
      expect(ruled.observations.slice(0, unruled.observations.length)).toEqual(
        unruled.observations,
      );
      // The ruling lands exactly at the gate, however long the person took.
      const given =
        ruled.eventTimes[ruled.events.findIndex((event) => event.type === "RulingGiven")];
      expect(given).toBe(unruled.gates[0]?.t);
    }
  });

  it("the three rulings end in three different places", () => {
    const [noCache, invalidate, allowStale] = RULINGS.map((ruling) =>
      JSON.stringify(generateS1(42, ruling).events),
    );
    expect(noCache).not.toBe(invalidate);
    expect(invalidate).not.toBe(allowStale);
    expect(statesOf("change", "invalidate")).toEqual(["landed", "landed"]);
    expect(statesOf("change", "no-cache")).toEqual(["landed", "withdrawn"]);
    expect(statesOf("change", "allow-stale")).toEqual(["landed", "landed"]);
    // The guard is the admitted probe: there is no guard entity apart from it.
    expect(statesOf("probe", "invalidate")).toEqual(["admitted"]);
    expect(statesOf("probe", "allow-stale")).toEqual(["retired"]);
    expect(statesOf("guard", "allow-stale")).toEqual([]);
  });

  it("admits and retires the guard as events of its probe", () => {
    const events = generateS1(42, "allow-stale").events;
    const admitted = events.find((event) => event.type === "GuardAdmitted");
    const retired = events.find((event) => event.type === "GuardRetired");
    expect(admitted?.entity).toEqual({ kind: "probe", id: admitted?.payload.probeId });
    expect(retired?.entity).toEqual(admitted?.entity);
    // One entity, one gap-free sequence: drafted, fifteen cells, admitted, retired.
    expect(
      events.filter((event) => event.entity.id === admitted?.entity.id).map((event) => event.seq),
    ).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
  });

  it("numbers its changes as Keel does, in the order they were declared, on the entry and not in the payload", () => {
    const declared = generateS1(42).events.filter((event) => event.type === "IntentDeclared");
    expect(declared.map((event) => [event.label, event.payload.goal])).toEqual([
      ["#1", "Speed up permission checks"],
      ["#2", "Owners can revoke collaborators, effective immediately"],
    ]);
    expect(declared.every((event) => event.payload.x === undefined)).toBe(true);
  });

  it("asks its question with a category, its evidence and a default that is one of its options", () => {
    const raised = generateS1(42).events.find((event) => event.type === "EscalationRaised");
    expect(raised?.payload).toMatchObject({
      category: "permission-semantics",
      precedents: [],
      default: "hold",
    });
    expect(raised?.payload.options.map((option) => option.id)).toEqual([
      "no-cache",
      "invalidate",
      "allow-stale",
      "hold",
    ]);
    expect(raised?.payload.evidence.every((line) => line.summary !== undefined)).toBe(true);
    expect(raised?.payload).not.toHaveProperty("x");
  });

  it("records nothing in the catalogue against a conflict that is settled", () => {
    const log = generateS1(42, "invalidate");
    const resolved = log.events.findIndex((event) => event.type === "ConflictResolved");
    expect(
      log.events
        .slice(resolved)
        .filter((event) => event.type === "WorldCheckRan" || event.type === "ProbeRan"),
    ).toEqual([]);
    // The revised change's guard and suites run all the same. They are the console's own observation until Keel records them.
    const again = log.observations.filter((observation) => observation.kind === "world-check");
    expect(again.map((observation) => observation.check.split(":")[0])).toEqual([
      "guard",
      "guard",
      "guard",
      "suite",
      "suite",
      "guard",
      "guard",
      "guard",
    ]);
  });

  it("fills the probe column as the script says: A passes, B and trunk do not apply, A+B fails, three runs each", () => {
    const runs = generateS1(42).events.filter((event) => event.type === "ProbeRan");
    const byWorld = (world: string): string[] =>
      runs.filter((event) => event.payload.world === world).map((event) => event.payload.outcome);
    expect(byWorld("trunk")).toEqual(["n/a", "n/a", "n/a"]);
    expect(byWorld("A")).toEqual(["pass", "pass", "pass"]);
    expect(byWorld("B")).toEqual(["n/a", "n/a", "n/a"]);
    expect(byWorld("AB")).toEqual(["fail", "fail", "fail"]);
    // The decisive cell is the last to fill.
    expect(runs.at(-1)?.payload).toMatchObject({ world: "AB", run: 3, outcome: "fail" });
  });
});
