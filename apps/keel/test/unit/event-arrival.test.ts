import { runIdOf } from "@keeltown/core/domain/identity";
import { agentActor, makeId, RunLabel } from "@keeltown/core/kernel";
import { sampleProjectId, ulidOf } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readDelivery } from "../../src/rpc/events.ts";

const agentId = makeId("agt", ulidOf(51));
const sessionId = makeId("ses", ulidOf(52));
const label = Schema.decodeUnknownSync(RunLabel)("run-b");
const run = { id: runIdOf(agentId, { label }), label };

/** An event as an emitter sends it: the encoded envelope, with `more` over it. */
const sent = (seq: number, more: object) => ({
  eventId: makeId("evt", ulidOf(seq)),
  type: "SessionOpened",
  entity: { kind: "session", id: sessionId },
  seq,
  at: 1_760_000_000_000 + seq,
  dedupeKey: `session:${sessionId}/cause-${seq}`,
  actor: agentActor(agentId),
  project: sampleProjectId,
  affected: [],
  notified: [],
  payload: { _tag: "SessionOpened", sessionId, agentId },
  ...more,
});

describe("[run.delivered] an event arrives with the run that caused it", () => {
  it("[run.delivered] a delivery keeps each event's run, an event of no run arrives with none, and a run this version cannot read arrives without its envelope", () => {
    const [named, plain, unread] = readDelivery([
      sent(1, { run }),
      sent(2, {}),
      sent(3, { run: { id: "not-a-run" } }),
    ]);
    expect(named?.envelope?.run).toEqual(run);
    expect(named?.envelope?.actor).toBe(agentActor(agentId));
    expect(plain?.envelope).toBeDefined();
    expect(plain?.envelope).not.toHaveProperty("run");
    // Dedupe still has its key, so the delivery is recorded and never owed again.
    expect(unread).toEqual({ dedupeKey: `session:${sessionId}/cause-3`, envelope: undefined });
  });
});
