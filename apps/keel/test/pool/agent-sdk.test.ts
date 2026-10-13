import { env, exports } from "cloudflare:workers";
import { agentIdOf, givenHandle, KeyThumbprint } from "@keeltown/core/domain/identity";
import { createKeelClient, generateAgentKey, signUp, thumbprint } from "@keeltown/sdk";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
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
 * Keel's real Worker as a client's `fetch`. A call to the API is kept and
 * answered here, so the request the client built can be put to the token check
 * exactly as it was sent, its proof unspent.
 */
function keel() {
  const calls: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (url.startsWith(`${BASE}/v1/agents/`)) {
      calls.push({ url, headers });
      return Response.json({ ok: true, summary: "kept for the token check", result: {} });
    }
    // Each request from an address of its own, so the per-address limits decide nothing here.
    headers.set("cf-connecting-ip", freshAddress());
    return exports.default.fetch(url, { ...init, headers });
  };
  return { fetch, calls };
}

/** The check the gate makes of an agent's token, as `agent-access-tokens.test.ts` makes it. */
const admitted = (presented: Parameters<typeof verifyAgentToken>[2]) =>
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

/** The agent's own object flushes what sign-up committed before the file ends. */
const settled = (agentId: string) =>
  drainOutbox(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

describe("the SDK against Keel's real Worker, holding only a key", () => {
  it("[sdk.key-live] the SDK signs an agent up and gets a token for one project and one run, and the call it then builds passes the token check with its own proof", async () => {
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
    await client.whoami();
    const [call] = worker.calls;
    const [scheme, token = ""] = (call?.headers.get("authorization") ?? "").split(" ");
    expect(scheme).toBe("DPoP");
    const presented = {
      token,
      scheme: "DPoP" as const,
      proof: call?.headers.get("dpop") ?? undefined,
      method: "GET",
      url: WHOAMI,
    };
    expect(await admitted(presented)).toMatchObject({
      agentId,
      projectId: sampleProjectId,
      handle: givenHandle(agentId),
      run: { label: "run-c" },
      bound: true,
    });
    // The proof was good once: the same request again is a replay.
    expect(await admitted(presented)).toMatchObject({ refused: "invalid_dpop_proof" });
    await settled(agentId);
  });
});
