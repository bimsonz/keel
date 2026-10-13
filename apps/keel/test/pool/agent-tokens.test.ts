import { env } from "cloudflare:workers";
import { runIdOf } from "@keeltown/core/domain/identity";
import { RunLabel } from "@keeltown/core/kernel";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import {
  assertionBy,
  freshAddress,
  granted,
  ISSUER,
  newKey,
  requestToken,
  seedKeyAgent,
  type TestKey,
} from "./agent-keys.ts";
import { BASE, seedUser, uniqueHandle, worker } from "./helpers.ts";

/** What a refused token request says, in OAuth's own shape. */
const refusal = async (response: Response) => ({
  status: response.status,
  error: (await response.json<{ error?: string }>()).error,
});

describe("a token for an agent that holds only a key", () => {
  it("[token.shape] a request signed by the agent's key gets a 300-second token, the agent its subject, bound to the run's key", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account);
    const token = await granted(await requestToken(agent.id, account, { runKey: run }));
    expect(token.token_type).toBe("DPoP");
    expect(token.expires_in).toBe(300);
    expect(token.scope.split(" ").toSorted()).toEqual(["agent:read", "agent:work"]);
    expect(decodeProtectedHeader(token.access_token)).toMatchObject({
      alg: "EdDSA",
      typ: "at+jwt",
    });
    const claims = decodeJwt(token.access_token);
    expect(claims).toMatchObject({ iss: ISSUER, sub: agent.id, cnf: { jkt: run.key.jkt } });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
  });

  it("[token.resource] a token is for Keel's own API when the request names it or names nothing, for Keel's MCP server when it names that, and for nothing else", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account);
    const named = await granted(await requestToken(agent.id, account, { runKey: run }));
    expect(decodeJwt(named.access_token).aud).toBe(BASE);
    const unnamed = await granted(
      await requestToken(agent.id, account, { runKey: run, resource: null }),
    );
    expect(decodeProtectedHeader(unnamed.access_token).typ).toBe("at+jwt");
    expect(decodeJwt(unnamed.access_token).aud).toBe(BASE);
    const forMcp = await granted(
      await requestToken(agent.id, account, { runKey: run, resource: `${BASE}/mcp` }),
    );
    expect(decodeJwt(forMcp.access_token).aud).toBe(`${BASE}/mcp`);
    expect(
      await refusal(
        await requestToken(agent.id, account, {
          runKey: run,
          resource: "https://elsewhere.example",
        }),
      ),
    ).toEqual({ status: 400, error: "invalid_target" });
  });

  it("[token.claims] the token names the project and the run the request asked for, with the agent's epoch and handle", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account, { revocationEpoch: 4 });
    const lane = Schema.decodeUnknownSync(RunLabel)("run-c");
    const labelled = decodeJwt(
      (
        await granted(
          await requestToken(agent.id, account, {
            runKey: run,
            project: sampleProjectId,
            run: lane,
          }),
        )
      ).access_token,
    );
    expect(labelled).toMatchObject({
      sub: agent.id,
      prj: sampleProjectId,
      run: runIdOf(agent.id, { label: lane }),
      run_label: lane,
      epoch: 4,
      handle: agent.handle,
    });
    const unlabelled = decodeJwt(
      (await granted(await requestToken(agent.id, account, { runKey: run }))).access_token,
    );
    expect(unlabelled).toMatchObject({
      run: runIdOf(agent.id, { runKey: run.key.jkt }),
      epoch: 4,
      handle: agent.handle,
    });
    expect("prj" in unlabelled || "run_label" in unlabelled).toBe(false);
    const bearer = decodeJwt((await granted(await requestToken(agent.id, account))).access_token);
    expect("run" in bearer).toBe(false);
    expect(bearer).toMatchObject({ epoch: 4, handle: agent.handle });
  });

  it("[token.target] a project that is no project id, and a run label that is no label, are refused in OAuth's own words", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account);
    expect(
      await refusal(await requestToken(agent.id, account, { runKey: run, project: "keel" })),
    ).toEqual({ status: 400, error: "invalid_target" });
    expect(
      await refusal(await requestToken(agent.id, account, { runKey: run, run: "Run C" })),
    ).toEqual({ status: 400, error: "invalid_request" });
  });

  it("[token.run-key-apart] a token is never bound to the key the agent signs up and asks with", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    expect(await refusal(await requestToken(agent.id, account, { runKey: account }))).toEqual({
      status: 400,
      error: "invalid_dpop_proof",
    });
  });

  it("[dpop.unbound] a request with no proof gets a plain 300-second bearer, bound to no key", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const token = await granted(await requestToken(agent.id, account));
    expect(token.token_type).toBe("Bearer");
    expect(token.expires_in).toBe(300);
    const claims = decodeJwt(token.access_token);
    expect(claims.sub).toBe(agent.id);
    expect("cnf" in claims).toBe(false);
  });

  it("[token.assertion] a signed request is good once, for Keel alone, and for a minute at most", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account);
    const once = await assertionBy(account, agent.id);
    await granted(await requestToken(agent.id, account, { runKey: run, assertion: once }));
    expect(
      await refusal(await requestToken(agent.id, account, { runKey: run, assertion: once })),
    ).toMatchObject({ error: "invalid_client" });
    for (const audience of [BASE, "https://elsewhere.example/v1/auth", `${ISSUER}/jwks`])
      expect(
        await refusal(
          await requestToken(agent.id, account, {
            runKey: run,
            assertion: await assertionBy(account, agent.id, { audience }),
          }),
        ),
      ).toMatchObject({ error: "invalid_client" });
    expect(
      await refusal(
        await requestToken(agent.id, account, {
          runKey: run,
          assertion: await assertionBy(account, agent.id, { lifetime: 120 }),
        }),
      ),
    ).toMatchObject({ error: "invalid_client" });
    await granted(
      await requestToken(agent.id, account, {
        runKey: run,
        assertion: await assertionBy(account, agent.id, { lifetime: 60 }),
      }),
    );
  });

  it("[token.key-only] only a key of that agent gets its token: another agent's key and an unknown agent are refused", async () => {
    const account = await newKey();
    const other = await newKey();
    const agent = await seedKeyAgent(account);
    await seedKeyAgent(other);
    const run = await newKey();
    expect(
      await refusal(
        await requestToken(agent.id, account, {
          runKey: run,
          assertion: await assertionBy(other, agent.id),
        }),
      ),
    ).toEqual({ status: 401, error: "invalid_client" });
    const stranger = await newKey();
    expect(
      await refusal(
        await requestToken("agt_00000000000000000000000000", stranger, { runKey: run }),
      ),
    ).toMatchObject({ error: "invalid_client" });
  });

  it("[token.any-of-its-keys] an agent with two keys gets its token with a request signed by either, and still by no other", async () => {
    const first = await newKey();
    const second = await newKey();
    const agent = await seedKeyAgent(first, { keys: [first.key, second.key] });
    for (const key of [first, second]) {
      const token = await granted(await requestToken(agent.id, key, { runKey: await newKey() }));
      expect(decodeJwt(token.access_token).sub).toBe(agent.id);
    }
    expect(
      await refusal(await requestToken(agent.id, await newKey(), { runKey: await newKey() })),
    ).toEqual({ status: 401, error: "invalid_client" });
  });

  it("[token.any-of-its-keys] a request that does not name its key is taken while the agent has one key, and refused once it has two", async () => {
    const only = await newKey();
    const single = await seedKeyAgent(only);
    const run = await newKey();
    const unnamed = async (agentId: string, key: TestKey) =>
      requestToken(agentId, key, {
        runKey: run,
        assertion: await assertionBy(key, agentId, { named: false }),
      });
    expect((await unnamed(single.id, only)).status).toBe(200);
    const first = await newKey();
    const double = await seedKeyAgent(first, { keys: [first.key, (await newKey()).key] });
    expect(await refusal(await unnamed(double.id, first))).toEqual({
      status: 401,
      error: "invalid_client",
    });
  });

  it("[token.key-only] a suspended agent and a revoked one get no token", async () => {
    for (const state of ["suspended", "revoked"] as const) {
      const account = await newKey();
      const agent = await seedKeyAgent(account, { state });
      expect(
        await refusal(await requestToken(agent.id, account, { runKey: await newKey() })),
      ).toMatchObject({ error: "invalid_client" });
    }
  });
});

/** How many one-time ids Better Auth holds: signed token requests, and DPoP proofs. */
const heldIds = async () => {
  const [assertions, proofs] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM oauthClientAssertion`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'dpop-proof:%'`),
  ]);
  return { assertions: assertions?.results[0]?.n, proofs: proofs?.results[0]?.n };
};

describe("the one-time ids a token request leaves behind", () => {
  it("[oauth.rows] the next token request deletes the ids that have expired, and never one still in its window", async () => {
    const account = await newKey();
    const run = await newKey();
    const agent = await seedKeyAgent(account);
    const first = await assertionBy(account, agent.id);
    await granted(await requestToken(agent.id, account, { runKey: run, assertion: first }));
    await granted(await requestToken(agent.id, account, { runKey: run }));
    const before = await heldIds();
    expect(before.assertions).toBeGreaterThanOrEqual(2);
    expect(before.proofs).toBeGreaterThanOrEqual(2);
    // Everything held so far is aged past its window, with one row that is no proof beside it.
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE oauthClientAssertion SET expiresAt = ?`).bind(past),
      env.DB.prepare(
        `UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'dpop-proof:%'`,
      ).bind(past),
      env.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('kept', 'something-else', 'v', ?1, ?1, ?1)`,
      ).bind(past),
    ]);
    const live = await assertionBy(account, agent.id);
    await granted(await requestToken(agent.id, account, { runKey: run, assertion: live }));
    expect(await heldIds()).toEqual({ assertions: 1, proofs: 1 });
    const kept = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM verification WHERE id = 'kept'`,
    ).first<{ n: number }>();
    expect(kept?.n).toBe(1);
    // The live one is still held: its request is good once.
    expect(
      await refusal(await requestToken(agent.id, account, { runKey: run, assertion: live })),
    ).toMatchObject({ error: "invalid_client" });
  });
});

/** Every route the provider and the jwt plugin define that Keel does not serve. */
const CLOSED = [
  "/token",
  "/oauth2/authorize",
  "/oauth2/register",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/userinfo",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  "/admin/oauth2/resources",
] as const;

describe("the provider's routes at /v1/auth", () => {
  it("[oauth.surface] Keel serves the token endpoint and the published key, and no other route of the provider's", async () => {
    const answers: [string, string, number][] = [];
    for (const path of CLOSED)
      for (const method of ["GET", "POST"] as const) {
        const response = await worker(`${BASE}/v1/auth${path}`, {
          method,
          headers: {
            "cf-connecting-ip": freshAddress(),
            ...(method === "POST" ? { "content-type": "application/json", origin: BASE } : {}),
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        if (response.status !== 404) answers.push([method, path, response.status]);
      }
    expect(answers).toEqual([]);
    const jwks = await worker(`${BASE}/v1/auth/jwks`);
    expect(jwks.status).toBe(200);
    const unsigned = await worker(`${BASE}/v1/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": freshAddress(),
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(unsigned.status).not.toBe(404);
    expect(unsigned.status).toBeLessThan(500);
  });

  it("[oauth.surface] a person's session is never turned into a signed token", async () => {
    const user = await seedUser(uniqueHandle("session"));
    const session = await worker(`${BASE}/v1/auth/get-session`, {
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-auth-jwt")).toBeNull();
  });
});
