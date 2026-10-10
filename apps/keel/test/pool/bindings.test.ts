import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/index.ts";
import { describe, expect, it } from "vitest";

/** Spike S8: each binding type the Keel Worker uses, exercised inside workerd. */
describe("bindings inside workerd", () => {
  it("D1: the migrated schema is there", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agents', 'credentials') ORDER BY name").all();
    expect(tables.results.map((row) => row["name"])).toEqual(["agents", "credentials"]);
  });

  it("Queue: the consumer acknowledges an Artifacts fork event and an unknown event alike", async () => {
    const batch = createMessageBatch("keel-staging-artifacts-events", [
      {
        id: "m1",
        timestamp: new Date(),
        attempts: 1,
        body: {
          type: "cf.artifacts.repo.forked",
          source: { type: "artifacts", namespace: "keel-core", repoName: "mirror" },
          payload: { namespace: "keel-ws-00", repoName: "ws-01JZ8PX3K2M5N7Q9R1S3T5V7W9", repoId: "r1" },
        },
      },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { type: "cf.something.else" } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.toSorted()).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("Workflow: Precheck fails permanently, not by retrying, until it is implemented", async () => {
    await using instance = await introspectWorkflowInstance(env.PRECHECK, "precheck-chg-1");
    await env.PRECHECK.create({ id: "precheck-chg-1", params: { changeId: "chg_1", revision: 1 } });
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  });

  it("Service binding: VERIFY reaches the keel-verify fake", async () => {
    const response = await env.VERIFY.fetch("https://keel-verify.internal/");
    expect(await response.json()).toEqual({ fake: "keel-verify" });
  });
});
