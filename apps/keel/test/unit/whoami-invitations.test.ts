import type { Agent, Identity } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { sampleProjectId } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { whoamiOk } from "../../src/adapters/driving/http/mappers.ts";

const agent: Agent = {
  id: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  projectId: sampleProjectId,
  name: "unit-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(1_760_000_000_000),
};

const answered = (namespaces: number, projects: number) => {
  const identity: Identity = { agent, session: null, invitations: { namespaces, projects } };
  const answer = whoamiOk(identity);
  if (answer.status !== 200) throw new Error(`whoami answered ${answer.status}`);
  const { body } = answer;
  return {
    summary: body.summary,
    invitations: body.result.invitations,
    reads: body.next.map((action) => action.operationId),
  };
};

describe("whoami's answer", () => {
  it("[whoami.invited-next] says how many invitations wait and names the read for each kind that has one, and says nothing of none", () => {
    expect(answered(0, 0)).toEqual({
      summary: `You are unit-agent (${agent.id}), holding agent:read, agent:work.`,
      invitations: { namespaces: 0, projects: 0 },
      reads: [],
    });
    expect(answered(1, 0)).toMatchObject({
      summary: expect.stringMatching(/ One invitation waits: an org's\.$/),
      reads: ["Agents_listNamespaces"],
    });
    expect(answered(0, 1)).toMatchObject({
      summary: expect.stringMatching(/ One invitation waits: a project's\.$/),
      reads: ["Agents_listProjects"],
    });
    expect(answered(2, 1)).toMatchObject({
      summary: expect.stringMatching(/ 3 invitations wait: 2 orgs' and a project's\.$/),
      invitations: { namespaces: 2, projects: 1 },
      reads: ["Agents_listNamespaces", "Agents_listProjects"],
    });
  });
});
