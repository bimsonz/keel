import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FlowWorld } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { EventOutbox, PlanStore, WorldChecks } from "@keeltown/core/ports";
import { suitePlan, heldLease } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PlanStoreR2 } from "../../src/adapters/driven/r2/plan-store.ts";
import { WorldChecksWorkflow } from "../../src/adapters/driven/workflow/world-checks.ts";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import {
  ChangeCodecs,
  decodeExit,
  type WorldCheckJob,
  worldCheckParams,
} from "../../src/rpc/index.ts";
import { suiteStdout } from "../support-suite-stdout.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { bundled, mockDepsReady } from "./deps-ready.ts";
import { forgetOwed, OTHER_ORG, POOL_ORG } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import {
  admitted,
  deliver,
  drafted,
  hash,
  kept,
  LEAF,
  logOf,
  subjectOf,
  suspected,
} from "./probe-harness.ts";

const SUITE = suitePlan();
const SUITE_STEP = "js-ts.suite";

/** Stores the plan as Precheck does, before any check names it. */
const stored = async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PlanStore).put(POOL_ORG, SUITE);
    }).pipe(Effect.provide(PlanStoreR2(env.ARCHIVE))),
  );
  return SUITE.planHash;
};

/** What the engine's runner step persists: its logs, as the suite command printed them. */
const runnerOutput = (stdout: string) => ({
  exitCode: 0,
  logs: { stdout, stderr: "" },
  snapshot: { id: "snap", dir: "/workspace", localBucket: true },
});

/** The conflict's checks of one world, as the Probe starts them. */
const jobOf = (
  s: Awaited<ReturnType<typeof suspected>>,
  world: FlowWorld,
  checks: WorldCheckJob["checks"],
): WorldCheckJob => ({
  namespace: POOL_ORG,
  projectId: s.projectId,
  key: LEAF,
  conflictId: s.conflictId,
  world,
  bundle: Schema.decodeUnknownSync(ContentHash)(hash("d")),
  checks,
});
/** A's own check in a world, its plan to be read from the change when the check runs. */
const partyJob = (s: Awaited<ReturnType<typeof suspected>>, world: FlowWorld): WorldCheckJob =>
  jobOf(s, world, [{ check: `suite:${s.A}`, plan: { _tag: "OfChange", changeId: s.A } }]);

/** The Precheck pass a case answers by hand, for a change's first submission. */
const PASS = { revision: 1, instanceId: "precheck-by-hand" };

/**
 * A real change on its own Change DO, submitted. Its ChangeSubmitted started
 * a real Precheck, which the case holds inert: no plan and no refusal has
 * come of the submission.
 */
async function submittedChange(precheck: Awaited<ReturnType<typeof inertPrecheck>>) {
  const c = await changeUnderTest();
  ok(await c.declare());
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: heldLease(await c.current()).id,
        commitSha,
        idempotencyKey: "submit-1",
      }),
    ),
  );
  await vi.waitFor(async () => expect(await precheck.get()).toHaveLength(1), {
    timeout: 10_000,
    interval: 50,
  });
  return c;
}

/** Who the change's next event of `type` would notify now. */
const hearing = (c: ChangeUnderTest, type: string) =>
  runInDurableObject(c.stub, (instance: ChangeDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox.subscribers(type, { entity: { kind: "change", id: c.changeId }, affected: [] }),
      ),
    ),
  );

/** A WorldCheckRan's cell, as the Subject DO records it. */
const Cell = Schema.Struct({
  world: Schema.String,
  check: Schema.String,
  run: Schema.Int,
  outcome: Schema.String,
  reason: Schema.optional(Schema.String),
});

/** Runs one world's checks through the real Workflow and the real CI engine, the suite's runner step mocked. */
async function runWorld(job: WorldCheckJob, stdout?: string, deps: "ready" | "real" = "ready") {
  const id = `world-${job.conflictId}-${job.world}`;
  await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
  if (stdout !== undefined)
    await instance.modify(async (m) => {
      // Mocked ready unless the case runs the deps steps themselves.
      if (deps === "ready") await mockDepsReady(m);
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(stdout));
    });
  await env.WORLD_CHECK.create({ id, params: worldCheckParams(job) });
  await instance.waitForStatus("complete");
}

/**
 * KeelWorldCheck through the real Workflow and the real CI engine. The pool
 * cannot start a container, so the suite's runner step is mocked with the
 * suite command's output, once: a second runner call would find no mock and
 * no container. Everything after it (the plan read from ARCHIVE, evidence,
 * the cell, each WorldCheckRan on the conflict's real Subject DO) runs for
 * real.
 */
describe("KeelWorldCheck", () => {
  it("[d22.pool.world-check-ab] AB's two checks run the suite once and record two WorldCheckRan, each under its own party's plan", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    await runWorld(
      jobOf(s, "AB", [
        { check: `suite:${s.A}`, plan: { _tag: "Planned", planHash } },
        { check: `suite:${s.B}`, plan: { _tag: "Planned", planHash } },
      ]),
      await suiteStdout(200, 0),
    );
    expect(await recorded(s)).toEqual([
      { world: "AB", check: `suite:${s.A}`, run: 1, outcome: "pass" },
      { world: "AB", check: `suite:${s.B}`, run: 1, outcome: "pass" },
    ]);
  });

  it("[t5.pool.job-namespace] a world check that names a namespace its project is not in runs nothing and records nothing: the instance ends at its namespace step", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    const job = {
      ...jobOf(s, "AB", [{ check: `suite:${s.A}`, plan: { _tag: "Planned", planHash } }]),
      namespace: OTHER_ORG,
    } satisfies WorldCheckJob;
    const id = `world-${job.conflictId}-${job.world}`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    // Were the job's namespace taken on trust, the mocked runner would let the check run and be recorded.
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(await suiteStdout(1, 0)));
    });
    await env.WORLD_CHECK.create({ id, params: worldCheckParams(job) });
    const handle = await env.WORLD_CHECK.get(id);
    await vi.waitFor(
      async () => expect((await handle.status()).status).toMatch(/^(errored|complete)$/),
      { timeout: 15_000, interval: 50 },
    );
    expect(await handle.status()).toMatchObject({
      status: "errored",
      error: { message: expect.stringContaining("NonRetryableError") },
    });
    expect(await recorded(s)).toEqual([]);
  });

  it("[d22.pool.world-check-red] a red suite in a world records its check as a fail, saying which step", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    await runWorld(
      jobOf(s, "trunk", [{ check: "suite:trunk", plan: { _tag: "Planned", planHash } }]),
      await suiteStdout(200, 2),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "trunk",
        check: "suite:trunk",
        run: 1,
        outcome: "fail",
        reason: `${SUITE_STEP} failed`,
      },
    ]);
  });

  it("[deps.pool.world-steps] a world's check ensures the world's own deps before its suite: ready deps run it, and refused or unavailable ones ask no runner", async () => {
    const files = {
      "package.json": '{"name":"world"}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    };
    const planHash = await stored();
    const cellOf = async (extra: Readonly<Record<string, string>>, stdout?: string) => {
      const s = await suspected();
      await drafted(s.projectId, s.conflictId);
      const bundle = await bundled({ ...files, ...extra });
      await runWorld(
        {
          ...jobOf(s, "trunk", [{ check: "suite:trunk", plan: { _tag: "Planned", planHash } }]),
          bundle,
        },
        stdout,
        "real",
      );
      return recorded(s);
    };
    expect(await cellOf({}, await suiteStdout(200, 0))).toEqual([
      { world: "trunk", check: "suite:trunk", run: 1, outcome: "pass" },
    ]);
    expect(await cellOf({ "refused/package.json": "{}\n" })).toEqual([
      {
        world: "trunk",
        check: "suite:trunk",
        run: 1,
        outcome: "fail",
        reason: `${SUITE_STEP} did not run: deps-refused: install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE`,
      },
    ]);
    expect(await cellOf({ "unavailable/package.json": "{}\n" })).toEqual([
      {
        world: "trunk",
        check: "suite:trunk",
        run: 1,
        outcome: "n/a",
        reason: `${SUITE_STEP} did not run: deps-unavailable: upload-failed`,
      },
    ]);
  });

  it("[d22.pool.world-check-unplanned] a check with no plan is recorded n/a with why, and runs nothing", async () => {
    const s = await suspected();
    await drafted(s.projectId, s.conflictId);
    await runWorld(
      jobOf(s, "B", [
        {
          check: `suite:${s.B}`,
          plan: { _tag: "Unplanned", reason: `${s.B} is bounced with no compiled plan` },
        },
      ]),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "B",
        check: `suite:${s.B}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.B} is bounced with no compiled plan`,
      },
    ]);
  });

  it("[d22.pool.world-check-waits] a check started before its party's Precheck compiled waits as that change's one-shot subscriber, and runs the suite once the change's own PlanCompiled reaches it", async () => {
    await using precheck = await inertPrecheck();
    const c = await submittedChange(precheck);
    const s = await suspected({ A: c.changeId });
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    const stdout = await suiteStdout(200, 0);
    await instance.modify(async (m) => {
      await mockDepsReady(m);
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(stdout));
    });
    await env.WORLD_CHECK.create({ id, params: worldCheckParams(partyJob(s, "A")) });
    // The order the live run had: the check reads its party before Precheck has answered.
    await instance.waitForStepResult({ name: `clock suite:${s.A} 1` });
    expect(await hearing(c, "PlanCompiled")).toContain(`workflow:KeelWorldCheck/${id}`);
    expect(await recorded(s)).toEqual([]);
    // Precheck answers: the Change DO's own outbox tells the instance, through the fan-out.
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ ...PASS, commitSha: await c.carried() }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.planCompiled,
        await c.stub.planCompiled({ ...PASS, planHash, steps: 1, costEstimate: 1 }),
      ),
    );
    await instance.waitForStatus("complete");
    expect(await recorded(s)).toEqual([
      { world: "A", check: `suite:${s.A}`, run: 1, outcome: "pass" },
    ]);
    expect(await hearing(c, "PlanCompiled")).not.toContain(`workflow:KeelWorldCheck/${id}`);
  });

  it("[d22.pool.world-check-told-early] a plan's event sent before the instance reaches its wait still wakes it: the check reads the change again and runs its suite", async () => {
    await using precheck = await inertPrecheck();
    const c = await submittedChange(precheck);
    const s = await suspected({ A: c.changeId });
    await drafted(s.projectId, s.conflictId);
    const planHash = await stored();
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ ...PASS, commitSha: await c.carried() }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.planCompiled,
        await c.stub.planCompiled({ ...PASS, planHash, steps: 1, costEstimate: 1 }),
      ),
    );
    const compiled = (await c.log()).find((e) => e.type === "PlanCompiled");
    if (compiled === undefined) throw new Error("no PlanCompiled committed");
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    const stdout = await suiteStdout(200, 0);
    await instance.modify(async (m) => {
      // The first read is kept as Waiting: the plan compiled right after it answered.
      await m.mockStepResult({ name: `plan of suite:${s.A} 1` }, kept({ _tag: "Waiting" }));
      await mockDepsReady(m);
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(stdout));
    });
    await env.WORLD_CHECK.create({ id, params: worldCheckParams(partyJob(s, "A")) });
    // Sent with the start, before any wait began.
    expect((await deliver(`workflow:KeelWorldCheck/${id}`, [compiled]))._tag).toBe("Success");
    await instance.waitForStatus("complete");
    expect(await recorded(s)).toEqual([
      { world: "A", check: `suite:${s.A}`, run: 1, outcome: "pass" },
    ]);
  });

  it("[d22.pool.world-check-refused] a party whose Precheck refuses while its check waits is recorded n/a, saying the change bounced, and runs nothing", async () => {
    await using precheck = await inertPrecheck();
    const c = await submittedChange(precheck);
    const s = await suspected({ A: c.changeId });
    await drafted(s.projectId, s.conflictId);
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    await env.WORLD_CHECK.create({ id, params: worldCheckParams(partyJob(s, "A")) });
    await instance.waitForStepResult({ name: `clock suite:${s.A} 1` });
    ok(
      decodeExit(
        ChangeCodecs.precheckStarted,
        await c.stub.precheckStarted({ ...PASS, commitSha: await c.carried() }),
      ),
    );
    ok(
      decodeExit(
        ChangeCodecs.precheckRefused,
        await c.stub.precheckRefused({
          ...PASS,
          reasons: ["precheck:protected:src/secret.ts"],
          nextActions: [
            {
              kind: "call",
              title: "Move the change off the protected paths",
              operationId: "submit",
            },
          ],
        }),
      ),
    );
    await instance.waitForStatus("complete");
    expect(await recorded(s)).toEqual([
      {
        world: "A",
        check: `suite:${s.A}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.A} is bounced with no compiled plan`,
      },
    ]);
  });

  it("[d22.pool.world-check-deadline] a party whose Precheck never answers within the wait is recorded n/a, saying so", async () => {
    await using precheck = await inertPrecheck();
    const c = await submittedChange(precheck);
    const s = await suspected({ A: c.changeId });
    await drafted(s.projectId, s.conflictId);
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: `change suite:${s.A} 1` });
    });
    await env.WORLD_CHECK.create({ id, params: worldCheckParams(partyJob(s, "A")) });
    await instance.waitForStatus("complete");
    expect(await recorded(s)).toEqual([
      {
        world: "A",
        check: `suite:${s.A}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.A}'s Precheck compiled no plan within 5 minutes`,
      },
    ]);
    await forgetOwed(c.stub, `workflow:KeelWorldCheck/${id}`);
  });

  it("[d22.pool.world-check-decided] a conflict whose probe has decided still takes its checks: they are evidence for people, not for admission", async () => {
    const s = await suspected();
    await admitted(s.projectId, s.conflictId);
    await runWorld(
      jobOf(s, "A", [
        {
          check: `suite:${s.A}`,
          plan: { _tag: "Unplanned", reason: `${s.A} is withdrawn with no compiled plan` },
        },
      ]),
    );
    expect(await recorded(s)).toEqual([
      {
        world: "A",
        check: `suite:${s.A}`,
        run: 1,
        outcome: "n/a",
        reason: `${s.A} is withdrawn with no compiled plan`,
      },
    ]);
  });

  it("[d22.pool.world-check-stale] a conflict whose probe was never drafted takes no check: the instance ends with nothing recorded", async () => {
    const s = await suspected();
    await runWorld(
      jobOf(s, "B", [{ check: `suite:${s.B}`, plan: { _tag: "Unplanned", reason: "no plan" } }]),
    );
    expect(await recorded(s)).toEqual([]);
    expect(await logOf(s.projectId, { kind: "conflict", id: s.conflictId })).not.toContain(
      "WorldCheckRan",
    );
  });

  it("[d22.pool.world-checks-start] the Probe's start makes one instance per world, by its id, once", async () => {
    const s = await suspected();
    const job = jobOf(s, "A", [
      { check: `suite:${s.A}`, plan: { _tag: "Unplanned", reason: "no plan" } },
    ]);
    const id = `world-${s.conflictId}-A`;
    await using instance = await introspectWorkflowInstance(env.WORLD_CHECK, id);
    const start = Effect.gen(function* () {
      yield* (yield* WorldChecks).start(id, job);
    }).pipe(Effect.provide(WorldChecksWorkflow(env.WORLD_CHECK)));
    await Effect.runPromise(start);
    await Effect.runPromise(start);
    await instance.waitForStatus("complete");
    expect((await (await env.WORLD_CHECK.get(id)).status()).status).toBe("complete");
  });
});

/** The checks the conflict's Subject DO holds, from its WorldCheckRan events, in order. */
async function recorded(s: Awaited<ReturnType<typeof suspected>>) {
  return runInDurableObject(subjectOf(s.projectId), (instance: SubjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox
          .log({ kind: "conflict", id: s.conflictId })
          .filter((e) => e.type === "WorldCheckRan")
          .map((e) => {
            const { world, check, run, outcome, reason } = Schema.decodeUnknownSync(Cell)(
              e.payload,
            );
            return { world, check, run, outcome, ...(reason === undefined ? {} : { reason }) };
          }),
      ),
    ),
  );
}
