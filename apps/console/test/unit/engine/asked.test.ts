import { describe, expect, it } from "vitest";
import { subjectDetailOf } from "../../../src/engine/subject.ts";
import { World } from "../../../src/engine/world.ts";
import type { GeneratedLog } from "../../fixtures/mock/builder.ts";
import { MEMBERS_ONLY } from "../../fixtures/mock/fakeKeel.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";

/** Scenario 1 with its conflict escalated and its question open, before anyone rules. */
const ASKED = 470_000;
const SUBJECT = "authz.permission-evaluation";

function folded(log: GeneratedLog, until: number, reader: "member" | "visitor"): World {
  const world = new World();
  log.events.forEach((event, index) => {
    const at = log.eventTimes[index] ?? 0;
    if (at > until) return;
    if (reader === "visitor" && MEMBERS_ONLY.has(event.type)) return;
    world.apply(event, at);
  });
  return world;
}

describe("a subject a person is asked about", () => {
  it("[subject.person-open] reads as asking a person only while its question is open to the reader", () => {
    const member = folded(generateS1(42), ASKED, "member");
    const visitor = folded(generateS1(42), ASKED, "visitor");
    expect(subjectDetailOf(member, SUBJECT)?.tone).toBe("person");
    // A visitor is not shown the question: the escalated conflict is proven, and no person is said to be asked.
    expect(subjectDetailOf(visitor, SUBJECT)?.tone).toBe("proven");
  });
});
