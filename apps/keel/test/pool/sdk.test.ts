import { env } from "cloudflare:workers";
import { AgentId, CommitSha, Instant, WorkspaceId } from "@keeltown/core/kernel";
import { createKeelClient, KeelProblem } from "@keeltown/sdk";
import { makeChangesMemory, makeInboxMemory } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { BASE, seedAgent } from "./helpers.ts";

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
    isolateLayer(env, { changes: changes.layer, inbox: inbox.layer }),
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
});
