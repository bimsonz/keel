import { describe, expect, it } from "vitest";
import { notifies } from "../../../src/domain/identity/index.ts";
import {
  agentActor,
  type EventEnvelope,
  Instant,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const AGENT = makeId("agt", ulid(1));
const OTHER = makeId("agt", ulid(2));
const CHANGE = makeId("chg", ulid(3));

const envelope = (payload: object, actor?: EventEnvelope["actor"]): EventEnvelope => ({
  eventId: makeId("evt", ulid(4)),
  type: String(Reflect.get(payload, "_tag")),
  entity: { kind: "change", id: CHANGE },
  seq: 1,
  at: Instant(1_760_000_000_000),
  dedupeKey: `change:${CHANGE}/note#1`,
  ...(actor === undefined ? {} : { actor }),
  affected: [],
  notified: [],
  payload,
});

const noted = (policy: "advise" | "annotate") => ({
  _tag: "ConflictNoted",
  changeId: CHANGE,
  conflictId: makeId("cfl", ulid(5)),
  predicate: "freshness",
  policy,
});

describe("the inbox", () => {
  it("[inbox.annotate-silent] a conflict noted under annotate notifies no one; under advise it notifies as any event does, never the agent that caused it", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("advise" as const, "annotate" as const),
        fc.constantFrom(undefined, agentActor(AGENT), agentActor(OTHER)),
        (policy, actor) =>
          notifies(AGENT, envelope(noted(policy), actor)) ===
          (policy === "advise" && actor !== agentActor(AGENT)),
      ),
    );
    expect(notifies(AGENT, envelope(noted("annotate")))).toBe(false);
    expect(notifies(AGENT, envelope(noted("advise")))).toBe(true);
    // Only a ConflictNoted is silenced: another event with the same field still notifies.
    expect(notifies(AGENT, envelope({ _tag: "ChangeBounced", policy: "annotate" }))).toBe(true);
  });
});
