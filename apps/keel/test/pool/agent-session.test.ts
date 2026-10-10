import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Exit, Schema } from "effect";
import { ulid } from "ulid";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";

const agentStub = (agentId = makeId("agt", ulid())) =>
  env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));

/** An event of a change, encoded as the fan-out delivers it. */
const delivery = (entity: EntityRef, seq: number) =>
  Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "ChangeBounced",
      entity,
      seq,
      at: Date.now(),
      dedupeKey: `${entity.kind}:${entity.id}/cause-${seq}/ChangeBounced#1`,
      affected: [],
      notified: [],
      payload: { _tag: "ChangeBounced" },
    }),
  );

describe("the AgentSession DO over RPC", () => {
  it("reserves one change id per Idempotency-Key, and refuses the key for another body", async () => {
    const session = agentStub();
    const reserve = async (idempotencyKey: string, fingerprint: string) =>
      decodeExit(
        AgentSessionCodecs.reserveChange,
        await session.reserveChange({ idempotencyKey, fingerprint }),
      );
    const first = await reserve("key-1", "body-1");
    const retried = await reserve("key-1", "body-1");
    const conflict = await reserve("key-1", "body-2");

    expect(Exit.isSuccess(first)).toBe(true);
    expect(retried).toEqual(first);
    expect(Exit.isFailure(conflict) && JSON.stringify(conflict.cause)).toContain(
      "IdempotencyConflict",
    );
  });

  it("[b11.waiter] answers a waiting inbox read as soon as a notice arrives, well before its deadline", async () => {
    const session = agentStub();
    const change: EntityRef = { kind: "change", id: makeId("chg", ulid()) };
    const empty = decodeExit(AgentSessionCodecs.inbox, await session.inbox({ waitMs: 0 }));
    if (!Exit.isSuccess(empty)) throw new Error("the first inbox read failed");

    const started = Date.now();
    const waiting = session.inbox({ cursor: empty.value.cursor, waitMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.receive([delivery(change, 1)]);
    const page = decodeExit(AgentSessionCodecs.inbox, await waiting);
    const waited = Date.now() - started;

    expect(Exit.isSuccess(page) && page.value.notices.map((notice) => notice.ref)).toEqual([
      `change:${change.id}`,
    ]);
    expect(waited).toBeLessThan(5_000);
  });

  it("[b11.waiter] answers an empty page at the deadline when nothing arrives", async () => {
    const session = agentStub();
    const started = Date.now();
    const page = decodeExit(AgentSessionCodecs.inbox, await session.inbox({ waitMs: 400 }));
    const waited = Date.now() - started;

    expect(Exit.isSuccess(page) && page.value.notices).toEqual([]);
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThan(5_000);
  });
});
