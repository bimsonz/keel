// KeelVerify through the Workflow binding: one instance per id, the job
// encoded as KeelVerify's params; how an instance stands, read in Keel's
// terms; and stopping one that still runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { ContentHash, makeId } from "@keeltown/core/kernel";
import { BatchVerification, type VerificationJob } from "@keeltown/core/ports";
import { sampleNamespace } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import {
  BatchVerificationWorkflow,
  INSTANCE_ERROR_MAX,
  type Tier2Boxes,
  type WorkflowRun,
  type WorkflowStarts,
} from "../../src/adapters/driven/workflow/batch-verification.ts";
import { TIER2_BOX_CAP } from "../../src/adapters/driving/do/boxgate-leases.ts";
import { keelVerifyParams } from "../../src/rpc/keel-verify.ts";

const hash = (c: string) => Schema.decodeUnknownSync(ContentHash)(`sha256:${c.repeat(64)}`);
const JOB: VerificationJob = {
  projectId: makeId("prj", "01JA0000000000000000000000"),
  namespace: sampleNamespace,
  jobId: "job-1",
  laneId: "lane:prj_01JA0000000000000000000000:main",
  candidateId: makeId("cnd", "01JA0000000000000000000001"),
  bundle: hash("b"),
  fence: { batchId: makeId("bat", "01JA0000000000000000000002"), attempt: 1, chainEpoch: 0 },
  planHash: hash("c"),
};

type Status = Awaited<ReturnType<WorkflowRun["status"]>>;

/** A Tier 2 gate with 12 boxes free. */
const BOXES: Tier2Boxes = { free: async () => 12 };

/**
 * A Workflow binding that holds instances by id, as the platform does, and
 * records each create and each terminate. An instance reads as running until
 * `statuses` says otherwise, and a terminated one reads as terminated.
 */
function workflow() {
  const created: Array<{ id: string; params: unknown }> = [];
  const statuses = new Map<string, Status>();
  const terminated: string[] = [];
  const binding: WorkflowStarts = {
    get: async (id: string) => {
      if (!created.some((c) => c.id === id)) throw new Error(`instance.not_found: ${id}`);
      return {
        status: async () => statuses.get(id) ?? { status: "running" },
        terminate: async () => {
          terminated.push(id);
          statuses.set(id, { status: "terminated", error: null });
        },
      };
    },
    create: async (options: { id: string; params: unknown }) => {
      if (created.some((c) => c.id === options.id)) throw new Error("instance.already_exists");
      created.push(options);
      return { id: options.id };
    },
  };
  return { created, statuses, terminated, binding };
}

describe("BatchVerification over the Workflow binding", () => {
  it.effect(
    "[capacity.free] answers the Tier 2 gate's free boxes, and none when the gate does not answer",
    () =>
      Effect.gen(function* () {
        const wf = workflow();
        const read = (boxes: Tier2Boxes) =>
          Effect.flatMap(BatchVerification, (v) => v.capacity()).pipe(
            Effect.provide(BatchVerificationWorkflow(wf.binding, boxes)),
          );
        expect(yield* read(BOXES)).toEqual({ free: 12 });
        expect(
          yield* read({
            free: async () => {
              throw new Error("the gate is away");
            },
          }),
        ).toEqual({ free: 0 });
      }),
  );

  it("[capacity.cap-matches] the Tier 2 gate's limit is KeelSandbox's max_instances in keel-verify's config", () => {
    const config = readFileSync(
      fileURLToPath(new URL("../../../keel-verify/wrangler.jsonc", import.meta.url)),
      "utf8",
    );
    const sandbox = /"class_name":\s*"KeelSandbox",[^}]*?"max_instances":\s*(\d+)/.exec(config);
    expect(Number(sandbox?.[1])).toBe(TIER2_BOX_CAP);
  });

  it.effect(
    "[verification.start] creates one KeelVerify instance per id with the job as its params; starting again starts nothing",
    () => {
      const wf = workflow();
      return Effect.gen(function* () {
        const verification = yield* BatchVerification;
        yield* verification.start("keel-verify-evt-1", JOB);
        yield* verification.start("keel-verify-evt-1", JOB);
        yield* verification.start("keel-verify-evt-2", JOB);
        expect(wf.created).toEqual([
          { id: "keel-verify-evt-1", params: keelVerifyParams(JOB) },
          { id: "keel-verify-evt-2", params: keelVerifyParams(JOB) },
        ]);
      }).pipe(Effect.provide(BatchVerificationWorkflow(wf.binding, BOXES)));
    },
  );

  it.effect(
    "[verification.standing] every state that may still end in a verdict reads as Running, a completed one as Completed, and an errored, terminated, unnamed or never-made one as Failed",
    () => {
      const wf = workflow();
      return Effect.gen(function* () {
        const verification = yield* BatchVerification;
        yield* verification.start("keel-verify-evt-1", JOB);
        for (const status of [
          "queued",
          "running",
          "paused",
          "waiting",
          "waitingForPause",
          "rollingBack",
        ]) {
          wf.statuses.set("keel-verify-evt-1", { status });
          expect(yield* verification.standing("keel-verify-evt-1")).toEqual({ _tag: "Running" });
        }
        wf.statuses.set("keel-verify-evt-1", { status: "complete", error: null });
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({ _tag: "Completed" });
        wf.statuses.set("keel-verify-evt-1", {
          status: "errored",
          error: { name: "Error", message: "NonRetryableError: not a KeelVerify job" },
        });
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({
          _tag: "Failed",
          status: "errored",
          error: "NonRetryableError: not a KeelVerify job",
        });
        wf.statuses.set("keel-verify-evt-1", { status: "errored", error: null });
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({
          _tag: "Failed",
          status: "errored",
        });
        wf.statuses.set("keel-verify-evt-1", { status: "terminated", error: null });
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({
          _tag: "Failed",
          status: "terminated",
        });
        wf.statuses.set("keel-verify-evt-1", { status: "unknown" });
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({
          _tag: "Failed",
          status: "unknown",
        });
        expect(yield* verification.standing("keel-verify-never-made")).toEqual({
          _tag: "Failed",
          status: "missing",
        });
      }).pipe(Effect.provide(BatchVerificationWorkflow(wf.binding, BOXES)));
    },
  );

  it.effect(
    "[verification.standing-redacted] an instance's error message is cited without the Artifacts remote and token it held, and no longer than 200 characters",
    () => {
      const wf = workflow();
      const remote =
        "https://acct0123456789abcdef.artifacts.cloudflare.net/git/keel-core/trunk.git";
      const token = "art_v1_0123456789abcdefABCDEF";
      return Effect.gen(function* () {
        const verification = yield* BatchVerification;
        yield* verification.start("keel-verify-evt-1", JOB);
        wf.statuses.set("keel-verify-evt-1", {
          status: "errored",
          error: {
            name: "Error",
            message: `fetch ${remote} with ${token} failed: ${"x".repeat(400)}`,
          },
        });
        const standing = yield* verification.standing("keel-verify-evt-1");
        if (standing._tag !== "Failed" || standing.error === undefined)
          throw new Error("an errored instance reads as Failed with its message");
        expect(standing.error).toMatch(/^fetch .* failed: x+$/);
        expect(standing.error).not.toContain("artifacts.cloudflare.net");
        expect(standing.error).not.toContain("acct0123456789abcdef");
        expect(standing.error).not.toContain(token);
        expect(INSTANCE_ERROR_MAX).toBe(200);
        expect(standing.error).toHaveLength(200);
      }).pipe(Effect.provide(BatchVerificationWorkflow(wf.binding, BOXES)));
    },
  );

  it.effect(
    "[verification.stop] stopping terminates an instance that still runs, and does nothing to one that ended or was never made",
    () => {
      const wf = workflow();
      return Effect.gen(function* () {
        const verification = yield* BatchVerification;
        yield* verification.start("keel-verify-evt-1", JOB);
        yield* verification.start("keel-verify-evt-2", JOB);
        wf.statuses.set("keel-verify-evt-2", { status: "complete", error: null });
        yield* verification.stop("keel-verify-evt-2");
        yield* verification.stop("keel-verify-never-made");
        expect(wf.terminated).toEqual([]);
        yield* verification.stop("keel-verify-evt-1");
        yield* verification.stop("keel-verify-evt-1");
        expect(wf.terminated).toEqual(["keel-verify-evt-1"]);
        expect(yield* verification.standing("keel-verify-evt-1")).toEqual({
          _tag: "Failed",
          status: "terminated",
        });
      }).pipe(Effect.provide(BatchVerificationWorkflow(wf.binding, BOXES)));
    },
  );
});
