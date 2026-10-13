import type { Agent } from "@keeltown/core/domain/identity";
import { freshAgentKey, sampleAgent, signedUpAgent } from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import { AGENT_DISCOVERY, agentDiscovery } from "../../src/adapters/driven/better-auth/agents.ts";

/** The provider's question, asked of a directory that holds `agents`: who is this client? */
async function client(agents: readonly Agent[], clientId: string): Promise<unknown> {
  const discovery = agentDiscovery({
    find: async (agentId) => agents.find((agent) => agent.id === agentId),
  });
  // The discovery reads nothing of the request, so none is made up for it.
  const answer: unknown = await Reflect.apply(discovery.resolve, discovery, [
    undefined,
    clientId,
    null,
  ]);
  return answer;
}

const keysOf = (answer: unknown): unknown =>
  JSON.parse(String(Reflect.get(Object(answer), "jwks")));

describe("an agent as the token endpoint's provider reads a client", () => {
  it("[discovery.client] an agent that signed up by key is a client that asks with a signed request, and its keys are its own alone, each named by its thumbprint", async () => {
    const agent = signedUpAgent([freshAgentKey(), freshAgentKey()]);
    const other = signedUpAgent();
    const answer = await client([other, agent], agent.id);
    expect(answer).toMatchObject({
      clientId: agent.id,
      clientDiscoveryId: AGENT_DISCOVERY,
      disabled: false,
      tokenEndpointAuthMethod: "private_key_jwt",
      grantTypes: ["client_credentials"],
      redirectUris: [],
    });
    // Each key is named by its thumbprint, which is how a request signed by one of several says which.
    expect(keysOf(answer)).toEqual({
      keys: agent.keys?.map((key) => ({ ...key.jwk, kid: key.jkt })),
    });
  });

  it("[discovery.client] a suspended agent and a revoked one are disabled clients", async () => {
    for (const state of ["suspended", "revoked"] as const) {
      const agent: Agent = { ...signedUpAgent(), state };
      expect([state, await client([agent], agent.id)]).toEqual([
        state,
        expect.objectContaining({ disabled: true }),
      ]);
    }
  });

  it("[discovery.client] a token's scopes are held to the ones the agent's record has that an agent may be granted", async () => {
    const reader: Agent = { ...signedUpAgent(), scopes: ["agent:read"] };
    expect(await client([reader], reader.id)).toMatchObject({
      clientCredentialsScopes: ["agent:read"],
    });
    const overreaching: Agent = { ...signedUpAgent(), scopes: ["operator", "agent:work"] };
    expect(await client([overreaching], overreaching.id)).toMatchObject({
      clientCredentialsScopes: ["agent:work"],
    });
  });

  it("[discovery.client] an agent a person enrolled holds no key and is no client, and neither is an id no agent has", async () => {
    const enrolled: Agent = { ...sampleAgent, id: signedUpAgent().id };
    expect(await client([enrolled], enrolled.id)).toBeNull();
    expect(await client([], signedUpAgent().id)).toBeNull();
    const discovery = agentDiscovery({ find: async () => enrolled });
    expect(discovery.matches("keel-device")).toBe(false);
    expect(await client([enrolled], "keel-device")).toBeNull();
  });
});
