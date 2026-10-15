import { type Agent, runIdOf } from "@keeltown/core/domain/identity";
import { makeId, type ProjectId, RunLabel, type RunId } from "@keeltown/core/kernel";
import { freshAgentKey, sampleAgent, signedUpAgent, ulidOf } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AGENT_DISCOVERY,
  agentClaims,
  agentDiscovery,
} from "../../src/adapters/driven/better-auth/agents.ts";

/** The provider's question, asked of a directory that holds `agents`: who is this client? */
async function client(agents: readonly Agent[], clientId: string): Promise<unknown> {
  const discovery = agentDiscovery({
    find: async (agentId) => agents.find((agent) => agent.id === agentId),
    runProject: async () => undefined,
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

  it("[discovery.client] only a revoked agent is a disabled client: a paused one is given tokens, which read only who it is and its inbox", async () => {
    for (const [state, disabled] of [
      ["active", false],
      ["suspended", false],
      ["revoked", true],
    ] as const) {
      const agent: Agent = { ...signedUpAgent(), state };
      expect([state, await client([agent], agent.id)]).toEqual([
        state,
        expect.objectContaining({ disabled }),
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
    const discovery = agentDiscovery({
      find: async () => enrolled,
      runProject: async () => undefined,
    });
    expect(discovery.matches("keel-device")).toBe(false);
    expect(await client([enrolled], "keel-device")).toBeNull();
  });
});

/**
 * What the token endpoint adds to a token of `agent`'s for a request with this
 * form, where the agent's runs chose as `chosen` says: the provider's input is
 * made up of only what the claims read.
 */
async function claimsOf(
  agent: Agent,
  form: Readonly<Record<string, string>>,
  chosen: ReadonlyMap<RunId, ProjectId> = new Map(),
): Promise<unknown> {
  const asked: RunId[] = [];
  const access = {
    find: async () => agent,
    runProject: async (_agentId: string, runId: RunId) => {
      asked.push(runId);
      return chosen.get(runId);
    },
  };
  const input = {
    client: { clientId: agent.id, clientDiscoveryId: AGENT_DISCOVERY },
    ctx: { body: form, headers: new Headers() },
  };
  const claims: unknown = await Reflect.apply(agentClaims, undefined, [access, input]);
  return { claims, asked };
}

describe("what the token endpoint adds to an agent's token", () => {
  it("[token.run-project] a request that names a run and no project is for the project that run chose; a named project wins, another run chose nothing, and a request with no run asks nothing", async () => {
    const agent = signedUpAgent();
    const label = Schema.decodeSync(RunLabel)("my-run");
    const run = runIdOf(agent.id, { label });
    const [chosen, named] = [makeId("prj", ulidOf(61)), makeId("prj", ulidOf(62))];
    const choices = new Map([[run, chosen]]);
    expect(await claimsOf(agent, { run: "my-run" }, choices)).toMatchObject({
      claims: { prj: chosen, run, run_label: "my-run" },
      asked: [run],
    });
    expect(await claimsOf(agent, { run: "my-run", project: named }, choices)).toEqual({
      claims: expect.objectContaining({ prj: named }),
      asked: [],
    });
    const other = await claimsOf(agent, { run: "other" }, choices);
    expect(Reflect.get(Object(Reflect.get(Object(other), "claims")), "prj")).toBeUndefined();
    expect(await claimsOf(agent, {}, choices)).toEqual({
      claims: expect.not.objectContaining({ prj: expect.anything() }),
      asked: [],
    });
  });
});
