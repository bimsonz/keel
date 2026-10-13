import { env } from "cloudflare:workers";
import { runIdOf } from "@keeltown/core/domain/identity";
import { RunLabel } from "@keeltown/core/kernel";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAgentToken } from "../../src/adapters/driven/better-auth/access-tokens.ts";
import { makeAuth } from "../../src/adapters/driven/better-auth/auth.ts";
import {
  granted,
  ISSUER,
  newKey,
  proofBy,
  requestToken,
  seedKeyAgent,
  type TestKey,
} from "./agent-keys.ts";
import { BASE, type Fetch, mcp, worker } from "./helpers.ts";

const WHOAMI = `${BASE}/v1/agents/me`;
const MCP = `${BASE}/mcp`;

/** The check the gate makes of an agent's token, over a Better Auth made for the call as the gate makes one. */
const verify = (presented: Parameters<typeof verifyAgentToken>[3], resource: string = BASE) =>
  verifyAgentToken(
    makeAuth({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      host: env.KEEL_HOST,
      agents: { find: async () => undefined },
      endSponsorships: async () => {},
    }),
    BASE,
    resource,
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

/** What a request with a key-bound token sends: the DPoP scheme, and a proof by the run's key for this method and address. */
const proved = async (key: TestKey, token: string, method: string, url: string) => ({
  authorization: `DPoP ${token}`,
  dpop: await proofBy(key, method, url, { accessToken: token }),
});

/** The Worker, with `headers` set on whatever the caller sends. */
const sending =
  (headers: Record<string, string>): Fetch =>
  (url, init) => {
    const sent = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) sent.set(name, value);
    return worker(url, { ...init, headers: sent });
  };

/** `table` out of the database's reach while `during` runs, and back whatever happens. */
async function without<A>(table: "verification" | "jwks", during: () => Promise<A>): Promise<A> {
  await env.DB.exec(`ALTER TABLE "${table}" RENAME TO "${table}_away"`);
  try {
    return await during();
  } finally {
    await env.DB.exec(`ALTER TABLE "${table}_away" RENAME TO "${table}"`);
  }
}

/** What a door answered, as the cases below compare it. */
const answered = async (response: Response) => {
  const body = await response.json<{ code?: string; retryAfterMs?: number }>();
  return {
    status: response.status,
    code: body.code,
    retryAfterMs: body.retryAfterMs,
    retryAfter: response.headers.get("retry-after"),
    challenged: response.headers.get("www-authenticate") !== null,
  };
};

/** A token that could not be checked: a wait, and nothing that says the token is bad. */
const NOT_CHECKED = {
  status: 503,
  code: "service.unavailable",
  retryAfterMs: 2000,
  retryAfter: "2",
  challenged: false,
};

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
  it("[dpop.audience] a token is taken only at the door it was issued for: one for the API is refused at the MCP server, and one for the MCP server at the API", async () => {
    const forApi = await bound();
    const forMcp = await bound({ resource: MCP });
    const at = async (held: Awaited<ReturnType<typeof bound>>, door: "api" | "mcp") => {
      const [method, url] = door === "mcp" ? ["POST", MCP] : ["GET", WHOAMI];
      const answer = await verify(
        await withProof(held.run, held.token, method, url),
        door === "mcp" ? MCP : BASE,
      );
      if ("refused" in answer) return answer.refused;
      return "unchecked" in answer ? "unchecked" : answer.agentId;
    };
    expect([await at(forApi, "api"), await at(forApi, "mcp")]).toEqual([
      forApi.agent.id,
      "invalid_token",
    ]);
    expect([await at(forMcp, "mcp"), await at(forMcp, "api")]).toEqual([
      forMcp.agent.id,
      "invalid_token",
    ]);
  });

  it("[dpop.unbound-proof] a plain bearer beside a DPoP header is refused, at the API and at the MCP server: a token bound to no key has nothing to prove", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const token = (await granted(await requestToken(agent.id, account))).access_token;
    const forMcp = (await granted(await requestToken(agent.id, account, { resource: MCP })))
      .access_token;
    const bearer = { authorization: `Bearer ${token}` };
    const detail = "A token bound to no key is presented as a plain bearer, with no DPoP proof.";
    // By itself it is the agent.
    expect((await worker(WHOAMI, { headers: bearer })).status).toBe(200);
    expect((await mcp(forMcp, "tools/list")).status).toBe(200);
    const stray = await proofBy(account, "GET", WHOAMI, { accessToken: token });
    expect(
      await verify({ token, scheme: "Bearer", proof: stray, method: "GET", url: WHOAMI }),
    ).toEqual({ refused: "invalid_token", detail });
    for (const dpop of [stray, "not-a-proof"]) {
      const refused = await worker(WHOAMI, { headers: { ...bearer, dpop } });
      expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([
        401,
        expect.stringContaining(`error="invalid_token", error_description="${detail}"`),
      ]);
      expect(await refused.json()).toMatchObject({ code: "auth.invalid_token", detail });
    }
    const atMcp = await mcp(forMcp, "tools/list", {}, undefined, sending({ dpop: stray }));
    expect([atMcp.status, atMcp.headers.get("www-authenticate") !== null]).toEqual([401, true]);
  });

  it("[token.unchecked] a good bound token whose proof's id cannot be kept is answered 503 with a wait at both doors, never told it is bad, and is the agent again once the store answers", async () => {
    const { account, agent, run, token } = await bound();
    const forMcp = (
      await granted(await requestToken(agent.id, account, { runKey: run, resource: MCP }))
    ).access_token;
    const me = async () => worker(WHOAMI, { headers: await proved(run, token, "GET", WHOAMI) });
    const tools = async () =>
      mcp(null, "tools/list", {}, undefined, sending(await proved(run, forMcp, "POST", MCP)));
    expect([(await me()).status, (await tools()).status]).toEqual([200, 200]);
    const down = await without("verification", async () => ({
      api: await answered(await me()),
      mcp: await answered(await tools()),
      check: await verify(await withProof(run, token)),
    }));
    expect(down).toEqual({ api: NOT_CHECKED, mcp: NOT_CHECKED, check: { unchecked: true } });
    expect([(await me()).status, (await tools()).status]).toEqual([200, 200]);
  });

  it("[token.unchecked] a token under a key id Keel has not seen, while the signing keys cannot be read, is answered 503 with a wait; with the keys read it is no token", async () => {
    const stranger = await newKey();
    const unseen = await new SignJWT({ scope: "agent:read", epoch: 0 })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: crypto.randomUUID() })
      .setSubject("agent-0000000000000000")
      .setIssuer(ISSUER)
      .setAudience(BASE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(stranger.privateKey);
    const sent = () => worker(WHOAMI, { headers: { authorization: `Bearer ${unseen}` } });
    const presented = { token: unseen, scheme: "Bearer" as const, method: "GET", url: WHOAMI };
    expect((await sent()).status).toBe(401);
    const down = await without("jwks", async () => ({
      api: await answered(await sent()),
      check: await verify(presented),
    }));
    expect(down).toEqual({ api: NOT_CHECKED, check: { unchecked: true } });
    expect([(await sent()).status, await verify(presented)]).toEqual([
      401,
      expect.objectContaining({ refused: "invalid_token" }),
    ]);
  });
});
