import { env } from "cloudflare:workers";
import { runIdOf, RunLabel } from "@keeltown/core/domain/identity";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { verifyAgentToken } from "../../src/adapters/driven/better-auth/access-tokens.ts";
import { makeAuth } from "../../src/adapters/driven/better-auth/auth.ts";
import {
  granted,
  newKey,
  proofBy,
  requestToken,
  seedKeyAgent,
  type TestKey,
} from "./agent-keys.ts";
import { BASE } from "./helpers.ts";

const WHOAMI = `${BASE}/v1/agents/me`;

/** The check the gate makes of an agent's token, over a Better Auth made for the call as the gate makes one. */
const verify = (presented: Parameters<typeof verifyAgentToken>[2]) =>
  verifyAgentToken(
    makeAuth({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      host: env.KEEL_HOST,
      agents: { find: async () => undefined },
    }),
    BASE,
    presented,
  );

/** An agent with a token for `run`'s key, as the token endpoint grants it. */
async function bound(request: Parameters<typeof requestToken>[2] = {}) {
  const account = await newKey();
  const run = await newKey();
  const agent = await seedKeyAgent(account, { revocationEpoch: 2 });
  const { access_token: token } = await granted(
    await requestToken(agent.id, account, { runKey: run, ...request }),
  );
  return { account, agent, run, token };
}

const withProof = async (key: TestKey, token: string, method = "GET", url = WHOAMI) => ({
  token,
  scheme: "DPoP" as const,
  proof: await proofBy(key, method, url, { accessToken: token }),
  method,
  url,
});

describe("an agent's token at the gate", () => {
  it("[dpop.bound-token] a bound token with a fresh proof made by its run's key is the agent, its project and its run", async () => {
    const lane = Schema.decodeUnknownSync(RunLabel)("run-b");
    const { agent, run, token } = await bound({ project: sampleProjectId, run: lane });
    expect(await verify(await withProof(run, token))).toEqual({
      agentId: agent.id,
      projectId: sampleProjectId,
      scopes: ["agent:work", "agent:read"],
      revocationEpoch: 2,
      handle: agent.handle,
      run: { id: runIdOf(agent.id, { label: lane }), label: lane },
      bound: true,
    });
    const account = await verify(await withProof(run, token, "POST", `${BASE}/mcp`));
    expect(account).toMatchObject({ agentId: agent.id, bound: true });
  });

  it("[dpop.bound-token] a stolen bound token is refused without its key: no proof, as a bearer, another key, another run's key", async () => {
    const { run, token, agent, account } = await bound();
    const thief = await newKey();
    const sibling = await newKey();
    await granted(await requestToken(agent.id, account, { runKey: sibling }));
    const tries = {
      "no proof": { token, scheme: "DPoP" as const, method: "GET", url: WHOAMI },
      "as a plain bearer": { token, scheme: "Bearer" as const, method: "GET", url: WHOAMI },
      "a proof by the thief's key": await withProof(thief, token),
      "a proof by another run's key": await withProof(sibling, token),
    };
    for (const [what, presented] of Object.entries(tries))
      expect([what, "refused" in (await verify(presented))]).toEqual([what, true]);
    expect("refused" in (await verify(await withProof(run, token)))).toBe(false);
  });

  it("[dpop.bound-token] a captured proof is refused again, and so is one made for another request or another token", async () => {
    const { run, token, agent, account } = await bound();
    const once = await withProof(run, token);
    expect("refused" in (await verify(once))).toBe(false);
    expect(await verify(once)).toMatchObject({ refused: "invalid_dpop_proof" });
    const other = (await granted(await requestToken(agent.id, account, { runKey: run })))
      .access_token;
    const tries = {
      "a proof for another method": { ...(await withProof(run, token, "POST")), method: "GET" },
      "a proof for another URL": {
        ...(await withProof(run, token, "GET", `${BASE}/v1/changes`)),
        url: WHOAMI,
      },
      "a proof for another token": { ...(await withProof(run, other)), token },
      "a proof that names no token": {
        token,
        scheme: "DPoP" as const,
        proof: await proofBy(run, "GET", WHOAMI),
        method: "GET",
        url: WHOAMI,
      },
      "a proof made ten minutes ago": {
        token,
        scheme: "DPoP" as const,
        proof: await proofBy(run, "GET", WHOAMI, {
          accessToken: token,
          issuedAt: Math.floor(Date.now() / 1000) - 600,
        }),
        method: "GET",
        url: WHOAMI,
      },
    };
    for (const [what, presented] of Object.entries(tries))
      expect([what, await verify(presented)]).toEqual([
        what,
        expect.objectContaining({ refused: "invalid_dpop_proof" }),
      ]);
  });

  it("[dpop.unbound] a plain bearer is the agent for its 300 seconds, with no run and no key, and is refused under the DPoP scheme", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const token = (await granted(await requestToken(agent.id, account))).access_token;
    expect(await verify({ token, scheme: "Bearer", method: "GET", url: WHOAMI })).toEqual({
      agentId: agent.id,
      scopes: ["agent:work", "agent:read"],
      revocationEpoch: 0,
      handle: agent.handle,
      bound: false,
    });
    expect(
      "refused" in
        (await verify({
          token,
          scheme: "DPoP",
          proof: await proofBy(account, "GET", WHOAMI, { accessToken: token }),
          method: "GET",
          url: WHOAMI,
        })),
    ).toBe(true);
  });

  it("[dpop.token] a token Keel did not sign, or one changed after signing, is no token", async () => {
    const { run, token } = await bound();
    const [header, payload, signature] = token.split(".");
    const forged = `${header}.${payload}.${(signature ?? "").split("").toReversed().join("")}`;
    expect(await verify(await withProof(run, forged))).toMatchObject({
      refused: "invalid_token",
    });
    expect(
      await verify({ token: "not.a.token", scheme: "Bearer", method: "GET", url: WHOAMI }),
    ).toMatchObject({ refused: "invalid_token" });
  });
});
