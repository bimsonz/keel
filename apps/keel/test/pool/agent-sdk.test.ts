import { env, exports } from "cloudflare:workers";
import { agentIdOf, givenHandle, KeyThumbprint } from "@keeltown/core/domain/identity";
import { createKeelClient, generateAgentKey, signUp, thumbprint } from "@keeltown/sdk";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAgentToken } from "../../src/adapters/driven/better-auth/access-tokens.ts";
import { makeAuth } from "../../src/adapters/driven/better-auth/auth.ts";
import { freshAddress } from "./agent-keys.ts";
import { BASE, drainOutbox } from "./helpers.ts";

const WHOAMI = `${BASE}/v1/agents/me`;

interface Sent {
  readonly url: string;
  readonly headers: Headers;
}

/**
 * Keel's real Worker as a client's `fetch`. Each call to the API is kept as it
 * was sent, so the request the client built can be read back.
 */
function keel() {
  const calls: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (url.startsWith(`${BASE}/v1/agents/`)) calls.push({ url, headers: new Headers(headers) });
    // Each request from an address of its own, so the per-address limits decide nothing here.
    headers.set("cf-connecting-ip", freshAddress());
    return exports.default.fetch(url, { ...init, headers });
  };
  return { fetch, calls };
}

/** The check the gate makes of an agent's token, as `agent-access-tokens.test.ts` makes it. */
const admitted = (presented: Parameters<typeof verifyAgentToken>[3]) =>
  verifyAgentToken(
    makeAuth({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      host: env.KEEL_HOST,
      agents: { find: async () => undefined, runProject: async () => undefined },
      endSponsorships: async () => {},
    }),
    BASE,
    BASE,
    presented,
  );

/** The agent's own object flushes what sign-up committed before the file ends. */
const settled = (agentId: string) =>
  drainOutbox(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

describe("the SDK against Keel's real Worker, holding only a key", () => {
  it("[sdk.key-live] the SDK signs an agent up, gets a token for one project and one run, and its next call is answered as that agent: the gate takes the proof the SDK made, once", async () => {
    const worker = keel();
    const { signer } = await generateAgentKey();
    const agentId = agentIdOf(
      Schema.decodeUnknownSync(KeyThumbprint)(await thumbprint(signer.publicJwk)),
    );
    const asked = { baseUrl: BASE, signer, name: "builder", fetch: worker.fetch };
    expect(await signUp(asked)).toEqual({
      agentId,
      handle: givenHandle(agentId),
      created: true,
    });
    await settled(agentId);
    expect((await signUp(asked)).created).toBe(false);

    const client = createKeelClient({
      baseUrl: BASE,
      agentId,
      key: signer,
      project: sampleProjectId,
      run: "run-c",
      fetch: worker.fetch,
    });
    // The Worker's own gate admits the call: the token for one project and one run, bound to the run's key.
    expect((await client.whoami()).result.agent).toMatchObject({
      id: agentId,
      handle: givenHandle(agentId),
      name: "builder",
    });
    const [call] = worker.calls;
    const [scheme, token = ""] = (call?.headers.get("authorization") ?? "").split(" ");
    expect(scheme).toBe("DPoP");
    expect(decodeJwt(token)).toMatchObject({
      sub: agentId,
      prj: sampleProjectId,
      run_label: "run-c",
      cnf: { jkt: expect.any(String) },
    });
    // The gate spent the proof: the same request again is a replay.
    expect(
      await admitted({
        token,
        scheme: "DPoP",
        proof: call?.headers.get("dpop") ?? undefined,
        method: "GET",
        url: WHOAMI,
      }),
    ).toMatchObject({ refused: "invalid_dpop_proof" });
    await settled(agentId);
  });
});
