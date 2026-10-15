import { env, exports } from "cloudflare:workers";
import { type AgentId, type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionCodecs, ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { BASE, drainAfter, seedAgent, tokenFor } from "./helpers.ts";

/** How long a test waits for something the objects do by themselves (a flush, a delivery). */
const WAIT = { timeout: 10_000, interval: 20 };

const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

/** Every notice in the agent's inbox, read from the start. */
async function inboxOf(agentId: AgentId) {
  const page = decodeExit(AgentSessionCodecs.inbox, await agentStub(agentId).inbox({ waitMs: 0 }));
  if (!Exit.isSuccess(page)) throw new Error(`inbox read failed: ${JSON.stringify(page.cause)}`);
  return page.value.notices;
}

/** A platform-caused event about some change (no actor), encoded as the fan-out delivers it. */
const platformEvent = (n: number) => {
  const entity: EntityRef = { kind: "change", id: makeId("chg", ulid()) };
  return Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "ChangeBounced",
      entity,
      seq: n,
      at: Date.now(),
      dedupeKey: `change:${entity.id}/cause-${n}/ChangeBounced#1`,
      affected: [],
      notified: [],
      payload: { _tag: "ChangeBounced" },
    }),
  );
};

/** Delivers `count` platform events to the agent, as its subscriptions would; answers their ids in order. */
async function deliver(agentId: AgentId, count: number): Promise<string[]> {
  const events = Array.from({ length: count }, (_, i) => platformEvent(i + 1));
  await agentStub(agentId).receive(events);
  return events.map((event) => event.eventId);
}

interface WireNotice {
  readonly id: string;
  readonly cursor?: string;
}

/** The agent's next tool result, through the real fetch handler. */
async function call(token: string, path: string) {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json<{ notices?: WireNotice[] }>();
  return {
    status: response.status,
    notices: (body.notices ?? []).map((notice) => notice.id),
    body,
  };
}

describe("no self-loops", () => {
  it("[b12.no-self-loop] never notifies an agent of its own commands, and does notify it of the platform's", async () => {
    // Precheck's steps are driven by hand here, so the instance the submit starts stays inert.
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    const sha = await c.push();
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          projectId: c.projectId,
          leaseId: lease,
          commitSha: sha,
          idempotencyKey: "submit-1",
        }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.precheckRefused,
        await c.stub.precheckRefused({
          revision: 1,
          instanceId: "p-1",
          reasons: ["precheck:protected:src/secret.ts"],
          nextActions: [{ kind: "call", title: "Submit it again", operationId: "submit" }],
        }),
      ),
    );

    // The platform's events reach the agent once the Change DO's outbox has flushed.
    await vi.waitFor(async () => {
      expect((await inboxOf(c.agentId)).map((notice) => notice.kind)).toContain("ChangeBounced");
    }, WAIT);
    const log = await c.log();
    const own = log.filter((event) => event.actor === `agent:${c.agentId}`).map((e) => e.type);
    const platform = log.filter((event) => event.actor === undefined).map((e) => e.type);
    const kinds = (await inboxOf(c.agentId)).map((notice) => notice.kind);

    expect(own).toEqual(["IntentDeclared", "PreflightIssued", "ChangeStarted", "ChangeSubmitted"]);
    expect(platform).toEqual(["PrecheckStarted", "ChangeBounced", "LeaseRestarted"]);
    for (const type of own) expect(kinds).not.toContain(type);
    expect(kinds).toEqual(expect.arrayContaining(["PrecheckStarted", "ChangeBounced"]));
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("the piggyback, through the real handler", () => {
  it("[b12.piggyback] carries a delivered notice on the agent's next tool result, once", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const [delivered] = await deliver(seeded.agent.id, 1);

    const first = await call(token, "/v1/agents/me");
    const second = await call(token, "/v1/agents/me");

    expect(first.status).toBe(200);
    expect(first.notices).toEqual([delivered]);
    expect(first.body.notices?.[0]?.cursor).toMatch(/^\d{12}$/);
    expect(second.notices).toEqual([]);
  });

  it("[b12.piggyback] rides a typed refusal too, at most three a response, oldest first", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const delivered = await deliver(seeded.agent.id, 5);

    const refused = await call(token, `/v1/changes/${makeId("chg", ulid())}/submission`);
    const next = await call(token, "/v1/agents/me");
    const after = await call(token, "/v1/agents/me");

    expect(refused.status).toBe(404);
    expect(refused.notices).toEqual(delivered.slice(0, 3));
    expect(next.notices).toEqual(delivered.slice(3));
    expect(after.notices).toEqual([]);
  });

  it("[b12.piggyback-after-inbox] never carries a notice the agent already read in its inbox", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const delivered = await deliver(seeded.agent.id, 2);

    const inbox = await exports.default.fetch(`${BASE}/v1/inbox`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const read = await inbox.json<{ result: { notices: WireNotice[] }; notices: WireNotice[] }>();
    const next = await call(token, "/v1/agents/me");
    const [later] = await deliver(seeded.agent.id, 1);
    const afterThat = await call(token, "/v1/agents/me");

    expect(read.result.notices.map((notice) => notice.id)).toEqual(delivered);
    // The page is the read: none of its notices rides the inbox's own response again.
    expect(read.notices).toEqual([]);
    expect(next.notices).toEqual([]);
    expect(afterThat.notices).toEqual([later]);
  });
});

const ids = (notices: readonly WireNotice[] | undefined) =>
  (notices ?? []).map((notice) => notice.id);

describe("the inbox from its head, through the real handler", () => {
  interface Read {
    readonly result: { readonly notices: WireNotice[]; readonly cursor: string };
    readonly notices?: WireNotice[];
  }
  const inboxAt = async (token: string, query: string) => {
    const response = await exports.default.fetch(`${BASE}/v1/inbox?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json<Read>() };
  };

  it("[inbox.end-pool] `cursor=end` answers the head's cursor and no notice, and counts none as read: what waited rides that very response", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const waited = await deliver(seeded.agent.id, 2);

    const head = await inboxAt(token, "cursor=end");
    const [later] = await deliver(seeded.agent.id, 1);
    const on = await inboxAt(token, `cursor=${head.body.result.cursor}`);

    expect(head.status).toBe(200);
    expect(head.body.result.notices).toEqual([]);
    expect(head.body.result.cursor).toMatch(/^\d{12}$/);
    expect(ids(head.body.notices)).toEqual(waited);
    expect(ids(on.body.result.notices)).toEqual([later]);
  });

  it("[inbox.end-held] a read held from `end` is answered by what lands after it, and by nothing that was there", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    await deliver(seeded.agent.id, 1);

    const started = Date.now();
    const waiting = inboxAt(token, "cursor=end&wait=20");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [landed] = await deliver(seeded.agent.id, 1);
    const page = await waiting;

    expect(ids(page.body.result.notices)).toEqual([landed]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("[inbox.peek-pool] a peek held from `end` is answered by what lands and counts nothing as read: the notice still rides the next tool result", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);

    const waiting = agentStub(seeded.agent.id).inbox({ cursor: "end", waitMs: 20_000, peek: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [landed] = await deliver(seeded.agent.id, 1);
    const page = decodeExit(AgentSessionCodecs.inbox, await waiting);
    const next = await call(token, "/v1/agents/me");

    expect(Exit.isSuccess(page) && page.value.notices.map((notice) => notice.id)).toEqual([landed]);
    expect(next.notices).toEqual([landed]);
  });

  it("[wait.spec] a wait of 900 seconds is taken, and answered at once when a notice waits; 901 is refused", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const waited = await deliver(seeded.agent.id, 1);

    const long = await inboxAt(token, "wait=900");
    const over = await exports.default.fetch(`${BASE}/v1/inbox?wait=901`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect([long.status, ids(long.body.result.notices)]).toEqual([200, waited]);
    expect(over.status).toBe(400);
  });
});
