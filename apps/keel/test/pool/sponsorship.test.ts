import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SPONSOR_ASK } from "@keeltown/core/application/identity";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { Enrolments, EntityStore, EventOutbox, Sponsorships } from "@keeltown/core/ports";
import { sampleProjectId } from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { sha256Of } from "../../src/adapters/driven/do-rpc/answer.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { SponsorshipsRpc } from "../../src/adapters/driven/do-rpc/sponsorships.ts";
import type { AgentSessionDO } from "../../src/adapters/driving/do/agent-session.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  seedUser,
  uniqueHandle,
} from "./helpers.ts";

const agentSession = (agentId: string) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

const layer = Layer.mergeAll(
  SponsorshipsRpc(agentSession),
  EnrolmentsRpc(agentSession).pipe(Layer.provide(AgentDirectoryD1(env.DB))),
);

const run = <A, E>(effect: Effect.Effect<A, E, Sponsorships | Enrolments>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const person = () => ({ _tag: "User" as const, userId: makeId("usr", ulid()) });

/** What an inbox page says of each notice: its kind, its detail, and the operations its next actions name. */
const told = async (reading: Promise<unknown>) => {
  const page = decodeExit(AgentSessionCodecs.inbox, await reading);
  if (!Exit.isSuccess(page)) throw new Error("the inbox read failed");
  return {
    cursor: page.value.cursor,
    notices: page.value.notices.map((notice) => [
      notice.kind,
      notice.detail,
      notice.nextActions?.map((action) => action.operationId),
    ]),
  };
};

describe("the sponsor link on the real AgentSession DO", () => {
  it("[link.told] tells the agent of a move on its sponsor link that somebody else made, waking a waiting read, and never of its own", async () => {
    const first = person();
    const second = person();
    const { agent } = await run(
      Enrolments.use((enrolments) =>
        enrolments.enrol(first, {
          name: "told-agent",
          kind: "interactive",
          scopes: ["agent:read", "agent:work"],
          projectId: sampleProjectId,
          namespace: makeId("org", ulid()),
          sponsor: first.userId,
          idempotencyKey: `enrol-${ulid()}`,
        }),
      ),
    );
    const agentId = agent.id;
    const session = agentSession(agentId);
    const empty = await told(session.inbox({ waitMs: 0 }));
    expect(empty.notices).toEqual([]);

    // The member who enrolled it leaves: a read already waiting is answered by that move.
    const started = Date.now();
    const waiting = told(session.inbox({ cursor: empty.cursor, waitMs: 20_000 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await run(
      Sponsorships.use((links) => links.end(first, { agentId, idempotencyKey: `end-${ulid()}` })),
    );
    const left = await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(left.notices).toEqual([["AgentUnsponsored", "nobody sponsors you now", ["whoami"]]]);

    // Another person sponsors it, then the agent itself leaves: it is told of the first only.
    await run(
      Sponsorships.use((links) =>
        links.approve({
          agentId,
          by: second.userId,
          asked: { _tag: "Consent" },
          idempotencyKey: `approve-${ulid()}`,
        }),
      ),
    );
    await run(
      Sponsorships.use((links) =>
        links.end({ _tag: "Agent", agentId }, { agentId, idempotencyKey: `leave-${ulid()}` }),
      ),
    );
    const after = await told(session.inbox({ cursor: left.cursor, waitMs: 0 }));
    expect(after.notices).toEqual([
      [
        "AgentSponsored",
        "a person now sponsors you: your questions go to them, and they may pause you",
        ["whoami"],
      ],
    ]);
  });
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** One request through the real Worker, as `bearer` (nobody when null), with a JSON body when given. */
async function http(
  bearer: string | null,
  method: string,
  path: string,
  body?: object,
): Promise<Answer> {
  const headers = new Headers();
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  if (method !== "GET") headers.set("idempotency-key", `key-${ulid()}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await exports.default.fetch(`${BASE}/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: Object(await response.json()) };
}

const refusal = (a: Answer) => [a.status, a.body["code"], a.body["detail"]];

describe("the sponsor link through the real Worker", () => {
  it("[link.sponsor-real] an agent asks, a person on a fresh passkey sign-in approves, pauses and reinstates it, and a paused agent's every request but whoami is answered by the policy", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    await placeProject(projectId);
    await establishProject(projectId);
    const member = await seedUser(uniqueHandle("member"), { signedInBy: "passkey" });
    const enrolment = await http(member.token, "POST", "/agents", {
      name: "link-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId,
    });
    expect(enrolment.status).toBe(201);
    const agentId = String(Object(enrolment.body["agent"]).id);
    const session = agentSession(agentId);
    const credentials = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: String(enrolment.body["clientId"]),
      client_secret: String(enrolment.body["clientSecret"]),
    });
    const exchange = async () => {
      const response = await exports.default.fetch(`${BASE}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: credentials,
      });
      return { status: response.status, body: Object(await response.json()) };
    };
    const token = String((await exchange()).body["access_token"]);
    const me = () => http(token, "GET", "/agents/me");

    // The member who enrolled it sponsors it; the agent itself leaves, and asks.
    expect(Object(Object((await me()).body["result"]).agent).sponsor).toBe(member.userId);
    const left = await http(token, "DELETE", `/agents/${agentId}/sponsor`);
    expect(left.status).toBe(200);
    expect(left.body).not.toHaveProperty("sponsor");
    const asked = await http(token, "POST", "/agents/me/sponsor-request");
    expect(asked.status).toBe(201);
    const { code, url } = Object(asked.body["result"]);
    // 160 bits, in the fragment of Keel's own page, and only its hash at rest.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(url).toBe(`https://${env.KEEL_HOST}/sponsor#agent=${agentId}&code=${code}`);
    const kept = await runInDurableObject(session, (instance: AgentSessionDO) =>
      instance["runtime"].runPromise(
        Effect.map(EntityStore, (store) => JSON.stringify(store.get(SPONSOR_ASK, agentId))),
      ),
    );
    expect(kept).toContain(await sha256Of(code));
    expect(kept).not.toContain(code);

    // A session signed in by a code is asked for a fresh sign-in, and the code stays good.
    const coded = await seedUser(uniqueHandle("coded"), { role: null, signedInBy: "email-otp" });
    const approving = { code };
    expect(
      refusal(await http(coded.token, "PUT", `/agents/${agentId}/sponsor`, approving)).slice(0, 2),
    ).toEqual([403, "auth.fresh_sign_in_required"]);
    const sponsor = await seedUser(uniqueHandle("sponsor"), { role: null, signedInBy: "passkey" });
    const approved = await http(sponsor.token, "PUT", `/agents/${agentId}/sponsor`, approving);
    expect(approved).toMatchObject({ status: 200, body: { id: agentId, sponsor: sponsor.userId } });

    // The three paths under /agents each reach their own operation.
    const mine = await http(sponsor.token, "GET", "/agents/sponsored");
    expect(mine.body).toMatchObject({ items: [{ id: agentId, sponsor: sponsor.userId }] });
    expect(await http(null, "GET", `/agents/${agentId}`)).toEqual({
      status: 200,
      body: { id: agentId, name: "link-agent", kind: "interactive", namespace: "pool" },
    });
    expect(Object(Object((await me()).body["result"]).agent).sponsor).toBe(sponsor.userId);

    // Only the sponsor pauses: the member who enrolled it and a maintainer of its org read no such agent.
    const maintainer = await seedUser(uniqueHandle("maintainer"), {
      role: "maintainer",
      signedInBy: "passkey",
    });
    const pausing = { reason: "runaway retries" };
    for (const other of [member, maintainer])
      expect(
        refusal(await http(other.token, "POST", `/agents/${agentId}/suspend`, pausing)),
      ).toEqual([404, "resource.not_found", undefined]);
    const paused = await http(sponsor.token, "POST", `/agents/${agentId}/suspend`, pausing);
    expect(paused).toMatchObject({ status: 200, body: { state: "suspended" } });

    // Paused, the agent still reads who it is; everything else the policy answers, with what to do next. No secret's token is minted for it.
    expect((await me()).status).toBe(200);
    const refused = await http(token, "DELETE", `/agents/${agentId}/sponsor`);
    expect(refusal(refused)).toEqual([403, "auth.forbidden", "Refused: agent-paused."]);
    expect(refused.body["nextActions"]).toMatchObject([
      { kind: "escalate", title: "You are paused; ask your sponsor to reinstate you" },
    ]);
    const minted = await exchange();
    expect(minted.status).not.toBe(200);
    expect(minted.body).not.toHaveProperty("access_token");

    const reinstated = await http(sponsor.token, "POST", `/agents/${agentId}/reinstate`);
    expect(reinstated).toMatchObject({ status: 200, body: { state: "active" } });
    expect((await me()).status).toBe(200);
  });

  it("[link.actor-user] a pause and its end are recorded as the person's own, `user:<id>`, on the event and in its `by`", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    await placeProject(projectId);
    await establishProject(projectId);
    const sponsor = await seedUser(uniqueHandle("sponsor"), { signedInBy: "passkey" });
    const enrolment = await http(sponsor.token, "POST", "/agents", {
      name: "recorded-agent",
      kind: "interactive",
      scopes: ["agent:read"],
      projectId,
    });
    const agentId = String(Object(enrolment.body["agent"]).id);
    const session = agentSession(agentId);
    const pausing = { reason: "runaway retries" };
    expect((await http(sponsor.token, "POST", `/agents/${agentId}/suspend`, pausing)).status).toBe(
      200,
    );
    expect((await http(sponsor.token, "POST", `/agents/${agentId}/reinstate`)).status).toBe(200);
    const log = await runInDurableObject(session, (instance: AgentSessionDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "agent", id: agentId })),
      ),
    );
    const moves = log
      .filter((event) => event.type === "AgentSuspended" || event.type === "AgentReinstated")
      .map((event) => [event.type, event.actor, Object(event.payload).by]);
    const by = `user:${sponsor.userId}`;
    expect(moves).toEqual([
      ["AgentSuspended", by, by],
      ["AgentReinstated", by, by],
    ]);
  });
});

describe("[run.namespace-read] a sponsor link's profile names the directory's namespace", () => {
  it("[run.namespace-read] the end of a link and an approval of an agent the directory has placed elsewhere since each answer that namespace, never the one it was enrolled into", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    await placeProject(projectId);
    await establishProject(projectId);
    const member = await seedUser(uniqueHandle("member"), { signedInBy: "passkey" });
    const enrolment = await http(member.token, "POST", "/agents", {
      name: "moved-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      projectId,
    });
    expect(enrolment.status).toBe(201);
    const agentId = String(Object(enrolment.body["agent"]).id);
    const enrolledInto = String(Object(enrolment.body["agent"]).namespace);
    expect(enrolledInto).toMatch(/^org_/);

    // The directory places the agent elsewhere; its own object is told nothing. Its token is asked for after.
    const elsewhere = makeId("org", ulid());
    await env.DB.prepare("UPDATE agents SET namespace_id = ? WHERE id = ?")
      .bind(elsewhere, agentId)
      .run();
    const exchanged = await exports.default.fetch(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: String(enrolment.body["clientId"]),
        client_secret: String(enrolment.body["clientSecret"]),
      }),
    });
    const token = (await exchanged.json<{ access_token: string }>()).access_token;

    const left = await http(token, "DELETE", `/agents/${agentId}/sponsor`);
    expect(left).toMatchObject({ status: 200, body: { id: agentId, namespace: elsewhere } });
    const asked = await http(token, "POST", "/agents/me/sponsor-request");
    expect(asked.status).toBe(201);
    const sponsor = await seedUser(uniqueHandle("sponsor"), { role: null, signedInBy: "passkey" });
    const approved = await http(sponsor.token, "PUT", `/agents/${agentId}/sponsor`, {
      code: Object(asked.body["result"]).code,
    });
    expect(approved).toMatchObject({
      status: 200,
      body: { id: agentId, sponsor: sponsor.userId, namespace: elsewhere },
    });
  });
});
