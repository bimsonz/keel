import { env, exports } from "cloudflare:workers";
import { type AgentId, makeId, type UserId } from "@keeltown/core/kernel";
import { Sessions } from "@keeltown/core/ports";
import { hashSecret, sampleProjectId } from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { SessionsRpc } from "../../src/adapters/driven/do-rpc/sessions.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  type Fetch,
  placeProject,
  POOL_ORG,
  type SeededAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
} from "./helpers.ts";

const agentSession = (agentId: string) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

/** A member of org `pool`, who sponsors an agent there. */
const member = async (): Promise<UserId> => (await seedUser(uniqueHandle("sponsor"))).userId;

/**
 * Enrols a fresh agent in its own AgentSession DO, as a member's enrolment
 * does: in org `pool`, sponsored by `sponsor` (a new member when none is
 * given), its project placed there and held.
 */
async function enrolled(sponsor?: UserId): Promise<SeededAgent> {
  const by = sponsor ?? (await member());
  await placeProject(sampleProjectId);
  await establishProject(sampleProjectId);
  const agentId: AgentId = makeId("agt", ulid());
  const clientId = `client-${agentId.toLowerCase()}`;
  const clientSecret = `secret-${crypto.randomUUID()}`;
  const answer = decodeExit(
    AgentSessionCodecs.enrol,
    await agentSession(agentId).enrol({
      projectId: sampleProjectId,
      name: "session-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      org: POOL_ORG,
      sponsor: by,
      clientId,
      secretHash: await hashSecret(clientSecret),
      idempotencyKey: "enrol-1",
      fingerprint: "enrol-body",
    }),
  );
  if (!Exit.isSuccess(answer)) throw new Error(`enrol failed: ${JSON.stringify(answer.cause)}`);
  return { agent: answer.value, clientId, clientSecret };
}

interface Answer {
  readonly id: string;
  readonly agentId: string;
  readonly sponsor?: string;
  readonly openedAt: string;
  readonly code: string;
  readonly nextActions: readonly { readonly operationId?: string; readonly args?: object }[];
  readonly result: { readonly session: { readonly id: string } | null };
}

async function call(
  via: Fetch,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: object,
  key?: string,
) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (key !== undefined) headers.set("idempotency-key", key);
  const response = await via(`${BASE}/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json<Answer>() };
}

const worker: Fetch = (url, init) => exports.default.fetch(url, init);

describe("POST /v1/sessions", () => {
  it("[b11.session-open] opens the agent's current session, which whoami then names; a retry answers it", async () => {
    const sponsor = await member();
    const seeded = await enrolled(sponsor);
    const token = await tokenFor(seeded);
    const before = await call(worker, token, "GET", "/agents/me");
    expect(before.body.result.session).toBeNull();

    const body = { harness: "claude-code", model: "a-model-2026-10" };
    const opened = await call(worker, token, "POST", "/sessions", body, "session-key-1");
    expect(opened.status).toBe(201);
    expect(opened.body).toEqual({
      id: expect.stringMatching(/^ses_/),
      agentId: seeded.agent.id,
      sponsor,
      openedAt: expect.any(String),
    });
    const me = await call(worker, token, "GET", "/agents/me");
    expect(me.body.result.session).toEqual({ id: opened.body.id });

    const retried = await call(worker, token, "POST", "/sessions", body, "session-key-1");
    expect(retried).toEqual(opened);
    const later = await call(worker, token, "POST", "/sessions", {}, "session-key-2");
    expect(later.status).toBe(201);
    expect(later.body.id).not.toBe(opened.body.id);
    expect((await call(worker, token, "GET", "/agents/me")).body.result.session).toEqual({
      id: later.body.id,
    });
  });

  it("[b11.session-idem] answers a used key with another body 409 request.idempotency_conflict", async () => {
    const token = await tokenFor(await enrolled());
    await call(worker, token, "POST", "/sessions", { harness: "a" }, "session-key-1");
    const reused = await call(
      worker,
      token,
      "POST",
      "/sessions",
      { harness: "b" },
      "session-key-1",
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("request.idempotency_conflict");
    expect(reused.body.nextActions[0]?.operationId).toBe("Sessions_openSession");
  });

  it("[b11.session-sponsor] takes the sponsor from the agent's enrolment, and refuses a body that names one", async () => {
    const sponsor = await member();
    const token = await tokenFor(await enrolled(sponsor));
    const named = { sponsor: makeId("usr", ulid()) };
    const refused = await call(worker, token, "POST", "/sessions", named, "session-key-1");
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("request.invalid");
    const opened = await call(worker, token, "POST", "/sessions", {}, "session-key-1");
    expect(opened.status).toBe(201);
    expect(opened.body.sponsor).toBe(sponsor);
  });
});

describe("[b11.gate-no-hop] the request gate reads only the AgentDirectory", () => {
  it("authenticates without calling an AgentSession DO, while whoami does call it", async () => {
    let hops = 0;
    const counted = Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        return Sessions.of({
          open: (principal, input) =>
            Effect.suspend(() => {
              hops += 1;
              return sessions.open(principal, input);
            }),
          current: (agentId) =>
            Effect.suspend(() => {
              hops += 1;
              return sessions.current(agentId);
            }),
        });
      }),
    ).pipe(Layer.provide(SessionsRpc(agentSession)));
    const { app } = makeIsolate(env, isolateLayer(env, { sessions: counted }));
    const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
    const token = await tokenFor(await enrolled());

    const inbox = await call(via, token, "GET", "/inbox");
    expect(inbox.status).toBe(200);
    expect(hops).toBe(0);
    // The control: whoami reads the current session, so the count can move.
    const me = await call(via, token, "GET", "/agents/me");
    expect(me.status).toBe(200);
    expect(hops).toBe(1);
  });
});
