import type { Agent, Identity } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { sampleProjectId, sampleSponsorId } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { whoamiOk } from "../../src/adapters/driving/http/mappers.ts";

const agent: Agent = {
  id: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  projectId: sampleProjectId,
  name: "unit-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  sponsor: sampleSponsorId,
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(1_760_000_000_000),
};

/** An agent that signed up by key: a handle, no project of its own, and nobody behind it yet. */
const keyAgent: Agent = {
  id: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1"),
  handle: "agent-01jz8pt2c4e6g8j0m2",
  name: "key-agent",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(1_760_000_000_000),
};

const none = { namespaces: 0, projects: 0 };

const answer = (identity: Identity) => {
  const answered = whoamiOk(identity);
  if (answered.status !== 200) throw new Error(`whoami answered ${answered.status}`);
  return answered.body;
};

const answered = (namespaces: number, projects: number) => {
  const body = answer({
    agent,
    session: null,
    invitations: { namespaces, projects },
    joined: none,
  });
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

  it("[whoami.reach-next] points an agent that has joined an org or a project at the projects it can reach, last, and an agent that has joined nothing at none", () => {
    const reads = (joined: { namespaces: number; projects: number }, invitations = none) =>
      answer({ agent, session: null, invitations, joined }).next.map(
        (action) => action.operationId,
      );
    expect(reads(none)).toEqual([]);
    expect(reads({ namespaces: 1, projects: 0 })).toEqual(["Agents_listReachableProjects"]);
    expect(reads({ namespaces: 0, projects: 1 })).toEqual(["Agents_listReachableProjects"]);
    expect(reads({ namespaces: 1, projects: 0 }, { namespaces: 0, projects: 1 })).toEqual([
      "Agents_listProjects",
      "Agents_listReachableProjects",
    ]);
  });

  it("[whoami.sponsor-next] tells an agent nobody stands behind to ask a person, askSponsor first, and says nothing of it once someone does", () => {
    const { sponsor: _, ...unsponsored } = agent;
    const alone = answer({ agent: unsponsored, session: null, invitations: none, joined: none });
    expect(alone.summary).toBe(
      `You are unit-agent (${agent.id}), holding agent:read, agent:work. Nobody stands behind you yet: ask a person to sponsor you.`,
    );
    expect(alone.next).toEqual([
      {
        kind: "call",
        title: "Ask a person to sponsor you: askSponsor answers a link, and you show it to them",
        operationId: "askSponsor",
      },
    ]);
    const invited = answer({
      agent: unsponsored,
      session: null,
      invitations: { namespaces: 1, projects: 0 },
      joined: none,
    });
    expect(invited.next.map((action) => action.operationId)).toEqual([
      "askSponsor",
      "Agents_listNamespaces",
    ]);
    const backed = answer({ agent, session: null, invitations: none, joined: none });
    expect(backed.summary).not.toMatch(/sponsor/);
    expect(backed.next).toEqual([]);
  });

  it("[whoami.placement-next] tells an agent that signed up by key and stands nowhere but its own namespace to ask an org's member to invite it by its handle, then to wait in its inbox", () => {
    const sponsored = { ...keyAgent, sponsor: sampleSponsorId };
    const nowhere = answer({ agent: sponsored, session: null, invitations: none, joined: none });
    expect(nowhere.summary).toBe(
      `You are key-agent (${keyAgent.id}), holding agent:read, agent:work. You work only in your own namespace, ${keyAgent.handle}: a member of an org invites you into theirs.`,
    );
    expect(nowhere.next).toEqual([
      {
        kind: "escalate",
        title: `To work on an org's projects, ask one of its members to invite you by your handle ${keyAgent.handle}, with read and work`,
      },
      {
        kind: "call",
        title: "Wait in your inbox: Keel tells you the moment an invitation comes",
        operationId: "inbox",
        args: { cursor: "end", wait: 600 },
      },
    ]);
    const fresh = answer({ agent: keyAgent, session: null, invitations: none, joined: none });
    expect(fresh.next.map((action) => action.kind)).toEqual(["call", "escalate", "call"]);
    expect(fresh.next.map((action) => action.operationId)).toEqual([
      "askSponsor",
      undefined,
      "inbox",
    ]);
    for (const [invitations, joined] of [
      [{ namespaces: 1, projects: 0 }, none],
      [{ namespaces: 0, projects: 1 }, none],
      [none, { namespaces: 1, projects: 0 }],
      [none, { namespaces: 0, projects: 1 }],
    ] as const) {
      const placed = answer({ agent: sponsored, session: null, invitations, joined });
      expect(placed.summary).not.toMatch(/own namespace/);
      expect(placed.next.filter((action) => action.kind === "escalate")).toEqual([]);
      expect(placed.next.map((action) => action.operationId)).not.toContain("inbox");
    }
    const enrolled = answer({ agent, session: null, invitations: none, joined: none });
    expect(enrolled.next).toEqual([]);
  });
});
