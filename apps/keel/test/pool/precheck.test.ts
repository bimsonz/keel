import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { PrecheckParams } from "../../src/adapters/driving/workflow/precheck.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const WAIT = { timeout: 15_000, interval: 50 };
const GUARDS = [".keel/guards/**"];
const BASE = "b".repeat(40);

/** What the ancestry step answers: the submitted commit descends from `base`. */
const descends = (base: string) => ({ _tag: "Done", value: { _tag: "Descends", base } });

/** What the diff step answers: these paths touched. */
const touched = (paths: readonly string[]) => ({
  _tag: "Done",
  value: { _tag: "Touched", paths },
});
/** What the policy step answers: these protected globs, and core's guard paths. */
const policy = (protectedPaths: readonly string[]) => ({
  _tag: "Done",
  value: { protectedPaths, guardPaths: GUARDS },
});

/** A change declared, pushed and submitted on a Change DO under test; the outbox starts its Precheck. */
async function submitted() {
  const c = await changeUnderTest();
  const lease = ok(await c.declare()).change.lease.id;
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({ agentId: c.agentId, leaseId: lease, commitSha, idempotencyKey: "s-1" }),
    ),
  );
  return { c, commitSha };
}

/**
 * Precheck through env.PRECHECK, started by the Change DO's outbox on
 * ChangeSubmitted, against the real Change DO over RPC. The ancestry walk and
 * the diff read the workspace on the code host, which the DO under test keeps
 * in memory, and the Project DO does not answer settings() yet, so those
 * steps are mocked; start, decide and the refusal or plan run for real.
 */
describe("Precheck", () => {
  it("[d12.pool.compiled] records the plan of a clean submission on the change", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy(["infra/**"]));
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("queued");
    const types = (await c.log()).map((e) => e.type);
    expect(types.slice(-3)).toEqual(["PrecheckStarted", "PlanCompiled", "ChangeQueued"]);
  });

  it("[d12.pool.refused] bounces a change to a guard path, with next actions and a ruling verdict", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched([".keel/guards/g1.test.ts", "src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    const bounced = (await c.log()).at(-1);
    expect(bounced?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });

  it("[d12.pool.stale] completes, moving nothing, when the change has moved on", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
    });
    const { c, commitSha } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");
    const before = await c.log();

    // A second instance for the same revision: the change is already queued.
    const id = `precheck-late-${ulid()}`;
    await using late = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: { changeId: c.changeId, revision: 1, commitSha, eventId: "evt-late" },
    });
    await late.waitForStatus("complete");

    expect(await c.log()).toEqual(before);
    expect((await c.current()).state).toBe("queued");
  });

  it("[c14.pool.diverged] bounces a commit off its base, naming rebase, without reading its paths", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult(
        { name: "ancestry" },
        { _tag: "Done", value: { _tag: "Diverged", base: BASE, commit: "c".repeat(40) } },
      );
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    expect((await c.log()).at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [`precheck:not-on-base:${"c".repeat(40)} does not descend from ${BASE}`],
      nextActions: [{ kind: "call", operationId: "rebase", args: { base: BASE } }],
    });
  });

  it("[c14.pool.base-carried] the outbox starts Precheck with the base ChangeSubmitted carries, the grant's", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "start" }, { _tag: "Stale", reason: "driven by hand" });
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    const event = (await c.log()).find((e) => e.type === "ChangeSubmitted");
    if (event === undefined) throw new Error("no ChangeSubmitted on the change's log");
    // The params the outbox builds: the event's payload, plus its id.
    const payload =
      typeof event.payload === "object" && event.payload !== null ? event.payload : {};
    const params = Schema.decodeUnknownSync(PrecheckParams)({ ...payload, eventId: event.eventId });
    const { baseSha } = await c.current();
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(params.baseSha).toBe(baseSha);
  });

  it("[c14.pool.no-base] refuses a submission event that carries no base, as precheck:no-base", async () => {
    const inert = await inertPrecheck();
    const { c, commitSha } = await submitted();
    await vi.waitFor(async () => expect(await inert.get()).toHaveLength(1), WAIT);
    await (await inert.get())[0]?.waitForStatus("complete");
    await inert.dispose();

    // An instance started as one from before ChangeSubmitted carried its base.
    const id = `precheck-old-${ulid()}`;
    await using old = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: { changeId: c.changeId, revision: 1, commitSha, eventId: "evt-old" },
    });
    await old.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    expect((await c.log()).at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [
        `precheck:no-base:${commitSha} was submitted without the base it is judged against`,
      ],
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });

  it("[d12.pool.not-found] fails permanently for a change that was never declared", async () => {
    const id = `precheck-missing-${ulid()}`;
    await using instance = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: {
        changeId: makeId("chg", ulid()),
        revision: 1,
        commitSha: "a".repeat(40),
        eventId: "evt-missing",
      },
    });
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  });
});
