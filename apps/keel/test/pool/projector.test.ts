import { env } from "cloudflare:workers";
import { type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { decodeExit, ProjectorCodecs } from "../../src/rpc/index.ts";
import { sampleProjectId } from "@keeltown/testing";
import { changeUnderTest, ok } from "./change-harness.ts";

/** The one Projector the fan-out delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));
const WAIT = { timeout: 10_000, interval: 50 };

const read = async (request: { cursor?: string; limit?: number; waitMs?: number }) =>
  ok(decodeExit(ProjectorCodecs.read, await projector().read(request)));

/** Where the feed ends now, so a test reads only what arrives after it. */
const tail = async () => {
  let cursor = (await read({})).cursor;
  for (let page = await read({ cursor }); page.events.length > 0; page = await read({ cursor }))
    cursor = page.cursor;
  return cursor;
};

/** Everything in the feed after `cursor`. */
const everythingAfter = async (cursor: string) => {
  const events: EventEnvelope[] = [];
  for (let page = await read({ cursor }); page.events.length > 0; page = await read({ cursor })) {
    events.push(...page.events);
    cursor = page.cursor;
  }
  return events;
};

const arrival = (entity: EntityRef) =>
  Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "ChangeBounced",
      entity,
      seq: 1,
      at: Date.now(),
      dedupeKey: `${entity.kind}:${entity.id}/bounce/ChangeBounced#1`,
      affected: [],
      notified: ["projector"],
      payload: { _tag: "ChangeBounced", changeId: entity.id },
    }),
  );

describe("the Projector's labels", () => {
  it("[b12.envelope-project] stamps a change's events with its project, and labels its declaration in that project", async () => {
    const from = await tail();
    const c = await changeUnderTest();
    ok(await c.declare());
    const log = await c.log();

    expect(log.map((event) => event.project)).toEqual(log.map(() => sampleProjectId));
    await vi.waitFor(async () => {
      let cursor = from;
      const labels: (string | undefined)[] = [];
      for (
        let page = await read({ cursor });
        page.events.length > 0;
        page = await read({ cursor })
      ) {
        for (const entry of page.events)
          if (entry.type === "IntentDeclared" && entry.entity.id === c.changeId)
            labels.push(entry.label);
        cursor = page.cursor;
      }
      expect(labels).toEqual([expect.stringMatching(/^#\d+$/)]);
    }, WAIT);
  });
});

describe("the Projector's feed", () => {
  it("[b12.projector-every] gets every event an object commits, though nothing subscribed it, in each emitter's order", async () => {
    const from = await tail();
    const c = await changeUnderTest();
    ok(await c.declare());

    await vi.waitFor(async () => {
      const mine = (await everythingAfter(from)).filter((event) => event.entity.id === c.changeId);
      expect(mine.map((event) => [event.type, event.seq])).toEqual([
        ["IntentDeclared", 1],
        ["PreflightIssued", 2],
        ["ChangeStarted", 3],
      ]);
    }, WAIT);
  });

  it("[b12.projector-dedupe] records a redelivered event once", async () => {
    const from = await tail();
    const entity: EntityRef = { kind: "change", id: makeId("chg", ulid()) };
    const envelope = arrival(entity);
    await projector().receive([envelope]);
    await projector().receive([envelope]);

    const mine = (await everythingAfter(from)).filter((event) => event.entity.id === entity.id);
    expect(mine.map((event) => event.eventId)).toEqual([envelope.eventId]);
  });

  it("[b12.projector-wait] answers a waiting read as soon as an event arrives, well before its deadline", async () => {
    const from = await tail();
    const entity: EntityRef = { kind: "change", id: makeId("chg", ulid()) };
    const started = Date.now();
    const waiting = projector().read({ cursor: from, waitMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await projector().receive([arrival(entity)]);
    const page = decodeExit(ProjectorCodecs.read, await waiting);

    expect(Exit.isSuccess(page) && page.value.events.map((event) => event.entity.id)).toContain(
      entity.id,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("[b12.projector-wait] answers an empty page at the deadline when nothing arrives", async () => {
    const from = await tail();
    const started = Date.now();
    const page = await read({ cursor: from, waitMs: 400 });

    expect(page).toEqual({ events: [], cursor: from });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
});
