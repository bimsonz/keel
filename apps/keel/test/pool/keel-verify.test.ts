import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  JS_TS_SUITE_PACK,
  parseFlow,
  SettledVerdict,
  StoredStepReport,
  storedPlanText,
} from "@keeltown/core/application/verification";
import { compile, type FlowPlan } from "@keeltown/core/domain/verification";
import { BatchId, CandidateId, ContentHash, makeId } from "@keeltown/core/kernel";
import { EvidenceStore, PlanStore } from "@keeltown/core/ports";
import {
  guardedPlan,
  suitePlan,
  TEST_DECISION,
  TEST_GUARD,
  workerAppPlan,
} from "@keeltown/testing";
import { Effect, Result, Schema } from "effect";
import { ulid } from "ulid";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { evidenceKey, EvidenceStoreR2 } from "../../src/adapters/driven/r2/evidence-store.ts";
import { PlanStoreR2, planKey } from "../../src/adapters/driven/r2/plan-store.ts";
import { type KeelVerifyJob, keelVerifyParams } from "../../src/rpc/index.ts";
import { commandStdout, suiteStdout, typecheckStdout } from "../support-suite-stdout.ts";
import { bundled, mockDepsReady } from "./deps-ready.ts";
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
    await mockDepsReady(m);
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

  it("[s2.bounce-cites] a guard that holds a decision bounces under advise, its fail citing the decision and pointing to it", async () => {
    const plan = await stored(guardedPlan("advise", TEST_DECISION));
    const guard = plan.steps.find((s) => s.guards !== undefined);
    if (guard === undefined) throw new Error("the change is exposed to the guard");
    expect(guard.guards).toMatchObject({ policy: "block", decision: TEST_DECISION });
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
      "keel-verify-decided",
      {
        [SUITE_STEP]: runnerOutput(await suiteStdout(3, 0)),
        "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
        [`guard ${guard.id}`]: JSON.stringify(failed),
      },
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect(verdict.outcome).toBe("bounce");
    const cited = `${guard.id} (freshness): a revoked session is still served; it holds decision ${TEST_DECISION.id}: The premise holds`;
    expect(verdict.evidence).toContain(`guard failed: ${cited}`);
    expect(verdict.nextActions).toEqual([
      expect.objectContaining({ operationId: "submit", args: { failingGuards: [cited] } }),
      {
        kind: "call",
        title: `Read decision ${TEST_DECISION.id}, which the failed guard holds: The premise holds`,
        operationId: "Memory_getDecision",
        args: { decisionId: TEST_DECISION.id },
      },
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

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const PACKAGE_JSON = '{"name":"candidate"}\n';
const LOCK_YAML = "lockfileVersion: '9.0'\n";

/**
 * Runs a job with both deps steps real: `deps-need` reads the bundle from
 * BUNDLES and `deps:<install>` asks the pool's keel-verify over the VERIFIER
 * binding. The suite's runner step is mocked only when a stdout is given, so
 * a job whose deps are not ready completes only if no runner was asked.
 */
const runDeps = async (id: string, bundle: ContentHash, stdout?: string) => {
  await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
  await instance.modify(async (m) => {
    if (stdout !== undefined) await m.mockStepResult({ name: SUITE_STEP }, runnerOutput(stdout));
    await m.mockStepResult({ name: "record" }, "recorded");
  });
  await env.CI_WORKFLOW.create({
    id,
    params: keelVerifyParams(job({ bundle, planHash: (await stored(SUITE)).planHash })),
  });
  const need: unknown = JSON.parse(String(await instance.waitForStepResult({ name: "deps-need" })));
  const install = Schema.decodeUnknownOption(Schema.Struct({ install: Schema.String }))(need);
  const built: unknown =
    install._tag === "None"
      ? undefined
      : JSON.parse(
          String(await instance.waitForStepResult({ name: `deps:${install.value.install}` })),
        );
  const verdict = await instance.waitForStepResult({ name: "verdict" });
  await instance.waitForStatus("complete");
  return {
    need,
    built,
    verdict: Schema.decodeUnknownSync(SettledVerdict)(JSON.parse(String(verdict))),
  };
};

/**
 * A project's own flow: one step, a command of its own, on code only. Compiled
 * for a change at the suite plan's base, as Precheck compiles it.
 */
const OWN_FLOW = JSON.stringify({
  flow: { _tag: "step", step: "keel.check" },
  steps: [
    {
      id: "keel.check",
      kind: "deterministic",
      evidenceCeiling: "proof",
      outcomes: ["pass", "fail", "abstain"],
      budget: { usd: 0.05, cpuMs: 300_000, tokens: 0 },
      appliesTo: { paths: ["src/**"], subjects: [] },
      run: { command: "pnpm gen && pnpm test" },
    },
  ],
});
const ownPlan = (touchedPaths: readonly string[]): FlowPlan =>
  Result.getOrThrow(
    compile(
      Result.getOrThrow(parseFlow(OWN_FLOW, SUITE.baseCommit)).definition,
      { baseCommit: SUITE.baseCommit, touchedPaths, subjects: [], facts: {} },
      JS_TS_SUITE_PACK,
    ),
  );

describe("KeelVerify on a project's own flow", () => {
  it("[pilot.pool.no-step] a plan with no step (a docs-only change the flow prunes) lands under its hash, citing nothing and asking no runner", async () => {
    const plan = await stored(ownPlan(["docs/guide.md"]));
    expect(plan.steps).toEqual([]);
    // No runner step is mocked: a step that asked one could never answer in the pool.
    const verdict = await runWith(
      "keel-verify-no-step",
      {},
      keelVerifyParams(job({ planHash: plan.planHash })),
    );
    expect([verdict.outcome, verdict.planHash, verdict.evidence]).toEqual([
      "land",
      plan.planHash,
      [],
    ]);
  });

  it("[pilot.pool.own-command] the step's own command, read from the stored plan, lands on exit 0 and bounces on exit 1 citing the exit and the tail", async () => {
    const plan = await stored(ownPlan(["src/a.ts"]));
    expect(plan.steps.map((s) => [s.id, s.run])).toEqual([
      ["keel.check", { command: "pnpm gen && pnpm test", timeoutMs: 240_000 }],
    ]);
    const params = keelVerifyParams(job({ planHash: plan.planHash }));
    const green = await runWith(
      "keel-verify-own-green",
      { "keel.check": runnerOutput(commandStdout(0, "Tests 12 passed\n")) },
      params,
    );
    expect(green.outcome).toBe("land");
    expect(green.evidence[0]).toMatch(/^keel\.check: pass /);
    expect(await storedEvidence(green)).toMatchObject({
      outcome: "pass",
      why: "the command exited 0",
      exit: 0,
    });
    const red = await runWith(
      "keel-verify-own-red",
      { "keel.check": runnerOutput(commandStdout(1, "FAIL test/a.test.ts > adds\n")) },
      params,
    );
    expect(red.outcome).toBe("bounce");
    expect(red.evidence[0]).toMatch(/^keel\.check: fail /);
    expect(await storedEvidence(red)).toMatchObject({
      outcome: "fail",
      why: "the command exited 1",
      exit: 1,
      tail: "FAIL test/a.test.ts > adds\n",
    });
  });
});

/** What the suite step stored for a verdict that cites its evidence first. */
const storedEvidence = async (verdict: SettledVerdict): Promise<unknown> => {
  const ref = /evidence sha256:([0-9a-f]{64})/.exec(verdict.evidence[0] ?? "")?.[1];
  if (ref === undefined)
    throw new Error(`no evidence cited in ${JSON.stringify(verdict.evidence)}`);
  const evidence = await env.ARCHIVE.get(
    evidenceKey(POOL_ORG, Schema.decodeUnknownSync(ContentHash)(`sha256:${ref}`)),
  );
  return evidence === null ? null : await evidence.json();
};

/**
 * The deps steps through the real Workflow: the candidate's bundle read from
 * BUNDLES, and the build asked of the pool's keel-verify, which answers by
 * what the candidate holds (apps/keel/vitest.config.ts).
 */
describe("KeelVerify ensuring a candidate's deps", () => {
  it("[deps.pool.steps] reads the need from the candidate's bundle, keeps keel-verify's answer under the install digest, and only then runs the suite", async () => {
    const bundle = await bundled({ "package.json": PACKAGE_JSON, "pnpm-lock.yaml": LOCK_YAML });
    const ran = await runDeps("keel-verify-deps-ready", bundle, await suiteStdout(200, 0));
    const inputs = `keel.install/1\n${await sha256(PACKAGE_JSON)}  package.json\n${await sha256(LOCK_YAML)}  pnpm-lock.yaml\n`;
    const install = await sha256(inputs);
    expect(ran.need).toEqual({ _tag: "Locked", install, inputs });
    expect(ran.built).toEqual({
      _tag: "DepsReady",
      install,
      parts: [{ sha256: "7".repeat(64), bytes: 4321 }],
    });
    expect(ran.verdict.outcome).toBe("land");
  });

  it("[deps.pool.steps-unavailable] unavailable deps ask no runner and park the candidate, the step storing why", async () => {
    const bundle = await bundled({
      "package.json": PACKAGE_JSON,
      "pnpm-lock.yaml": LOCK_YAML,
      "unavailable/package.json": PACKAGE_JSON,
    });
    const ran = await runDeps("keel-verify-deps-unavailable", bundle);
    expect(ran.built).toEqual({ _tag: "DepsUnavailable", reason: "upload-failed" });
    expect(ran.verdict.outcome).toBe("park");
    expect(ran.verdict.nextActions).toEqual([]);
    expect(await storedEvidence(ran.verdict)).toEqual({
      stepId: SUITE_STEP,
      outcome: "abstain",
      why: "deps-unavailable: upload-failed",
      tail: "",
    });
  });

  it("[deps.pool.steps-refused] refused deps ask no runner and bounce the candidate on its first round, citing the refusal once with what to do", async () => {
    const bundle = await bundled({
      "package.json": PACKAGE_JSON,
      "pnpm-lock.yaml": LOCK_YAML,
      "refused/package.json": PACKAGE_JSON,
    });
    const ran = await runDeps("keel-verify-deps-refused", bundle);
    const reason = "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE";
    const cited = `${reason}: the installer refused the lockfile (ERR_PNPM_OUTDATED_LOCKFILE): run pnpm install and commit the pnpm-lock.yaml it writes`;
    expect(ran.built).toEqual({ _tag: "DepsRefused", reason });
    expect(ran.verdict.outcome).toBe("bounce");
    expect(ran.verdict.evidence.filter((line) => line.includes("refused"))).toEqual([
      `dependencies refused: ${cited}`,
    ]);
    expect(ran.verdict.nextActions).toEqual([
      expect.objectContaining({
        kind: "call",
        operationId: "submit",
        args: { depsRefused: [cited] },
      }),
    ]);
  });

  it("[deps.pool.steps-unlocked] a candidate with no lockfile bounces without a build: keel-verify is never asked", async () => {
    const bundle = await bundled({ "package.json": PACKAGE_JSON });
    const ran = await runDeps("keel-verify-deps-unlocked", bundle);
    expect(ran.need).toEqual({
      _tag: "Unlocked",
      reason: "no-lockfile: the candidate has no pnpm-lock.yaml at its root",
    });
    expect(ran.built).toBeUndefined();
    expect(ran.verdict.outcome).toBe("bounce");
    expect(ran.verdict.evidence).toContain(
      "dependencies refused: no-lockfile: the candidate has no pnpm-lock.yaml at its root: commit a pnpm-lock.yaml at the repository's root (run pnpm install): dependencies are installed only from a frozen lockfile",
    );
  });

  it("[deps.pool.steps-unread] a candidate whose bundle is not kept for the job's namespace parks, saying which bundle", async () => {
    const bundle = Schema.decodeUnknownSync(ContentHash)(`sha256:${"e".repeat(64)}`);
    const ran = await runDeps("keel-verify-deps-unread", bundle);
    const reason = `bundle-missing: the candidate bundle ${bundle} is not kept for ${POOL_ORG}`;
    expect(ran.need).toEqual({ _tag: "NeedUnread", reason });
    expect(ran.built).toBeUndefined();
    expect(ran.verdict.outcome).toBe("park");
    expect(await storedEvidence(ran.verdict)).toMatchObject({
      outcome: "abstain",
      why: `deps-unavailable: ${reason}`,
    });
  });
});
