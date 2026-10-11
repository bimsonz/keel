import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { laneOf } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { isAgentOwned, LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { type EntityRef, makeId, type ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  commit,
  type EventDraft,
  EventOutbox,
  type VerificationJob,
} from "@keeltown/core/ports";
import {
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
  sampleProjectId,
} from "@keeltown/testing";
import * as fc from "fast-check";
import { Effect, Exit, Layer, ManagedRuntime, Result, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { ChangeCodecs, decodeExit, exitCodec, LaneCodecs } from "../../src/rpc/index.ts";
import {
  type ChangeUnderTest,
  changeUnderTest,
  ok,
  refusal,
  replayed,
  unrenewed,
} from "./change-harness.ts";
import { drainAfter } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

/** How long a test waits for something the object does by itself (a flush, an alarm). */
const WAIT = { timeout: 10_000, interval: 20 };
const PLAN_HASH = `sha256:${"0".repeat(64)}`;
const seed = env.FC_SEED === undefined ? {} : { seed: Number(env.FC_SEED) };

const revise = async (c: ChangeUnderTest, leaseId: string, revision: number, key: string) =>
  decodeExit(
    ChangeCodecs.revise,
    await c.stub.revise({
      agentId: c.agentId,
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
    await c.stub.submit({ agentId: c.agentId, leaseId, commitSha, idempotencyKey: key }),
  );

const adopt = async (c: ChangeUnderTest, agentId: string, key: string) =>
  decodeExit(ChangeCodecs.adopt, await c.stub.adopt({ agentId, idempotencyKey: key }));

const abandon = async (c: ChangeUnderTest, leaseId: string, key: string) =>
  decodeExit(
    ChangeCodecs.abandon,
    await c.stub.abandon({
      agentId: c.agentId,
      authority: { _tag: "Lease", leaseId },
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
    instance["onDeadline"]({ kind: "deadline", reason: `lease ${leaseId} lapses`, at: Date.now() }),
  );

/** The stored change agrees with its log: the state the events say, but for `renewedAt`. */
async function expectStateIsTheLog(c: ChangeUnderTest) {
  // Both in one turn of the object, so nothing (a Precheck the outbox started) commits between them.
  const { stored, log } = await runInDurableObject(c.stub, async (instance: ChangeDO) => ({
    stored: ok(decodeExit(ChangeCodecs.get, await instance.get())),
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
  const lease = change.lease.id;
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
      return void (await c.stub.precheckStarted({ revision, instanceId: `p${i}` }));
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
              expect(isAgentOwned(stored.state) ? stored.lease.state : "active").toBe("active");
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
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const sha = await c.push();
    const submitted = await submit(c, declared.change.lease.id, sha, "submit-1");

    expect(declared.change.state).toBe("working");
    expect(declared.change.baseSha).toBe(declared.grant.baseSha);
    expect(ok(submitted).state).toBe("submitted");
  });

  it("[b11.stale-lease] refuses the old token after adoption, with next actions", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    c.clock.advance(LEASE_TTL_MS);
    const adopted = ok(await adopt(c, makeId("agt", ulid()), "adopt-1"));
    const stale = await revise(c, declared.change.lease.id, 1, "revise-1");

    expect(adopted.lease.id).not.toBe(declared.change.lease.id);
    expect(Exit.isFailure(stale) && refusal(stale)).toContain('"_tag":"LeaseStale"');
    expect(refusal(stale)).toContain('"reason":"stale"');
    expect(refusal(stale)).toMatch(/"nextActions":\[\{/);
  });
});

describe("ten concurrent calls on one change", () => {
  it("[b11.racers] revising and submitting under one lease leave exactly the state the log says", async () => {
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
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
  });

  it("[b11.racers] adopting, revising and submitting a lapsed change: exactly one adoption wins, one token is live", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const sha = await c.push();
    const oldLease = declared.change.lease.id;
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
    expect(stored.lease).toMatchObject({ id: winner?.lease.id, state: "active" });
    expect([...revisions, ...submissions].filter((answer) => answer._tag === "Success")).toEqual(
      [],
    );
    expect(refusal(await revise(c, oldLease, 1, "revise-late"))).toContain("LeaseStale");
  });
});

describe("the lease's deadline", () => {
  it("[b11.lapse] is armed 15 minutes after each renewal, and not at all once the lease is released", async () => {
    const c = await changeUnderTest();
    const declared = ok(await c.declare());
    const lease = declared.change.lease;
    const atDeclare = await leaseAlarms(c);
    c.clock.advance(5 * 60_000);
    const renewed = ok(await revise(c, lease.id, 1, "revise-1")).change.lease;
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

  it("[b11.lapse] parks the change when it fires through the real alarm, and arms nothing after", async () => {
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    c.clock.advance(LEASE_TTL_MS);
    // The deadline is 15 minutes away in real time: bring its row to now, so the platform alarm
    // fires it. An alarm still finishing the declare's flush re-arms the row from `renewedAt` as
    // it ends, so the row is brought to now again, in the same turn as the check, until it fires.
    await vi.waitFor(async () => {
      await runInDurableObject(c.stub, async (instance: ChangeDO, state) => {
        if (ok(decodeExit(ChangeCodecs.get, await instance.get())).state === "parked") return;
        await scheduleAlarm(state.storage, {
          kind: "deadline",
          reason: `lease ${lease} lapses`,
          at: Date.now(),
        });
      });
      expect((await c.current()).state).toBe("parked");
    }, WAIT);

    expect((await c.current()).parkReason).toBe("lease-lapsed");
    expect((await c.log()).map((event) => event.type).slice(-2)).toEqual([
      "LeaseLapsed",
      "ChangeParked",
    ]);
    await vi.waitFor(async () => expect(await leaseAlarms(c)).toEqual([]), WAIT);
  });

  it("[b11.lapse] commits nothing when it fires on a renewed lease, and re-arms for the renewal", async () => {
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    c.clock.advance(LEASE_TTL_MS - 1);
    ok(await revise(c, lease, 1, "revise-1"));
    const before = await c.log();
    c.clock.advance(1);
    await deadline(c, lease);

    expect(await c.log()).toEqual(before);
    expect((await c.current()).state).toBe("working");
    expect(await leaseAlarms(c)).toHaveLength(1);
  });
});

describe("Precheck and the change", () => {
  it("[b11.precheck-once] starts one Precheck instance per submission, named for its ChangeSubmitted", async () => {
    await using introspector = await introspectWorkflow(env.PRECHECK);
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    const submitted = (await c.log()).find((event) => event.type === "ChangeSubmitted");
    if (submitted === undefined) throw new Error("no ChangeSubmitted was committed");

    await vi.waitFor(async () => expect(await introspector.get()).toHaveLength(1), WAIT);
    await expect(env.PRECHECK.get(`precheck-${submitted.eventId}`)).resolves.toBeDefined();
  });
});

describe("a Precheck refusal over RPC", () => {
  it("[b11.precheck-refused] bounces the change and answers the verdict it issued", async () => {
    await using precheck = await inertPrecheck();
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
      ),
    );
    const refused = ok(
      decodeExit(ChangeCodecs.precheckRefused, await c.stub.precheckRefused(refusing(1, "p-1"))),
    );
    const bounced = (await c.log()).at(-1);

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
    const lease = ok(await c.declare()).change.lease.id;
    ok(await submit(c, lease, await c.push(), "submit-1"));
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
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
  const lease = ok(await c.declare()).change.lease.id;
  ok(await submit(c, lease, await c.push(), "submit-1"));
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

const committedCodec = exitCodec(Schema.Null, Schema.Never);

/**
 * Commits `drafts` on a real Trunk DO, as a promotion does:
 * through its own outbox, after subscribing each `scoped` change to `types` on
 * its own ref. The DO's answer arms its flush, so the events leave by its
 * fan-out alone. Until C1.3 commits TrunkAdvanced, the advance is written here.
 */
async function trunkCommits(
  trunk: DurableObjectStub<TrunkDO>,
  projectId: ProjectId,
  drafts: readonly EventDraft[],
  scoped: readonly { readonly changeId: string; readonly types: readonly string[] }[],
) {
  const entity: EntityRef = { kind: "trunk", id: projectId };
  const committed = await runInDurableObject(trunk, (instance: TrunkDO) =>
    instance["answer"](
      committedCodec,
      commit({ entity, cause: `test-${ulid()}` }, (tx) => {
        for (const member of scoped)
          tx.outbox.subscribe(`change:${member.changeId}`, member.types, {
            kind: "change",
            id: member.changeId,
          });
        return Result.succeed({ value: null, drafts });
      }).pipe(Effect.as(null)),
    ),
  );
  ok(decodeExit(committedCodec, committed));
}

/**
 * The project's real Lane DO, on in-memory driven adapters as the Lane DO's
 * C's own pool test runs it, reading its members from their real Change DOs.
 * Its staging holds one commit; KeelVerify is the in-memory verification,
 * whose started jobs the test answers through the lane's `recordVerdict`.
 */
async function realLane(projectId: ProjectId) {
  const stub = drainAfter(env.LANE.get(env.LANE.idFromName(laneOf(projectId))));
  const staging = projectRepos(projectId).staging;
  const code = makeCodeHostMemory();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(staging);
      yield* code.fixture.commit(staging, "refs/heads/main", { "README.md": "keel\n" });
    }).pipe(Effect.provide(code.layer)),
  );
  const verification = makeBatchVerificationMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  const changes = ChangesRpc({
    change: (id) => env.CHANGE.get(env.CHANGE.idFromName(`change:${id}`)),
    agentSession: (id) => env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${id}`)),
  });
  const driven: Layer.Layer<LaneServices> = Layer.mergeAll(
    code.layer,
    changes,
    makeCandidateComposerMemory().layer,
    makeCandidateBundlesMemory().layer,
    verification.layer,
    makeStagingWriterMemory().layer,
    projects.layer,
  );
  await runInDurableObject(stub, (instance: LaneDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
    );
  });

  /** KeelVerify's job for `batchId`, once the lane has started it. */
  const job = async (batchId: string | undefined) => {
    let found: readonly [string, VerificationJob] | undefined;
    await vi.waitFor(() => {
      found = [...verification.started.entries()].find(([, j]) => j.fence.batchId === batchId);
      expect(found).toBeDefined();
    }, WAIT);
    if (found === undefined) throw new Error(`KeelVerify never started for ${String(batchId)}`);
    return found;
  };

  /** Answers the batch's KeelVerify job with `outcome`, as the workflow's last step does. */
  const verdict = async (
    batchId: string | undefined,
    outcome: "land" | "bounce",
    evidence: readonly string[],
  ) => {
    const [instanceId, started] = await job(batchId);
    const recorded = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict({
        instanceId,
        fence: started.fence,
        candidateId: started.candidateId,
        verdictId: makeId("vrd", ulid()),
        outcome,
        planHash: L1_SUITE_PLAN.planHash,
        evidence: [...evidence],
        failingTests: outcome === "bounce" ? ["test/auth.test.ts"] : [],
      }),
    );
    expect(recorded).toEqual(Exit.void);
    return started;
  };

  return { stub, verdict };
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

describe("a change moved by its real lane's delivered events", () => {
  it("[b13.delivered] goes Queued → Integrating → Bounced on its lane's verdict, hearing only its own batch", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    const c = await changeUnderTest(projectId);
    const other = await changeUnderTest(projectId);

    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const batchId = (await c.current()).batchId;
    await queue(other);
    await lane.verdict(batchId, "bounce", ["test-failed: test/auth.test.ts"]);
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

    expect(log.map((event) => event.type).slice(-3)).toEqual([
      "ChangeQueued",
      "ChangeBatched",
      "ChangeBounced",
    ]);
    // The lane's verdict names no next action yet, so the machine's own stands in.
    expect(log.at(-1)?.payload).toMatchObject({
      reasons: ["test-failed: test/auth.test.ts"],
      nextActions: [expect.objectContaining({ kind: expect.any(String) })],
    });
    expect(otherFormed).toBeDefined();
    expect(await received(c, [otherFormed?.dedupeKey ?? ""])).toEqual([]);
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(2), WAIT);
  });

  it("[b13.delivered] goes Queued → Integrating → Landed from its own landing in a real Trunk DO's advance", async () => {
    await using precheck = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const lane = await realLane(projectId);
    const trunk = drainAfter(env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`)));
    const c = await changeUnderTest(projectId);
    const otherChange = makeId("chg", ulid());

    await queue(c);
    await vi.waitFor(async () => expect((await c.current()).state).toBe("integrating"), WAIT);
    const green = await lane.verdict((await c.current()).batchId, "land", ["suite: 12 passed"]);

    // The group lands another member first: this change lands from its own landing only.
    const to = "d".repeat(40);
    await trunkCommits(
      trunk,
      projectId,
      [
        {
          payload: {
            _tag: "TrunkAdvanced",
            projectId,
            from: "b".repeat(40),
            to,
            groupId: `group-${ulid()}`,
            landings: [
              {
                changeId: otherChange,
                commitSha: "1".repeat(40),
                candidateId: makeId("cnd", ulid()),
                proofId: "prf-other",
              },
              {
                changeId: c.changeId,
                commitSha: "2".repeat(40),
                candidateId: green.candidateId,
                proofId: "prf-mine",
              },
            ],
            height: 1,
          },
          affected: [
            { kind: "change", id: otherChange },
            { kind: "change", id: c.changeId },
          ],
        },
      ],
      [{ changeId: c.changeId, types: ["TrunkAdvanced"] }],
    );
    await vi.waitFor(async () => expect((await c.current()).state).toBe("landed"), WAIT);
    const log = await c.log();

    expect(log.map((event) => event.type).slice(-3)).toEqual([
      "ChangeQueued",
      "ChangeBatched",
      "ChangeLanded",
    ]);
    expect(log.at(-1)?.payload).toEqual({
      _tag: "ChangeLanded",
      changeId: c.changeId,
      commitSha: "2".repeat(40),
      trunkSha: to,
      candidateId: green.candidateId,
      proofId: "prf-mine",
    });
    await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), WAIT);
  });
});

describe("waiting on a submission", () => {
  it("[b11.waiter] answers as soon as the change is submitted, well before the deadline", async () => {
    const c = await changeUnderTest();
    const lease = ok(await c.declare()).change.lease.id;
    const sha = await c.push();
    const started = Date.now();
    const waiting = c.stub.submission(20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    ok(await submit(c, lease, sha, "submit-1"));
    const status = ok(decodeExit(ChangeCodecs.submission, await waiting));

    expect(status.change.state).toBe("submitted");
    expect(status.commitSha).toBe(sha);
    expect(Date.now() - started).toBeLessThan(5_000);
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
