// awaitSubmission on the real Change DO, as the Probe Workflow calls it:
// the change at once when there is a submission to read or it has ended,
// otherwise a one-shot subscription for the instance, taken with the read.
import { runInDurableObject } from "cloudflare:test";
import { EventOutbox } from "@keeltown/core/ports";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { forgetOwed } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const WAIT = { timeout: 10_000, interval: 50 };
const probeOf = (n: number) => `workflow:Probe/probe-${n}`;

const awaiting = async (c: ChangeUnderTest, subscriber: string) =>
  ok(decodeExit(ChangeCodecs.awaitSubmission, await c.stub.awaitSubmission({ subscriber })));

/** Who the change's next event of `type` would notify now. */
const hearing = (c: ChangeUnderTest, type: string) =>
  runInDurableObject(c.stub, (instance: ChangeDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox.subscribers(type, { entity: { kind: "change", id: c.changeId }, affected: [] }),
      ),
    ),
  );

async function submitted(c: ChangeUnderTest, key: string) {
  const commitSha = await c.push();
  const lease = (await c.current()).lease.id;
  return ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha,
        idempotencyKey: key,
      }),
    ),
  );
}

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

const notifiedBy = async (c: ChangeUnderTest, type: string) =>
  (await c.log()).filter((e) => e.type === type).map((e) => e.notified);

describe("[b21.await-submission] a Probe Workflow waits for a change's submission", () => {
  it("[b21.await-submission] a working change answers waiting and subscribes the instance once: its submission notifies it, and the next does not", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    ok(await c.declare());
    expect(await awaiting(c, probeOf(1))).toEqual({ waiting: true });
    expect(await hearing(c, "ChangeSubmitted")).toContain(probeOf(1));
    expect(await hearing(c, "ChangeWithdrawn")).toContain(probeOf(1));

    await submitted(c, "submit-1");
    const [first] = await notifiedBy(c, "ChangeSubmitted");
    expect(first).toContain(probeOf(1));
    expect(await hearing(c, "ChangeSubmitted")).not.toContain(probeOf(1));
    expect(await hearing(c, "ChangeWithdrawn")).not.toContain(probeOf(1));
    await forgetOwed(c.stub, probeOf(1));

    // Submitted now: a second instance reads the change at once and subscribes nothing.
    const read = await awaiting(c, probeOf(2));
    expect(read).toMatchObject({
      change: { id: c.changeId, state: "submitted" },
      projectId: c.projectId,
    });
    expect(await hearing(c, "ChangeSubmitted")).not.toContain(probeOf(2));
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });

  it("[b21.await-submission] waiting, then withdrawn before any submission: the withdrawal notifies it; asked again, it answers at once", async () => {
    const c = await changeUnderTest();
    ok(await c.declare());
    expect(await awaiting(c, probeOf(3))).toEqual({ waiting: true });
    await withdrawn(c);
    const [ended] = await notifiedBy(c, "ChangeWithdrawn");
    expect(ended).toContain(probeOf(3));
    expect(await hearing(c, "ChangeSubmitted")).not.toContain(probeOf(3));
    await forgetOwed(c.stub, probeOf(3));

    // Terminal, never submitted: answered at once, whatever its commitSha.
    const read = await awaiting(c, probeOf(4));
    expect(read).toMatchObject({ change: { state: "withdrawn" }, projectId: c.projectId });
    expect("change" in read && read.change.commitSha).toBeFalsy();
    expect(await hearing(c, "ChangeWithdrawn")).not.toContain(probeOf(4));
  });

  it("[b21.await-submission] an unknown change is ChangeNotFound, and subscribes nothing", async () => {
    const c = await changeUnderTest();
    const answer = decodeExit(
      ChangeCodecs.awaitSubmission,
      await c.stub.awaitSubmission({ subscriber: probeOf(5) }),
    );
    expect(answer).toMatchObject({ _tag: "Failure" });
    expect(await hearing(c, "ChangeSubmitted")).not.toContain(probeOf(5));
  });
});
