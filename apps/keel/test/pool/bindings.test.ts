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

  it("Queue: the jobs consumer acknowledges each message on its own", async () => {
    const batch = createMessageBatch("keel-staging-jobs", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { kind: "mirror-sync", dedupeKey: "a" } },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { kind: "unknown", dedupeKey: "b" } },
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

  it("Service binding: VERIFIER reaches the keel-verify fake", async () => {
    const response = await env.VERIFIER.fetch("https://keel-verify.internal/");
    expect(await response.json()).toEqual({ fake: "keel-verify" });
  });
});
