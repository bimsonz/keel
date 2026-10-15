// An agent's standing through the real doorway: a maintainer of the project's
// org enrols the agent over REST (its AgentSession DO holds it), then suspends,
// reinstates and revokes it; the agent's own token is judged by the directory row each move
// wrote before answering. The Projector's repair is fed an event directly.
import { env, exports } from "cloudflare:workers";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { AgentDirectory, PROJECTOR } from "@keeltown/core/ports";
import { Effect, Option, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
} from "./helpers.ts";

interface Answer {
  readonly status: number;
  readonly body: {
    readonly id?: string;
    readonly state?: string;
    readonly revocationEpoch?: number;
    readonly namespace?: string;
    readonly code?: string;
    readonly nextActions?: readonly { readonly operationId?: string }[];
    readonly agent?: { readonly id: string; readonly namespace?: string };
    readonly clientId?: string;
    readonly clientSecret?: string;
  };
}

async function call(token: string, path: string, key?: string, body?: object): Promise<Answer> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (key !== undefined) headers.set("idempotency-key", key);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await exports.default.fetch(`${BASE}/v1${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * The status the agent's own token now gets, by its directory row: 200 while
 * active, the policy's 403 while paused, the gate's 401 once revoked.
 */
/**
 * What the agent's next request is answered with: one a paused agent may not
 * make (it still reads who it is and its inbox, so it hears when it is unpaused).
 */
async function gate(token: string): Promise<number> {
  const response = await exports.default.fetch(`${BASE}/v1/agents/me/namespaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return response.status;
}

/**
 * A maintainer of org `pool` on a fresh passkey sign-in, and an agent it
 * enrolled over REST in a project of the org, so it is the agent's sponsor,
 * with a token of the agent's.
 */
async function enrolled() {
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId);
  await establishProject(projectId);
  const operator = (
    await seedUser(uniqueHandle("maintainer"), { role: "maintainer", signedInBy: "passkey" })
  ).token;
  const enrolment = await call(operator, "/agents", `enrol-${ulid()}`, {
    name: "standing-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    projectId,
  });
  const agentId = enrolment.body.agent?.id ?? "";
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
  const exchanged = await exports.default.fetch(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: enrolment.body.clientId ?? "",
      client_secret: enrolment.body.clientSecret ?? "",
    }),
  });
  const token = (await exchanged.json<{ access_token: string }>()).access_token;
  return { operator, agentId, token };
}

describe("[b11.standing-route] a maintainer's moves on an agent's standing", () => {
  it("[b11.standing-route] suspend refuses the agent's next request at once, reinstate admits it again, revoke is final and bumps the epoch", async () => {
    const { operator, agentId, token } = await enrolled();
    expect(await gate(token)).toBe(200);

    const suspended = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "runaway retries",
    });
    expect(suspended).toMatchObject({ status: 200, body: { id: agentId, state: "suspended" } });
    expect(await gate(token)).toBe(403);

    const again = await call(operator, `/agents/${agentId}/suspend`, "suspend-0002", {
      reason: "still running away",
    });
    expect(again).toMatchObject({
      status: 409,
      body: {
        code: "agent.state_refused",
        nextActions: [{ operationId: "Operator_reinstateAgent" }],
      },
    });

    const reinstated = await call(operator, `/agents/${agentId}/reinstate`, "reinstate-0001");
    expect(reinstated).toMatchObject({ status: 200, body: { state: "active" } });
    expect(await gate(token)).toBe(200);

    const revoked = await call(operator, `/agents/${agentId}/revoke`, "revoke-0001");
    expect(revoked).toMatchObject({ status: 200, body: { state: "revoked", revocationEpoch: 1 } });
    expect(await gate(token)).toBe(401);
    const twice = await call(operator, `/agents/${agentId}/revoke`, "revoke-0002");
    expect(twice).toMatchObject({ status: 409, body: { code: "agent.state_refused" } });
  });

  it("[b11.standing-route] answers a replayed key as before, a reused key with another reason 409, and an unknown agent 404", async () => {
    const { operator, agentId } = await enrolled();
    const first = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "runaway retries",
    });
    const replayed = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "runaway retries",
    });
    const reused = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "another reason",
    });
    const unknown = await call(operator, `/agents/${makeId("agt", ulid())}/revoke`, "revoke-0001");
    expect(first.status).toBe(200);
    expect(replayed).toMatchObject({ status: 200, body: { state: "suspended" } });
    expect(reused).toMatchObject({ status: 409, body: { code: "request.idempotency_conflict" } });
    expect(unknown).toMatchObject({ status: 404, body: { code: "resource.not_found" } });
  });
});

describe("[run.namespace-read] a profile's namespace is the directory's", () => {
  it("[run.namespace-read] a move on the standing of an agent the directory has placed elsewhere since answers that namespace, never the one it was enrolled into", async () => {
    const { operator, agentId } = await enrolled();
    const row = () =>
      env.DB.prepare("SELECT namespace_id FROM agents WHERE id = ?")
        .bind(agentId)
        .first<{ namespace_id: string }>();
    const enrolledInto = (await row())?.namespace_id;
    expect(enrolledInto).toMatch(/^org_/);

    const suspended = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "runaway retries",
    });
    expect(suspended).toMatchObject({
      status: 200,
      body: { state: "suspended", namespace: enrolledInto },
    });

    // The directory places the agent elsewhere; its own object is told nothing.
    const elsewhere = makeId("org", ulid());
    await env.DB.prepare("UPDATE agents SET namespace_id = ? WHERE id = ?")
      .bind(elsewhere, agentId)
      .run();
    const replayed = await call(operator, `/agents/${agentId}/suspend`, "suspend-0001", {
      reason: "runaway retries",
    });
    expect(replayed).toMatchObject({
      status: 200,
      body: { state: "suspended", namespace: elsewhere },
    });
    const reinstated = await call(operator, `/agents/${agentId}/reinstate`, "reinstate-0001");
    expect(reinstated).toMatchObject({
      status: 200,
      body: { state: "active", namespace: elsewhere },
    });
    expect((await row())?.namespace_id).toBe(elsewhere);
  });
});

describe("[b11.standing-repair] the Projector repeats a standing in the directory", () => {
  it("[b11.standing-repair] an AgentSuspended the Projector receives suspends the agent's row, even if the inline write never happened", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    expect(await gate(token)).toBe(200);
    const agentId = seeded.agent.id;
    const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));
    await projector.receive([
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type: "AgentSuspended",
          entity: { kind: "agent", id: agentId },
          seq: 2,
          at: Date.now(),
          dedupeKey: `agent:${agentId}/standing:repair-0001/AgentSuspended#2`,
          affected: [],
          notified: [],
          payload: { _tag: "AgentSuspended", agentId, reason: "repair", by: "operator:test" },
        }),
      ),
    ]);
    await vi.waitFor(async () => expect(await gate(token)).toBe(403), {
      timeout: 5_000,
      interval: 50,
    });
  });
});

describe("[link.sponsor-repair] the Projector repeats a sponsor link in the directory", () => {
  it("[link.sponsor-repair] an AgentSponsored the Projector receives writes the agent's sponsor, even if the inline write never happened", async () => {
    const seeded = await seedAgent();
    const agentId = seeded.agent.id;
    const sponsor = makeId("usr", ulid());
    const row = () =>
      Effect.runPromise(
        AgentDirectory.use((directory) => directory.findAgent(agentId)).pipe(
          Effect.map((found) => Option.getOrUndefined(found)?.sponsor),
          Effect.provide(AgentDirectoryD1(env.DB)),
        ),
      );
    expect(await row()).not.toBe(sponsor);
    const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));
    await projector.receive([
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type: "AgentSponsored",
          entity: { kind: "agent", id: agentId },
          seq: 2,
          at: Date.now(),
          dedupeKey: `agent:${agentId}/sponsor:repair-0001/AgentSponsored#2`,
          affected: [],
          notified: [],
          payload: { _tag: "AgentSponsored", agentId, sponsor },
        }),
      ),
    ]);
    await vi.waitFor(async () => expect(await row()).toBe(sponsor), {
      timeout: 5_000,
      interval: 50,
    });
  });
});
