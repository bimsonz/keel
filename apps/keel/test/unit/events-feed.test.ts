import { agentActor, EventEnvelope, makeId } from "@keeltown/core/kernel";
import type { EventFeedEntry } from "@keeltown/core/ports";
import { sampleProjectId, ulidOf } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { eventsOk } from "../../src/adapters/driving/http/events.ts";
import { eventPageSchema } from "../../src/generated/http/schemas.gen.ts";

const agentId = makeId("agt", ulidOf(1));
const sessionId = makeId("ses", ulidOf(2));
const sponsor = makeId("usr", ulidOf(3));

/** A feed entry holding `payload` exactly as it was committed. */
const entry = (seq: number, entity: { kind: string; id: string }, payload: object) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type: Reflect.get(payload, "_tag"),
    entity,
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `${entity.kind}:${entity.id}/cause-${seq}`,
    actor: agentActor(agentId),
    project: sampleProjectId,
    affected: [],
    notified: [],
    payload,
  }) satisfies EventFeedEntry;

const enrolled = {
  _tag: "AgentEnrolled",
  agentId,
  projectId: sampleProjectId,
  name: "feed-agent",
  kind: "interactive",
  scopes: ["agent:work"],
  sponsor,
};
const opened = { _tag: "SessionOpened", sessionId, agentId, harness: "h", sponsor };

describe("[events.served] the feed serves each event as core reads it now", () => {
  it("[events.served] drops a key an event was committed with that its schema has since retired, so the page meets the spec", () => {
    const page = eventsOk({
      events: [
        entry(1, { kind: "agent", id: agentId }, { ...enrolled, retired: "github:octocat" }),
        entry(2, { kind: "session", id: sessionId }, { ...opened, retired: "github:octocat" }),
      ],
      cursor: "000000000002",
    });
    const body = Reflect.get(page, "body");
    expect(eventPageSchema.safeParse(body).success).toBe(true);
    expect(eventPageSchema.parse(body).items.map((item) => item.payload)).toEqual([
      enrolled,
      opened,
    ]);
  });
});
