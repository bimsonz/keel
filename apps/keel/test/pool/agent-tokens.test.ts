import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { assertionBy, granted, ISSUER, newKey, requestToken, seedKeyAgent } from "./agent-keys.ts";
import { BASE } from "./helpers.ts";

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

  it("[token.resource] a token is for Keel's own API whether or not the request names it, and for nothing else", async () => {
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
    expect(
      await refusal(
        await requestToken(agent.id, account, {
          runKey: run,
          resource: "https://elsewhere.example",
        }),
      ),
    ).toEqual({ status: 400, error: "invalid_target" });
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
