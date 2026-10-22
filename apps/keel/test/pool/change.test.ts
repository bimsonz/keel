import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { isAgentOwned, LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { TrunkAdvanced } from "@keeltown/core/domain/integration";
import { type CommitSha, makeId, type NextAction } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import { sampleProjectId, heldLease } from "@keeltown/testing";
import * as fc from "fast-check";
import { Effect, Exit, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import {
  type ChangeUnderTest,
  changeUnderTest,
  ok,
  refusal,
  replayed,
  unrenewed,
} from "./change-harness.ts";
import { BASE, drainAfter, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";
import { realLane, realTrunk } from "./real-lane.ts";
import { inertPrecheck } from "./inert-precheck.ts";

/** How long a test waits for something the object does by itself (a flush, an alarm). */
const WAIT = { timeout: 10_000, interval: 20 };

/**
 * Waits until each ChangeSubmitted in `c`'s log has started its Precheck
 * under `precheck`, which holds it inert. A case that submits ends with it:
 * an instance started after the case let go of `precheck` would run for real,
 * against a workspace no Artifacts binding serves, and retry past the file's end.
 */
async function prechecksStarted(
  c: { log(): Promise<readonly { readonly type: string }[]> },
  precheck: { get(): Promise<readonly unknown[]> },
): Promise<void> {
  const submitted = (await c.log()).filter((event) => event.type === "ChangeSubmitted");
  await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(submitted.length), WAIT);
}
const PLAN_HASH = `sha256:${"0".repeat(64)}`;
const seed = env.FC_SEED === undefined ? {} : { seed: Number(env.FC_SEED) };

const revise = async (c: ChangeUnderTest, leaseId: string, revision: number, key: string) =>
  decodeExit(
    ChangeCodecs.revise,
    await c.stub.revise({
      agentId: c.agentId,
      projectId: c.projectId,
      leaseId,
      ifMatchRevision: revision,
      goal: `Revised from ${revision}`,
      premisesAdded: [],
      premisesRetracted: [],
      idempotencyKey: key,
    }),
  );

const submit = async (c: ChangeUnderTest, leaseId: string, commitSha: string, key: string) =>
  decodeExit(
    ChangeCodecs.submit,
    await c.stub.submit({
      agentId: c.agentId,
      projectId: c.projectId,
      leaseId,
      commitSha,
      idempotencyKey: key,
    }),
  );

const adopt = async (c: ChangeUnderTest, agentId: string, key: string) =>
  Exit.map(
    decodeExit(
      ChangeCodecs.adopt,
      await c.stub.adopt({ agentId, projectId: c.projectId, idempotencyKey: key }),
    ),
    (adopted) => adopted.change,
  );

const abandon = async (c: ChangeUnderTest, leaseId: string, key: string) =>
  decodeExit(
    ChangeCodecs.abandon,
    await c.stub.abandon({
      authority: { _tag: "Lease", leaseId, agentId: c.agentId, projectId: c.projectId },
      idempotencyKey: key,
    }),
  );

/** Precheck refusing revision `revision` as instance `instanceId`. */
const refusing = (revision: number, instanceId: string) => ({
  revision,
  instanceId,
  reasons: ["precheck:protected:src/secret.ts"],
  nextActions: [
    {
      kind: "call" as const,
      title: "Move the change off the protected paths, then submit it again",
      operationId: "submit",
    },
  ],
});

/** The lease deadlines the object has armed. */
const leaseAlarms = (c: ChangeUnderTest) =>
  runInDurableObject(c.stub, (_instance: ChangeDO, state) =>
    armedAlarms(state.storage).filter((alarm) => alarm.reason.startsWith("lease ")),
  );

/** The lease's deadline, run as the alarm would run it, whenever the test says. */
const deadline = (c: ChangeUnderTest, leaseId: string) =>
  runInDurableObject(c.stub, (instance: ChangeDO) =>
    instance["onDeadline"]({
      kind: "deadline",
      reason: `lease ${leaseId} lapses`,
      at: Date.now(),
      starts: 1,
    }),
  );

/** The stored change agrees with its log: the state the events say, but for `renewedAt`. */
async function expectStateIsTheLog(c: ChangeUnderTest) {
  // Both in one turn of the object, so nothing (a Precheck the outbox started) commits between them.
  const { stored, log } = await runInDurableObject(c.stub, async (instance: ChangeDO) => ({
    stored: ok(decodeExit(ChangeCodecs.get, await instance.get())).change,
    log: await instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "change", id: c.changeId })),
    ),
  }));
  expect(unrenewed(stored)).toEqual(unrenewed(replayed(log)));
  return stored;
}

const STEPS = [
  "revise",
  "revise-stale-lease",
  "revise-wrong-revision",
  "submit",
  "submit-elsewhere",
  "precheck-started",
  "plan-compiled",
  "precheck-refused",
  "lease-ttl-passes",
  "deadline",
  "adopt",
  "abandon",
] as const;
type Step = (typeof STEPS)[number];

/** One random step, under whatever lease and revision the change has now; a refusal is a fine outcome. */
async function take(c: ChangeUnderTest, step: Step, i: number, sha: string): Promise<void> {
  const change = await c.current();
  const { revision } = change.intent;
  const lease = heldLease(change).id;
  switch (step) {
    case "revise":
      return void (await revise(c, lease, revision, `k${i}`));
    case "revise-stale-lease":
      return void (await revise(c, makeId("lse", ulid()), revision, `k${i}`));
    case "revise-wrong-revision":
      return void (await revise(c, lease, revision + 1, `k${i}`));
    case "submit":
      return void (await submit(c, lease, sha, `k${i}`));
    case "submit-elsewhere":
      return void (await submit(c, lease, "c".repeat(40), `k${i}`));
    case "precheck-started":
      return void (await c.stub.precheckStarted({ revision, instanceId: `p${i}`, commitSha: sha }));
    case "plan-compiled":
      return void (await c.stub.planCompiled({
        revision,
        instanceId: `p${i}`,
        planHash: PLAN_HASH,
        steps: 1,
        costEstimate: 1,
      }));
    case "precheck-refused":
      return void (await c.stub.precheckRefused(refusing(revision, `p${i}`)));
    case "lease-ttl-passes":
      return c.clock.advance(LEASE_TTL_MS);
    case "deadline":
      return deadline(c, lease);
    case "adopt":
      return void (await adopt(c, makeId("agt", ulid()), `k${i}`));
    case "abandon":
      return void (await abandon(c, lease, `k${i}`));
  }
}

describe("the Change DO over real RPC", () => {
  it(
    "[b11.replay] keeps, for any command sequence, the state its event log folds to, and no orphaned change",
    { timeout: 120_000 },
    async () => {
      // The steps drive Precheck by hand.
      const precheck = await inertPrecheck();
      let runs = 0;
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.constantFrom(...STEPS), { minLength: 1, maxLength: 10 }),
            async (steps) => {
              runs += 1;
              const c = await changeUnderTest();
              ok(await c.declare());
              const sha = await c.push();
              for (const [i, step] of steps.entries()) await take(c, step, i, sha);

              const stored = await expectStateIsTheLog(c);
              // No orphaned change: one waiting on its agent holds an active lease, or it is parked.
              expect(isAgentOwned(stored.state) ? heldLease(stored).state : "active").toBe(
                "active",
              );
            },
          ),
          { numRuns: 25, ...seed },
        );
      } finally {
        await precheck.dispose();
      }
      expect(runs).toBeGreaterThanOrEqual(25);
    },
  );

  it("[b11.declare-working] [b11.base-sha] answers a declare Working on its base, ready to submit at once", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const sha = await c.push();
    const submitted = await submit(c, heldLease(declared.change).id, sha, "submit-1");

    expect(declared.change.state).toBe("working");
    expect(declared.change.baseSha).toBe(declared.grant.baseSha);
    expect(ok(submitted).state).toBe("submitted");
    await prechecksStarted(c, precheck);
  });

  it("[b11.stale-lease] refuses the old token after adoption, with next actions", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    c.clock.advance(LEASE_TTL_MS);
    // Its own agent adopts it: another agent's adoption would leave it told who holds the change instead.
    const adopted = ok(await adopt(c, c.agentId, "adopt-1"));
    const stale = await revise(c, heldLease(declared.change).id, 1, "revise-1");

    expect(heldLease(adopted).id).not.toBe(heldLease(declared.change).id);
    expect(Exit.isFailure(stale) && refusal(stale)).toContain('"_tag":"LeaseStale"');
    expect(refusal(stale)).toContain('"reason":"stale"');
    expect(refusal(stale)).toMatch(/"nextActions":\[\{/);
  });
});

describe("ten concurrent calls on one change", () => {
  it("[b11.racers] revising and submitting under one lease leave exactly the state the log says", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    const sha = await c.push();
    const answers = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => revise(c, lease, 1, `revise-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => submit(c, lease, sha, `submit-${i}`)),
    ]);
    await expectStateIsTheLog(c);
    const types = (await c.log()).map((event) => event.type);

    expect(types.filter((type) => type === "ChangeSubmitted")).toHaveLength(1);
    expect(types.filter((type) => type === "IntentRevised").length).toBeLessThanOrEqual(1);
    expect(answers.filter((answer) => answer._tag === "Success")).toHaveLength(
      types.filter((type) => type === "ChangeSubmitted" || type === "IntentRevised").length,
    );
    await prechecksStarted(c, precheck);
  });

  it("[b11.racers] adopting, revising and submitting a lapsed change: exactly one adoption wins, one token is live", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const sha = await c.push();
    const oldLease = heldLease(declared.change).id;
    c.clock.advance(LEASE_TTL_MS);
    const adopters = Array.from({ length: 4 }, () => makeId("agt", ulid()));
    const [adoptions, revisions, submissions] = await Promise.all([
      Promise.all(adopters.map((agentId, i) => adopt(c, agentId, `adopt-${i}`))),
      Promise.all(Array.from({ length: 3 }, (_, i) => revise(c, oldLease, 1, `revise-${i}`))),
      Promise.all(Array.from({ length: 3 }, (_, i) => submit(c, oldLease, sha, `submit-${i}`))),
    ]);
    const stored = await expectStateIsTheLog(c);
    const won = adoptions.filter((answer) => Exit.isSuccess(answer));
    const winner = won[0] === undefined ? undefined : ok(won[0]);

    expect(won).toHaveLength(1);
    expect((await c.log()).filter((event) => event.type === "ChangeAdopted")).toHaveLength(1);
    expect(heldLease(stored)).toMatchObject({ id: winner?.lease?.id, state: "active" });
    expect([...revisions, ...submissions].filter((answer) => answer._tag === "Success")).toEqual(
      [],
    );
    // The winner is another agent, so the change's former agent is told who holds it now.
    expect(refusal(await revise(c, oldLease, 1, "revise-late"))).toContain("ChangeHeldByOther");
  });
});

describe("the lease's deadline", () => {
  it("[b11.lapse] is armed 15 minutes after each renewal, and not at all once the lease is released", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const lease = heldLease(declared.change);
    const atDeclare = await leaseAlarms(c);
    c.clock.advance(5 * 60_000);
    const renewed = heldLease(ok(await revise(c, lease.id, 1, "revise-1")).change);
    const atRenewal = await leaseAlarms(c);
    ok(await abandon(c, lease.id, "abandon-1"));

    expect(atDeclare).toEqual([
      { kind: "deadline", reason: `lease ${lease.id} lapses`, at: lease.renewedAt + LEASE_TTL_MS },
    ]);
    expect(renewed.renewedAt).toBe(lease.renewedAt + 5 * 60_000);
    expect(atRenewal).toEqual([
      {
        kind: "deadline",
        reason: `lease ${lease.id} lapses`,
        at: renewed.renewedAt + LEASE_TTL_MS,
      },
    ]);
    expect(await leaseAlarms(c)).toEqual([]);
  });

  it("[b11.lapse] parks the change when its deadline comes due through the object's alarm, and arms nothing after", async () => {
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    c.clock.advance(LEASE_TTL_MS);
    // The deadline is 15 real minutes away. Bring its row to now and run the object's own alarm
    // handler in the same turn, so the platform's timer (and a fresh, unrewired instance it may
    // wake) never decides the outcome: the row is due, `alarm` dispatches it to `onDeadline`.
    const { change, armed } = await runInDurableObject(
      c.stub,
      async (instance: ChangeDO, { storage }) => {
        await scheduleAlarm(storage, {
          kind: "deadline",
          reason: `lease ${lease} lapses`,
          at: Date.now(),
        });
        await instance.alarm();
        return {
          change: ok(decodeExit(ChangeCodecs.get, await instance.get())).change,
          armed: armedAlarms(storage).filter((alarm) => alarm.reason.startsWith("lease ")),
        };
      },
    );

    expect(change.state).toBe("parked");
    expect(change.parkReason).toBe("lease-lapsed");
    expect((await c.log()).map((event) => event.type).slice(-2)).toEqual([
      "LeaseLapsed",
      "ChangeParked",
    ]);
    expect(armed).toEqual([]);
    expect(await leaseAlarms(c)).toEqual([]);
  });

  it("[b11.lapse] commits nothing when it fires on a renewed lease, and re-arms for the renewal", async () => {
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    c.clock.advance(LEASE_TTL_MS - 1);
    ok(await revise(c, lease, 1, "revise-1"));
    const before = await c.log();
    c.clock.advance(1);
    await deadline(c, lease);

    expect(await c.log()).toEqual(before);
    expect((await c.current()).state).toBe("working");
    expect(await leaseAlarms(c)).toHaveLength(1);
  });

  it("[b11.lapse-held] arms no deadline while the platform holds the change, records no lapse past it, and arms one 15 minutes after the hand-back", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    const whileHeld = await leaseAlarms(c);
    c.clock.advance(LEASE_TTL_MS);
    await deadline(c, lease);
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({
          revision: 1,
          instanceId: "p-1",
          commitSha: await c.carried(),
        }),
      ),
    );
    c.clock.advance(1);
    const back = ok(
      decodeExit(ChangeCodecs.precheckRefused, await c.stub.precheckRefused(refusing(1, "p-1"))),
    ).change;

    expect(whileHeld).toEqual([]);
    expect((await c.log()).map((event) => event.type)).not.toContain("LeaseLapsed");
    expect(back.state).toBe("bounced");
    expect(back.lease).toMatchObject({ state: "active", renewedAt: c.clock.now() });
    expect(await leaseAlarms(c)).toEqual([
      { kind: "deadline", reason: `lease ${lease} lapses`, at: c.clock.now() + LEASE_TTL_MS },
    ]);
    await expectStateIsTheLog(c);
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("Precheck and the change", () => {
  it("[b11.precheck-once] starts one Precheck instance per submission, named for its ChangeSubmitted", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    const submitted = (await c.log()).find((event) => event.type === "ChangeSubmitted");
    if (submitted === undefined) throw new Error("no ChangeSubmitted was committed");

    await prechecksStarted(c, precheck);
    await expect(env.PRECHECK.get(`precheck-${submitted.eventId}`)).resolves.toBeDefined();
  });
});

describe("a Precheck refusal over RPC", () => {
  it("[b11.precheck-refused] bounces the change and answers the verdict it issued", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({
          revision: 1,
          instanceId: "p-1",
          commitSha: await c.carried(),
        }),
      ),
    );
    const refused = ok(
      decodeExit(ChangeCodecs.precheckRefused, await c.stub.precheckRefused(refusing(1, "p-1"))),
    );
    // The bounce, then the restart of the lease it hands back.
    const bounced = (await c.log()).at(-2);

    expect(refused.change.state).toBe("bounced");
    expect(bounced?.payload).toMatchObject({ _tag: "ChangeBounced", verdictId: refused.verdictId });
    await expectStateIsTheLog(c);
    // The submission's own Precheck started, and was held inert.
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("a compiled change and its lane", () => {
  it("[b13.queued] delivers the change's ChangeQueued to its project's lane", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({
          revision: 1,
          instanceId: "p-1",
          commitSha: await c.carried(),
        }),
      ),
    );
    const compiled = ok(
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
    const queued = (await c.log()).at(-1);
    if (queued?.type !== "ChangeQueued") throw new Error("no ChangeQueued was committed");
    const lane = drainAfter(env.LANE.get(env.LANE.idFromName(`lane:${sampleProjectId}:main`)));

    expect(compiled.state).toBe("queued");
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(lane, (_instance, state) =>
            state.storage.sql
              .exec("SELECT dedupe_key FROM keel_received WHERE dedupe_key = ?", queued.dedupeKey)
              .toArray(),
          ),
        ).toHaveLength(1),
      WAIT,
    );
    // The submission's own Precheck started, and was held inert.
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

/** Queues the change under test: declared, submitted, Precheck started and its plan compiled, all by hand. */
async function queue(c: ChangeUnderTest) {
  const lease = heldLease(ok(await c.declare()).change).id;
  ok(await submit(c, lease, await c.push(), "submit-1"));
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({
        revision: 1,
        instanceId: "p-1",
        commitSha: await c.carried(),
      }),
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

/** The dedupe keys the change under test has received, among `keys`. */
const received = (c: ChangeUnderTest, keys: readonly string[]) =>
  runInDurableObject(c.stub, (_instance: ChangeDO, state) =>
    keys.filter(
      (key) =>
        state.storage.sql.exec("SELECT 1 FROM keel_received WHERE dedupe_key = ?", key).toArray()
          .length > 0,
    ),
  );

/** KeelVerify's own remedy for a bounce, which the change must carry instead of the machine's default. */
const REMEDY: readonly NextAction[] = [
  {
    kind: "call",
    title: "Fix the failing assertion in test/auth.test.ts, then submit again",
    operationId: "submitChange",
  },
];

const decodeAdvanced = Schema.decodeUnknownSync(TrunkAdvanced);

describe("a change moved by its real lane's delivered events", () => {
  it("[b13.delivered] goes Queued → Integrating → Bounced on its lane's verdict, with the verdict's remedy, hearing only its own batch", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    const c = await changeUnderTest(projectId);
    const other = await changeUnderTest(projectId);

    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const batchId = (await c.current()).batchId;
    await queue(other);
    await lane.verdict(batchId, "bounce", ["test-failed: test/auth.test.ts"], REMEDY);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("bounced"), WAIT);
    // The lane forms the other change's batch once this one is done.
    await vi.waitFor(async () => expect((await other.current()).state).toBe("integrating"), WAIT);
    const otherBatch = (await other.current()).batchId ?? "";
    const otherFormed = (
      await runInDurableObject(lane.stub, (instance: LaneDO) =>
        instance["runtime"].runPromise(
          Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "batch", id: otherBatch })),
        ),
      )
    ).find((event) => event.type === "BatchFormed");
    const log = await c.log();

    expect(log.map((event) => event.type).slice(-4)).toEqual([
      "ChangeQueued",
      "ChangeBatched",
      "ChangeBounced",
      "LeaseRestarted",
    ]);
    // KeelVerify's remedy, through the lane's VerdictIssued, not the machine's "fix and submit".
    expect(log.at(-2)?.payload).toEqual(
      expect.objectContaining({ reasons: ["test-failed: test/auth.test.ts"], nextActions: REMEDY }),
    );
    expect(otherFormed).toBeDefined();
    expect(await received(c, [otherFormed?.dedupeKey ?? ""])).toEqual([]);
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(2), WAIT);
  });

  it("[b13.delivered] goes Queued → Integrating → Landed when its real Trunk DO promotes the verified batch", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    const trunk = await realTrunk(projectId, lane);
    const c = await changeUnderTest(projectId);

    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const batchId = (await c.current()).batchId;
    const [, started] = await lane.job(batchId);
    const tip: CommitSha = await lane.candidate(started.candidateId);
    // The land verdict commits BatchVerified; the Trunk hears it, debounces, pushes and advances.
    await lane.verdict(batchId, "land", ["suite: 12 passed"]);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("landed"), WAIT);
    const advances = (await trunk.log()).filter((event) => event.type === "TrunkAdvanced");
    const log = await c.log();

    expect(advances).toHaveLength(1);
    const advanced = decodeAdvanced(advances[0]?.payload);
    expect(advanced).toMatchObject({ from: lane.base, to: tip });
    expect(advanced.landings).toEqual([
      {
        changeId: c.changeId,
        commitSha: tip,
        candidateId: started.candidateId,
        proofId: expect.any(String),
      },
    ]);
    expect(log.map((event) => event.type).slice(-3)).toEqual([
      "ChangeQueued",
      "ChangeBatched",
      "ChangeLanded",
    ]);
    expect(log.at(-1)?.payload).toEqual({
      _tag: "ChangeLanded",
      changeId: c.changeId,
      commitSha: tip,
      trunkSha: tip,
      candidateId: started.candidateId,
      proofId: advanced.landings[0]?.proofId,
    });
    expect(trunk.writer.pushes()).toEqual([{ from: lane.base, to: tip }]);
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });

  it("[a11.declare-replay-landed] a declare retried under its key once its change has landed through its real Trunk DO is refused for the landed state, not a defect, and asks the pool for nothing", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    await realTrunk(projectId, lane);
    const c = await changeUnderTest(projectId);
    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const batchId = (await c.current()).batchId;
    const [, started] = await lane.job(batchId);
    await lane.candidate(started.candidateId);
    await lane.verdict(batchId, "land", ["suite: 12 passed"]);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("landed"), WAIT);
    const before = { granted: [...c.pool.granted], released: [...c.pool.released] };

    const retried = refusal(await c.declare());

    expect(retried).toContain('"_tag":"ChangeStateRefused"');
    expect(retried).toContain('"state":"landed"');
    expect(retried).toContain('"command":"Declare"');
    expect(retried).not.toContain("Die");
    expect({ granted: [...c.pool.granted], released: [...c.pool.released] }).toEqual(before);
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

/** KeelVerify's remedy for a red suite, naming the failing tests it read. */
const RED_REMEDY: readonly NextAction[] = [
  {
    kind: "call",
    title: "Fix the failing tests, push, and submit again",
    operationId: "submit",
    args: { failingTests: ["test/auth.test.ts"] },
  },
];

interface StatusBody {
  readonly summary: string;
  readonly next: readonly NextAction[];
}

/** The change's submission status through REST, as its agent's harness reads it. */
async function statusRest(c: ChangeUnderTest, token: string): Promise<StatusBody> {
  const response = await exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/submission`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json<StatusBody>();
}

/** The same read through the MCP tool `status`. */
async function statusTool(c: ChangeUnderTest, token: string): Promise<unknown> {
  const result = await mcpResult(
    await mcp(
      token,
      "tools/call",
      { name: "status", arguments: { changeId: c.changeId } },
      "status",
    ),
  );
  return result["structuredContent"];
}

describe("a parked change's next actions", () => {
  it("[b11.parked-remedy] a bounced change whose lease lapses reads adopt and then its bounce's remedy, verbatim, through REST and MCP alike", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    const c = await changeUnderTest(projectId);
    const token = await tokenFor(await seedAgent({ projectId }));

    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const integrating = await c.current();
    const { batchId } = integrating;
    const lease = heldLease(integrating);
    await lane.verdict(batchId, "bounce", ["test-failed: test/auth.test.ts"], RED_REMEDY);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("bounced"), WAIT);
    const bounced = await statusRest(c, token);
    // The lease lapses through the object's own alarm, as [b11.lapse] runs it.
    c.clock.advance(LEASE_TTL_MS);
    await runInDurableObject(c.stub, async (instance: ChangeDO, { storage }) => {
      await scheduleAlarm(storage, {
        kind: "deadline",
        reason: `lease ${lease.id} lapses`,
        at: Date.now(),
      });
      await instance.alarm();
    });
    const parked = await statusRest(c, token);
    const viaTool = await statusTool(c, token);

    expect(await c.current()).toMatchObject({ state: "parked", parkReason: "lease-lapsed" });
    expect(bounced.next).toEqual(RED_REMEDY);
    expect(parked.next).toEqual([
      {
        kind: "call",
        title: expect.any(String),
        operationId: "adopt",
        args: { changeId: c.changeId },
      },
      ...RED_REMEDY,
    ]);
    expect(parked.summary).toContain("test-failed: test/auth.test.ts");
    expect(viaTool).toMatchObject({ next: parked.next, summary: parked.summary });
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("waiting on a submission", () => {
  it("[b11.waiter] answers as soon as the change is submitted, well before the deadline", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = heldLease(ok(await c.declare()).change).id;
    const sha = await c.push();
    const started = Date.now();
    const waiting = c.stub.submission(20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    ok(await submit(c, lease, sha, "submit-1"));
    const status = ok(decodeExit(ChangeCodecs.submission, await waiting));

    expect(status.change.state).toBe("submitted");
    expect(status.commitSha).toBe(sha);
    expect(Date.now() - started).toBeLessThan(5_000);
    await prechecksStarted(c, precheck);
  });

  it("[b11.waiter] answers the change as it stands at the deadline when nothing moves", async () => {
    const c = await changeUnderTest();
    ok(await c.declare());
    const started = Date.now();
    const status = ok(decodeExit(ChangeCodecs.submission, await c.stub.submission(400)));

    expect(status).toMatchObject({ change: { state: "working" }, commitSha: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
});
