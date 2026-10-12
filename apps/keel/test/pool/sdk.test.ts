import { env, exports } from "cloudflare:workers";
import { AgentId, CommitSha, Instant, makeId, WorkspaceId } from "@keeltown/core/kernel";
import { createKeelClient, KeelProblem } from "@keeltown/sdk";
import { hashSecret, makeChangesMemory, makeInboxMemory, sampleProjectId } from "@keeltown/testing";
import { Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  POOL_ORG,
  seedAgent,
  seedUser,
} from "./helpers.ts";

/**
 * The SDK against the real HTTP doorway, auth gate and handler object (over
 * in-memory Changes and Inbox): what an agent's
 * program gets back is exactly the REST body, typed from the contract.
 */
async function sdkOver() {
  const changes = makeChangesMemory();
  const inbox = makeInboxMemory();
  const { app } = makeIsolate(
    env,
    isolateLayer(env, {
      changes: changes.layer,
      inbox: inbox.layer,
      notifier: inbox.notifier,
    }),
  );
  const fetch = async (url: string, init: RequestInit) => app.fetch(new Request(url, init), env);
  const agent = await seedAgent();
  const client = createKeelClient({
    baseUrl: BASE,
    clientId: agent.clientId,
    clientSecret: agent.clientSecret,
    fetch,
  });
  return { client, changes, inbox, agent, fetch };
}

/** The deployed fetch handler: the real doorway, gate and DOs. */
const deployed = async (url: string, init: RequestInit) => exports.default.fetch(url, init);

describe("the SDK over the real doorway", () => {
  it("[a11.sdk] declares, submits, reads status and the inbox, each answer equal to the REST body", async () => {
    const { client, changes, inbox, agent, fetch } = await sdkOver();
    const declared = await client.declare(
      { goal: "Cache permission lookups per request", footprint: [], premises: [] },
      { idempotencyKey: "sdk-declare-0001" },
    );
    expect(declared.result.change.state).toBe("working");
    const sha = CommitSha.make("d".repeat(40));
    changes.push(Schema.decodeUnknownSync(WorkspaceId)(declared.result.workspace.id), sha);
    const submitted = await client.submit(
      { changeId: declared.result.change.id, commitSha: sha },
      { lease: declared.result.lease.id, idempotencyKey: "sdk-submit-0001" },
    );
    expect(submitted.result).toMatchObject({ commitSha: sha, state: "submitted" });
    const status = await client.status(declared.result.change.id);
    const token = await client.token();
    const rest = await fetch(`${BASE}/v1/changes/${declared.result.change.id}/submission`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toEqual(await rest.json());
    inbox.deliver(Schema.decodeUnknownSync(AgentId)(agent.agent.id), {
      id: crypto.randomUUID(),
      at: Instant(Date.UTC(2026, 9, 11)),
      kind: "change.moved",
      title: "Your change was submitted",
    });
    const page = await client.inbox({ wait: 1 });
    expect(page.result.notices).toHaveLength(1);
    const again = await client.inbox({ cursor: page.result.cursor });
    expect(again.result.notices).toEqual([]);
  });

  it("[a11.sdk-problem] turns a refusal into a KeelProblem with the contract's next actions", async () => {
    const { client } = await sdkOver();
    const declared = await client.declare(
      { goal: "Cache permission lookups per request", footprint: [], premises: [] },
      { idempotencyKey: "sdk-declare-0002" },
    );
    const refused = await client
      .submit(
        { changeId: declared.result.change.id, commitSha: "e".repeat(40) },
        { lease: declared.result.lease.id, idempotencyKey: "sdk-submit-0002" },
      )
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeelProblem);
    expect(refused).toMatchObject({ status: 409, code: "change.commit_not_in_workspace" });
  });

  it("[a11.sdk-session] opens a session through the deployed doorway; a retry under the key answers it, as REST does", async () => {
    // Enrolled in its own AgentSession DO, as a member's enrolment does, since only a known agent opens a session.
    const agentId = makeId("agt", ulid());
    const clientId = `client-${agentId.toLowerCase()}`;
    const clientSecret = `secret-${crypto.randomUUID()}`;
    const sponsor = (await seedUser("sdk-sponsor")).userId;
    await placeProject(sampleProjectId);
    await establishProject(sampleProjectId);
    const enrolled = decodeExit(
      AgentSessionCodecs.enrol,
      await drainAfter(
        env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)),
      ).enrol({
        projectId: sampleProjectId,
        name: "sdk-session-agent",
        kind: "interactive",
        scopes: ["agent:read", "agent:work"],
        org: POOL_ORG,
        sponsor,
        clientId,
        secretHash: await hashSecret(clientSecret),
        idempotencyKey: "enrol-1",
        fingerprint: "enrol-body",
      }),
    );
    expect(Exit.isSuccess(enrolled)).toBe(true);
    const client = createKeelClient({ baseUrl: BASE, clientId, clientSecret, fetch: deployed });

    const opened = await client.openSession(
      { harness: "a-harness", model: "a-model" },
      { idempotencyKey: "sdk-session-0001" },
    );
    const rest = await deployed(`${BASE}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await client.token()}`,
        "content-type": "application/json",
        "idempotency-key": "sdk-session-0001",
      },
      body: JSON.stringify({ harness: "a-harness", model: "a-model" }),
    });

    expect(opened).toMatchObject({ agentId, sponsor });
    expect(rest.status).toBe(201);
    expect(await rest.json()).toEqual(opened);
    expect((await client.whoami()).result.session).toEqual({ id: opened.id });
  });

  it("[a11.sdk-nobody] adopts with the SDK's empty body, which the doorway reads as no body", async () => {
    const { client } = await sdkOver();
    const declared = await client.declare(
      { goal: "Cache permission lookups per request", footprint: [], premises: [] },
      { idempotencyKey: "sdk-declare-0003" },
    );
    const refused = await client
      .adopt(declared.result.change.id, { idempotencyKey: "sdk-adopt-0001" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 409, code: "change.lease_not_lapsed" });
  });
});
