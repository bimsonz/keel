// A change that passes with fewer tests than trunk's last verdict, on the real
// path: the real Lane DO holds its batch to the count the batch trunk took
// before it had, and puts the drop to the project's maintainers through the
// HumanGate adapter on the real namespace object; the real Change DO parks on
// that question; a maintainer's approve over the deployed fetch handler resumes
// it, the lane takes the drop as accepted, and the change lands through the real
// Trunk DO with that many fewer. A refuse sends another back.
import { env } from "cloudflare:workers";
import {
  decisionIdOf,
  namespaceAddress,
  SHRINK_RULING_APPROVE,
  shrinkRulingIdOf,
} from "@keeltown/core/application/coordination";
import type { StepCount } from "@keeltown/core/domain/verification";
import { type EscalationId, makeId, type VerdictId } from "@keeltown/core/kernel";
import { Escalations, PROJECTOR } from "@keeltown/core/ports";
import { Effect } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { EscalationsRpc } from "../../src/adapters/driven/do-rpc/escalations.ts";
import { HumanGateRpc } from "../../src/adapters/driven/do-rpc/human-gate.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  establishProject,
  POOL_ORG,
  seedUser,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { placedIn } from "./pool-harness.ts";
import { PLAN_HASH, realLane, realTrunk } from "./real-lane.ts";

const WAIT = { timeout: 20_000, interval: 50 };
const TEST = "keel.test";
const passed = (n: number): readonly StepCount[] => [{ stepId: TEST, total: n, passed: n }];

const namespaceObject = () =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(POOL_ORG))));

/** Queues the change: declared, submitted, Precheck started and its plan compiled, all by hand. */
async function queue(c: ChangeUnderTest) {
  const lease = ok(await c.declare()).change.lease.id;
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha: await c.push(),
        idempotencyKey: "submit-1",
      }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.planCompiled,
      await c.stub.planCompiled({
        revision: 1,
        instanceId: "p-1",
        planHash: PLAN_HASH,
        steps: 1,
        costEstimate: 1,
      }),
    ),
  );
}

/** The question as the Projector holds it, once the namespace object's outbox has drained to it. */
const asked = (escalationId: EscalationId) =>
  Effect.runPromise(
    Escalations.use((port) => port.get(escalationId)).pipe(
      Effect.provide(
        EscalationsRpc(
          () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR)),
          (address) => drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
        ),
      ),
      Effect.orDie,
    ),
  );

/** A ruling through the doorway. */
const rule = (token: string, escalationId: string, key: string, option: string) =>
  worker(`${BASE}/v1/escalations/${escalationId}/ruling`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ option, rationale: "the dropped tests were read" }),
  });

describe("a change that drops tests, on the real Lane, Change, namespace and Trunk objects", () => {
  it("[shrink-ruling.real] its batch of one, passing fewer tests than the batch trunk took before it, parks on a question the lane asks the project's maintainers; their approve over the doorway resumes it, and it lands with that many fewer; a refuse bounces another, citing the decision", async () => {
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId, {
      gate: HumanGateRpc((address) => env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
      places: placedIn(projectId).layer,
    });
    await realTrunk(projectId, lane);
    // The doorway reads the project's own settings before anyone may rule on its question.
    await establishProject(projectId);
    const maintainer = await seedUser(uniqueHandle("keeper"), { role: "maintainer" });

    /** The change's batch formed, its candidate written, and KeelVerify's land with `tests`: the verdict's id. */
    const verified = async (c: ChangeUnderTest, tests: readonly StepCount[], previous?: string) => {
      await vi.waitFor(async () => {
        const now = await c.current();
        expect(now.state).toBe("integrating");
        expect(now.batchId).not.toBe(previous);
      }, WAIT);
      const batchId = (await c.current()).batchId;
      const [, started] = await lane.job(batchId);
      await lane.candidate(started.candidateId);
      const { verdictId } = await lane.verdict(
        batchId,
        "land",
        [`${TEST}: pass`],
        undefined,
        tests,
      );
      return { batchId, verdictId };
    };
    const parkedOn = async (c: ChangeUnderTest, verdictId: VerdictId) => {
      const escalationId = shrinkRulingIdOf(c.changeId, verdictId);
      await vi.waitFor(async () => {
        await drainOutbox(c.stub);
        expect(await c.current()).toMatchObject({
          state: "parked",
          parkReason: "awaiting-ruling",
          escalationId,
        });
      }, WAIT);
      return escalationId;
    };

    // Trunk's last verdict: the first change lands with 100 tests passed.
    const first = await changeUnderTest(projectId, "project");
    await queue(first);
    await verified(first, passed(100));
    await vi.waitFor(async () => expect((await first.current()).state).toBe("landed"), WAIT);

    // The second passes with 90: it parks on the question its lane put to the maintainers.
    const second = await changeUnderTest(projectId, "project");
    await queue(second);
    const shrank = await verified(second, passed(90));
    const question = await parkedOn(second, shrank.verdictId);
    await drainOutbox(namespaceObject());
    const put = await asked(question);
    expect(put.escalation).toMatchObject({
      category: "fewer-tests",
      about: { kind: "change", id: second.changeId },
    });
    expect(put.escalation.question).toContain(
      `${TEST} passed 90 tests, 10 fewer than the 100 trunk's last verdict passed`,
    );

    // A maintainer approves over the doorway: it resumes, and its next batch lands with 90.
    const yes = await rule(maintainer.token, question, "shrink-approve", SHRINK_RULING_APPROVE);
    expect([yes.status, yes.status === 200 ? "" : await yes.text()]).toEqual([200, ""]);
    await drainOutbox(namespaceObject());
    await vi.waitFor(async () => {
      await drainOutbox(second.stub);
      expect((await second.log()).map((e) => e.type)).toContain("ChangeResumed");
    }, WAIT);
    await verified(second, passed(90), shrank.batchId);
    await vi.waitFor(async () => expect((await second.current()).state).toBe("landed"), WAIT);
    expect((await second.log()).find((e) => e.type === "ChangeResumed")?.payload).toEqual({
      _tag: "ChangeResumed",
      changeId: second.changeId,
      decisionId: decisionIdOf(question),
    });

    // The third drops ten more below the 90 trunk now holds, and a refuse sends it back.
    const third = await changeUnderTest(projectId, "project");
    await queue(third);
    const dropped = await verified(third, passed(80));
    const again = await parkedOn(third, dropped.verdictId);
    await drainOutbox(namespaceObject());
    const no = await rule(maintainer.token, again, "shrink-refuse", "refuse");
    expect(no.status).toBe(200);
    await drainOutbox(namespaceObject());
    await vi.waitFor(async () => {
      await drainOutbox(third.stub);
      expect((await third.log()).find((e) => e.type === "ChangeBounced")?.payload).toMatchObject({
        decisionId: decisionIdOf(again),
      });
    }, WAIT);
    expect((await third.current()).state).toBe("bounced");
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(3), WAIT);
  });
});
