import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  SettledVerdict,
  StoredStepReport,
  storedPlanText,
} from "@keeltown/core/application/verification";
import type { FlowPlan } from "@keeltown/core/domain/verification";
import { BatchId, CandidateId, ContentHash, makeId } from "@keeltown/core/kernel";
import { EvidenceStore, PlanStore } from "@keeltown/core/ports";
import { guardedPlan, suitePlan, TEST_GUARD, workerAppPlan } from "@keeltown/testing";
import { Effect, Result, Schema } from "effect";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { evidenceKey, EvidenceStoreR2 } from "../../src/adapters/driven/r2/evidence-store.ts";
import { PlanStoreR2, planKey } from "../../src/adapters/driven/r2/plan-store.ts";
import { type KeelVerifyJob, keelVerifyParams } from "../../src/rpc/index.ts";
import { suiteStdout, typecheckStdout } from "../support-suite-stdout.ts";
import { OTHER_ORG, placeProject, POOL_ORG } from "./helpers.ts";

/** The project every job in this file is for, placed in org `pool` before any instance runs. */
const PROJECT_ID = makeId("prj", ulid());

beforeAll(() => placeProject(PROJECT_ID));

/** Stores the plan as Precheck does, before any job names it. */
const stored = async (plan: FlowPlan): Promise<FlowPlan> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PlanStore).put(POOL_ORG, plan);
    }).pipe(Effect.provide(PlanStoreR2(env.ARCHIVE))),
  );
  return plan;
};

const SUITE = suitePlan();

const job = (overrides: Partial<KeelVerifyJob> = {}): KeelVerifyJob => ({
  projectId: PROJECT_ID,
  namespace: POOL_ORG,
  jobId: "job-pool",
  laneId: "lane:prj:default",
  candidateId: Schema.decodeUnknownSync(CandidateId)("cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"d".repeat(64)}`),
  fence: {
    batchId: Schema.decodeUnknownSync(BatchId)("bat_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
    attempt: 1,
    chainEpoch: 0,
  },
  planHash: SUITE.planHash,
  ...overrides,
});

/** What the engine's runner step persists: its logs, as the suite command printed them. */
const runnerOutput = (stdout: string) => ({
  exitCode: 0,
  logs: { stdout, stderr: "" },
  snapshot: { id: "snap", dir: "/workspace", localBucket: true },
});

/** Runs a job to its verdict, each named step's result mocked (runner steps by step id). */
const runWith = async (
  id: string,
  mocks: Record<string, unknown>,
  params: ReturnType<typeof keelVerifyParams>,
) => {
  await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
  await instance.modify(async (m) => {
    for (const [name, result] of Object.entries(mocks)) await m.mockStepResult({ name }, result);
    await m.mockStepResult({ name: "record" }, "recorded");
  });
  await env.CI_WORKFLOW.create({ id, params });
  const verdict = await instance.waitForStepResult({ name: "verdict" });
  await instance.waitForStatus("complete");
  // The step persists the verdict as JSON, since a next action's args are open.
  return Schema.decodeUnknownSync(SettledVerdict)(JSON.parse(String(verdict)));
};

const SUITE_STEP = "js-ts.suite";
const run = async (id: string, stdout: string) =>
  runWith(
    id,
    { [SUITE_STEP]: runnerOutput(stdout) },
    keelVerifyParams(job({ planHash: (await stored(SUITE)).planHash })),
  );

/**
 * KeelVerify through the real Workflow and the real CI engine. The pool cannot
 * start a container, so the runner's step result is mocked with the suite
 * command's output; everything after it (evidence into ARCHIVE, the verdict)
 * runs for real. `record` is mocked, in place of the Lane DO's recordVerdict.
 */
describe("KeelVerify", () => {
  it("lands a green candidate, citing the evidence it stored in ARCHIVE", async () => {
    const verdict = await run("keel-verify-green", await suiteStdout(200, 0));
    expect(verdict.outcome).toBe("land");
    expect(verdict.planHash).toBe(SUITE.planHash);
    const ref = /evidence sha256:([0-9a-f]{64})/.exec(verdict.evidence[0] ?? "")?.[1];
    if (ref === undefined)
      throw new Error(`no evidence cited in ${JSON.stringify(verdict.evidence)}`);
    const evidence = await env.ARCHIVE.get(
      evidenceKey(POOL_ORG, Schema.decodeUnknownSync(ContentHash)(`sha256:${ref}`)),
    );
    expect(evidence === null ? null : await evidence.json()).toMatchObject({
      outcome: "pass",
      totals: { total: 200, failed: 0 },
    });
  });

  it("bounces a red candidate, naming the failing tests", async () => {
    const verdict = await run("keel-verify-red", await suiteStdout(200, 2));
    expect(verdict.outcome).toBe("bounce");
    expect(verdict.failingTests).toEqual([
      "test/sessions.test.ts > sessions test 0",
      "test/sessions.test.ts > sessions test 1",
    ]);
    expect(verdict.evidence).toContain("failed: test/sessions.test.ts > sessions test 0");
    expect(verdict.nextActions).toEqual([
      expect.objectContaining({
        kind: "call",
        operationId: "submit",
        args: {
          failingTests: [
            "test/sessions.test.ts > sessions test 0",
            "test/sessions.test.ts > sessions test 1",
          ],
        },
      }),
    ]);
  });

  it("parks a run whose report says nothing, rather than landing it", async () => {
    const verdict = await run(
      "keel-verify-silent",
      "KEEL_SUITE/1\nKEEL_HYDRATION failed no-manifest\nKEEL_END\n",
    );
    expect(verdict.outcome).toBe("park");
  });

  it("[d21.runs-stored-plan] runs the plan stored under the job's hash: both of the worker-app pack's steps", async () => {
    const plan = await stored(workerAppPlan());
    const verdict = await runWith(
      "keel-verify-worker-app",
      {
        [SUITE_STEP]: runnerOutput(await suiteStdout(3, 0)),
        "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
      },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict.outcome).toBe("land");
    expect(verdict.planHash).toBe(plan.planHash);
    expect(
      verdict.evidence.map((e) => e.split(":")[0] ?? "").toSorted((x, y) => x.localeCompare(y)),
    ).toEqual(["js-ts.suite", "worker-app.typecheck"]);
  });

  it("[d21.guard-step] a guard step runs as its own durable step, and its proven fail bounces under block", async () => {
    const plan = await stored(guardedPlan("block"));
    const guard = plan.steps.find((s) => s.guards !== undefined);
    if (guard === undefined) throw new Error("the change is exposed to the guard");
    // What withGuards stores for a failing probe, and the report citing it.
    const resultRef = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* EvidenceStore).put(POOL_ORG, {
          stepId: guard.id,
          outcome: "fail",
          guard: { predicate: "freshness", probe: TEST_GUARD.probe },
          reason: "a revoked session is still served",
          observations: ["[probe] GET /me -> 200 (expected 401)"],
        });
      }).pipe(Effect.provide(EvidenceStoreR2(env.ARCHIVE))),
    );
    const failed = Schema.encodeSync(StoredStepReport)({
      stepId: guard.id,
      outcome: "fail",
      evidenceClass: "proof",
      tier: { tier: 1, reason: `guards freshness with its admitted probe ${TEST_GUARD.probe}` },
      durationMs: 12,
      resultRef,
    });
    const verdict = await runWith(
      "keel-verify-guarded",
      {
        [SUITE_STEP]: runnerOutput(await suiteStdout(3, 0)),
        "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
        [`guard ${guard.id}`]: JSON.stringify(failed),
      },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict.outcome).toBe("bounce");
    const cited = `${guard.id} (freshness): a revoked session is still served`;
    expect(verdict.evidence).toContain(`guard failed: ${cited}`);
    expect(verdict.nextActions).toEqual([
      expect.objectContaining({ operationId: "submit", args: { failingGuards: [cited] } }),
    ]);
  });

  it("[d21.evidence-missing-red] a fail citing evidence nobody stored still bounces, naming it, and the instance completes", async () => {
    const plan = await stored(guardedPlan("block"));
    const guard = plan.steps.find((s) => s.guards !== undefined);
    if (guard === undefined) throw new Error("the change is exposed to the guard");
    const unstored = Schema.decodeUnknownSync(ContentHash)(`sha256:${"f".repeat(64)}`);
    const failed = Schema.encodeSync(StoredStepReport)({
      stepId: guard.id,
      outcome: "fail",
      evidenceClass: "proof",
      tier: { tier: 1, reason: `guards freshness with its admitted probe ${TEST_GUARD.probe}` },
      durationMs: 12,
      resultRef: unstored,
    });
    // Were a missing document fatal, the verdict step would retry until the test times out.
    const verdict = await runWith(
      "keel-verify-evidence-missing",
      {
        [SUITE_STEP]: runnerOutput(await suiteStdout(3, 0)),
        "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
        [`guard ${guard.id}`]: JSON.stringify(failed),
      },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict.outcome).toBe("bounce");
    expect(verdict.evidence).toContain(`evidence missing: ${unstored}`);
  });

  it("[d21.plan-missing-parks] a job whose plan is not stored runs nothing and parks, completing the instance", async () => {
    const unstored = Schema.decodeUnknownSync(ContentHash)(`sha256:${"e".repeat(64)}`);
    // Were the plan not checked, the mocked runner would let a verdict land.
    const verdict = await runWith(
      "keel-verify-unknown-plan",
      { [SUITE_STEP]: runnerOutput(await suiteStdout(1, 0)) },
      keelVerifyParams(job({ planHash: unstored })),
    );
    expect(verdict).toMatchObject({
      outcome: "park",
      planHash: unstored,
      evidence: [`plan: plan ${unstored} is not in the plan store`],
      nextActions: [expect.objectContaining({ operationId: "submit" })],
    });
  });

  it("[t5.pool.job-namespace] a job that names a namespace its project is not in runs nothing: the instance ends at its namespace step", async () => {
    const id = "keel-verify-other-namespace";
    await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
    // Were the payload's namespace taken on trust, the mocked runner and record would let the instance complete.
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(await suiteStdout(1, 0)));
      await m.mockStepResult({ name: "record" }, "recorded");
    });
    const { planHash } = await stored(SUITE);
    await env.CI_WORKFLOW.create({
      id,
      params: keelVerifyParams(job({ namespace: OTHER_ORG, planHash })),
    });
    const handle = await env.CI_WORKFLOW.get(id);
    await vi.waitFor(
      async () => expect((await handle.status()).status).toMatch(/^(errored|complete)$/),
      { timeout: 15_000, interval: 50 },
    );
    // The platform reports only that a step refused to be retried; what the step says is pinned in core ([t5.no-namespace-text]).
    expect(await handle.status()).toMatchObject({
      status: "errored",
      error: { message: expect.stringContaining("NonRetryableError") },
    });
  });

  it("[t5.pool.plan-old-key] a plan kept under the key of before namespaces is never read: the job parks, naming resubmit", async () => {
    const plan = workerAppPlan();
    const hex = plan.planHash.slice("sha256:".length);
    await env.ARCHIVE.delete(planKey(POOL_ORG, plan.planHash));
    // The whole, valid plan, where an earlier deploy kept it.
    await env.ARCHIVE.put(`plans/${hex}`, Result.getOrThrow(storedPlanText(plan)));
    // Were the old key read, the mocked runners would let a verdict land.
    const verdict = await runWith(
      "keel-verify-old-key-plan",
      {
        [SUITE_STEP]: runnerOutput(await suiteStdout(1, 0)),
        "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
      },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict).toMatchObject({
      outcome: "park",
      planHash: plan.planHash,
      evidence: [`plan: plan ${plan.planHash} is not in the plan store`],
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });

  it("[d21.plan-corrupt-parks] a plan stored under another plan's hash is never run: it parks", async () => {
    const plan = workerAppPlan();
    const other = Result.getOrThrow(storedPlanText(SUITE));
    await env.ARCHIVE.put(planKey(POOL_ORG, plan.planHash), other);
    const verdict = await runWith(
      "keel-verify-corrupt-plan",
      { [SUITE_STEP]: runnerOutput(await suiteStdout(1, 0)) },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict.outcome).toBe("park");
    expect(verdict.evidence[0]).toContain("stored corrupt");
  });
});
