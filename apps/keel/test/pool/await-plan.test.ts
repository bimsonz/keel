// awaitPlan on the real Change DO, as KeelWorldCheck calls it: the
// change at once unless its Precheck is still to answer, otherwise a one-shot
// subscription for the instance, taken with the read, to whatever ends it.
import { runInDurableObject } from "cloudflare:test";
import { EventOutbox } from "@keeltown/core/ports";
import { CodeHostFixture } from "@keeltown/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { forgetOwed } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const WAIT = { timeout: 10_000, interval: 50 };
const PLAN_HASH = `sha256:${"0".repeat(64)}`;
const worldCheckOf = (n: number) => `workflow:KeelWorldCheck/wc-${n}`;

const awaiting = async (c: ChangeUnderTest, subscriber: string) =>
  ok(decodeExit(ChangeCodecs.awaitPlan, await c.stub.awaitPlan({ subscriber })));

/** Who the change's next event of `type` would notify now. */
const hearing = (c: ChangeUnderTest, type: string) =>
  runInDurableObject(c.stub, (instance: ChangeDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox.subscribers(type, { entity: { kind: "change", id: c.changeId }, affected: [] }),
      ),
    ),
  );

async function submitted(c: ChangeUnderTest, key: string, commitSha?: string) {
  const sha = commitSha ?? (await c.push());
  const lease = (await c.current()).lease.id;
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha: sha,
        idempotencyKey: key,
      }),
    ),
  );
  return sha;
}

/** The agent's next commit on the workspace it already pushed to: new code under the same intent. */
const pushAgain = async (c: ChangeUnderTest) => {
  const held = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
  return Effect.runPromise(
    Effect.flatMap(CodeHostFixture, (fixture) =>
      fixture.commit(held.repo, "refs/heads/main", { "a.txt": "a, fixed" }),
    ).pipe(Effect.provide(c.code.layer)),
  );
};

const started = async (c: ChangeUnderTest, instanceId: string) =>
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({ revision: 1, instanceId }),
    ),
  );

const compiled = async (c: ChangeUnderTest, instanceId: string, planHash: string) =>
  ok(
    decodeExit(
      ChangeCodecs.planCompiled,
      await c.stub.planCompiled({ revision: 1, instanceId, planHash, steps: 1, costEstimate: 1 }),
    ),
  );

const refused = async (c: ChangeUnderTest, instanceId: string) =>
  ok(
    decodeExit(
      ChangeCodecs.precheckRefused,
      await c.stub.precheckRefused({
        revision: 1,
        instanceId,
        reasons: ["precheck:protected:src/secret.ts"],
        nextActions: [{ kind: "call", title: "Submit it again", operationId: "submit" }],
      }),
    ),
  );

const withdrawn = async (c: ChangeUnderTest) =>
  ok(
    decodeExit(
      ChangeCodecs.abandon,
      await c.stub.abandon({
        authority: { _tag: "Lease", leaseId: (await c.current()).lease.id, agentId: c.agentId },
        idempotencyKey: "abandon-1",
      }),
    ),
  );

/** Who each of the change's events of `type` notified, in log order. */
const notifiedBy = async (c: ChangeUnderTest, type: string) =>
  (await c.log()).filter((e) => e.type === type).map((e) => e.notified);

describe("[b21.await-plan] KeelWorldCheck waits for a change's plan", () => {
  it("[b21.await-plan] asked a moment after the submission, it waits; Precheck starting does not spend the wait, the plan notifies it once, and asked again it reads the plan", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    ok(await c.declare());

    // Not submitted: no plan is coming, so there is nothing to wait for.
    const working = await awaiting(c, worldCheckOf(1));
    expect(working).toMatchObject({ change: { state: "working" }, projectId: c.projectId });
    expect(await hearing(c, "PlanCompiled")).not.toContain(worldCheckOf(1));

    await submitted(c, "submit-1");
    expect(await awaiting(c, worldCheckOf(2))).toEqual({ waiting: true });
    expect(await hearing(c, "PlanCompiled")).toContain(worldCheckOf(2));

    await started(c, "p-1");
    const [starting] = await notifiedBy(c, "PrecheckStarted");
    expect(starting).not.toContain(worldCheckOf(2));
    // Deriving is still pending: a second instance waits too.
    expect(await awaiting(c, worldCheckOf(3))).toEqual({ waiting: true });

    await compiled(c, "p-1", PLAN_HASH);
    const [plan] = await notifiedBy(c, "PlanCompiled");
    expect(plan).toEqual(expect.arrayContaining([worldCheckOf(2), worldCheckOf(3)]));
    // One event each: the queueing that follows the plan, and any later bounce, tell neither.
    const [queued] = await notifiedBy(c, "ChangeQueued");
    expect(queued).not.toContain(worldCheckOf(2));
    expect(await hearing(c, "ChangeBounced")).not.toContain(worldCheckOf(2));
    expect(await hearing(c, "ChangeWithdrawn")).not.toContain(worldCheckOf(3));
    await forgetOwed(c.stub, worldCheckOf(2));
    await forgetOwed(c.stub, worldCheckOf(3));

    const read = await awaiting(c, worldCheckOf(4));
    expect(read).toMatchObject({ change: { id: c.changeId, planHash: PLAN_HASH } });
    expect(await hearing(c, "PlanCompiled")).not.toContain(worldCheckOf(4));
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });

  it("[b21.await-plan] a refused Precheck tells the waiter with its bounce; resubmitted, the change is waited on again until the next pass compiles", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    ok(await c.declare());
    await submitted(c, "submit-1");
    await started(c, "p-1");
    expect(await awaiting(c, worldCheckOf(5))).toEqual({ waiting: true });
    await refused(c, "p-1");
    const [bounce] = await notifiedBy(c, "ChangeBounced");
    expect(bounce).toContain(worldCheckOf(5));
    expect(await hearing(c, "PlanCompiled")).not.toContain(worldCheckOf(5));
    await forgetOwed(c.stub, worldCheckOf(5));

    // Bounced with no plan: answered at once, and the caller reads that none is coming.
    const none = await awaiting(c, worldCheckOf(6));
    expect(none).toMatchObject({ change: { state: "bounced" } });
    expect("change" in none && none.change.planHash).toBeFalsy();
    expect(await hearing(c, "PlanCompiled")).not.toContain(worldCheckOf(6));

    // The agent's fix under the same intent: a new pass, so the plan is pending again.
    await submitted(c, "submit-2", await pushAgain(c));
    expect(await awaiting(c, worldCheckOf(6))).toEqual({ waiting: true });
    await started(c, "p-2");
    await compiled(c, "p-2", PLAN_HASH);
    const [plan] = await notifiedBy(c, "PlanCompiled");
    expect(plan).toContain(worldCheckOf(6));
    await forgetOwed(c.stub, worldCheckOf(6));
    expect(await awaiting(c, worldCheckOf(6))).toMatchObject({ change: { planHash: PLAN_HASH } });
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(2), WAIT);
  });

  it("[b21.await-plan] waiting, then withdrawn before its Precheck answers: the withdrawal notifies it; an unknown change is ChangeNotFound", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    ok(await c.declare());
    await submitted(c, "submit-1");
    expect(await awaiting(c, worldCheckOf(7))).toEqual({ waiting: true });
    await withdrawn(c);
    const [ended] = await notifiedBy(c, "ChangeWithdrawn");
    expect(ended).toContain(worldCheckOf(7));
    expect(await hearing(c, "PlanCompiled")).not.toContain(worldCheckOf(7));
    await forgetOwed(c.stub, worldCheckOf(7));
    expect(await awaiting(c, worldCheckOf(8))).toMatchObject({ change: { state: "withdrawn" } });

    const unknown = await changeUnderTest();
    const answer = decodeExit(
      ChangeCodecs.awaitPlan,
      await unknown.stub.awaitPlan({ subscriber: worldCheckOf(9) }),
    );
    expect(answer).toMatchObject({ _tag: "Failure" });
    expect(await hearing(unknown, "PlanCompiled")).not.toContain(worldCheckOf(9));
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});
