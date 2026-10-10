import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { BatchId, CandidateId, ContentHash } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type KeelVerifyJob, keelVerifyParams } from "../../src/rpc/index.ts";
import { suiteStdout } from "../support-suite-stdout.ts";

const SettledShape = Schema.Struct({
  outcome: Schema.String,
  planHash: Schema.String,
  evidence: Schema.Array(Schema.String),
  failingTests: Schema.Array(Schema.String),
});

const job = (overrides: Partial<KeelVerifyJob> = {}): KeelVerifyJob => ({
  jobId: "job-pool",
  laneId: "lane:prj:default",
  candidateId: Schema.decodeUnknownSync(CandidateId)("cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"d".repeat(64)}`),
  fence: {
    batchId: Schema.decodeUnknownSync(BatchId)("bat_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
    attempt: 1,
    chainEpoch: 0,
  },
  planHash: L1_SUITE_PLAN.planHash,
  ...overrides,
});

/** What the engine's runner step persists: its logs, as the suite command printed them. */
const runnerOutput = (stdout: string) => ({
  exitCode: 0,
  logs: { stdout, stderr: "" },
  snapshot: { id: "snap", dir: "/workspace", localBucket: true },
});

const run = async (id: string, stdout: string, params = keelVerifyParams(job())) => {
  await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
  await instance.modify(async (m) => {
    await m.mockStepResult({ name: L1_SUITE_PLAN.steps[0]?.id ?? "" }, runnerOutput(stdout));
    await m.mockStepResult({ name: "record" }, "recorded");
  });
  await env.CI_WORKFLOW.create({ id, params });
  const verdict = await instance.waitForStepResult({ name: "verdict" });
  await instance.waitForStatus("complete");
  return Schema.decodeUnknownSync(SettledShape)(verdict);
};

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
    expect(verdict.planHash).toBe(L1_SUITE_PLAN.planHash);
    const ref = /evidence sha256:([0-9a-f]{64})/.exec(verdict.evidence[0] ?? "")?.[1];
    if (ref === undefined)
      throw new Error(`no evidence cited in ${JSON.stringify(verdict.evidence)}`);
    const stored = await env.ARCHIVE.get(`evidence/${ref}`);
    expect(stored === null ? null : await stored.json()).toMatchObject({
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
  });

  it("parks a run whose report says nothing, rather than landing it", async () => {
    const verdict = await run(
      "keel-verify-silent",
      "KEEL_SUITE/1\nKEEL_HYDRATION failed no-manifest\nKEEL_END\n",
    );
    expect(verdict.outcome).toBe("park");
  });

  it("[keel-verify.plan-fenced] refuses a plan it does not know, before any runner starts", async () => {
    // Were the plan not checked, the mocked runner and record would let this
    // instance complete; it must instead error, at the plan step.
    const id = "keel-verify-unknown-plan";
    await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: L1_SUITE_PLAN.steps[0]?.id ?? "" },
        runnerOutput(await suiteStdout(1, 0)),
      );
      await m.mockStepResult({ name: "record" }, "recorded");
    });
    await env.CI_WORKFLOW.create({
      id,
      params: keelVerifyParams(
        job({ planHash: Schema.decodeUnknownSync(ContentHash)(`sha256:${"e".repeat(64)}`) }),
      ),
    });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toContain("NonRetryableError");
  });
});
