import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_AGENT_ID, BOOTSTRAP_CLIENT_ID } from "@keeltown/core/domain/identity";
import { type AgentId, type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { hashSecret, sampleProjectId } from "@keeltown/testing";
import { Cause, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import { drainAfter, exchange } from "./helpers.ts";

const agentStub = (agentId = makeId("agt", ulid())) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

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

/** Enrols `agentId` over RPC as the isolate would, with this secret's hash; answers the agent and its credential. */
async function enrolOverRpc(agentId: AgentId, idempotencyKey: string, secret: string) {
  const clientId = `client-${agentId.toLowerCase()}`;
  const answer = decodeExit(
    AgentSessionCodecs.enrol,
    await agentStub(agentId).enrol({
      projectId: sampleProjectId,
      name: "pool-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      clientId,
      secretHash: await hashSecret(secret),
      idempotencyKey,
      fingerprint: "enrol-body",
    }),
  );
  if (!Exit.isSuccess(answer)) throw new Error(`enrol failed: ${JSON.stringify(answer.cause)}`);
  return { agent: answer.value, clientId, clientSecret: secret };
}

describe("enrolling an agent over RPC", () => {
  it("[b11.enrol-inline] lets the new credential exchange for a token as soon as enrol answers", async () => {
    const enrolled = await enrolOverRpc(makeId("agt", ulid()), "enrol-1", "secret-first");
    const exchanged = await exchange(enrolled);

    expect(enrolled.agent.state).toBe("active");
    expect(exchanged.status).toBe(200);
  });

  it("[b11.enrol-replay] retires the old secret when a replay of the key re-issues it", async () => {
    const agentId = makeId("agt", ulid());
    const first = await enrolOverRpc(agentId, "enrol-1", "secret-first");
    const replayed = await enrolOverRpc(agentId, "enrol-1", "secret-second");

    expect(replayed.agent).toEqual(first.agent);
    expect((await exchange(first)).status).toBe(401);
    expect((await exchange(replayed)).status).toBe(200);
  });

  it("[b11.enrol-bootstrap] refuses the bootstrap identity as a defect, committing nothing and writing no row", async () => {
    const session = agentStub(BOOTSTRAP_AGENT_ID);
    const enrolling = {
      projectId: sampleProjectId,
      name: "pool-agent",
      kind: "interactive" as const,
      scopes: ["operator" as const],
      clientId: BOOTSTRAP_CLIENT_ID,
      secretHash: await hashSecret("not-the-bootstrap-secret"),
      idempotencyKey: "enrol-1",
      fingerprint: "enrol-body",
    };
    const answers = [await session.enrol(enrolling), await session.enrol(enrolling)];

    for (const answer of answers) {
      const exit = decodeExit(AgentSessionCodecs.enrol, answer);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }
    const events = await runInDurableObject(session, (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM keel_events").one(),
    );
    expect(events["n"]).toBe(0);
    const rows = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM agents WHERE id = ?) + (SELECT COUNT(*) FROM credentials WHERE client_id = ?) AS n",
    )
      .bind(BOOTSTRAP_AGENT_ID, BOOTSTRAP_CLIENT_ID)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
