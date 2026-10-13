// Starting KeelVerify through the Workflow binding: one instance per id, the
// job encoded as KeelVerify's params.
import { describe, expect, it } from "@effect/vitest";
import { ContentHash, makeId } from "@keeltown/core/kernel";
import { BatchVerification, type VerificationJob } from "@keeltown/core/ports";
import { sampleNamespace } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import {
  BatchVerificationWorkflow,
  type WorkflowStarts,
} from "../../src/adapters/driven/workflow/batch-verification.ts";
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

/** A Workflow binding that holds instances by id, as the platform does, and records each create. */
function workflow() {
  const created: Array<{ id: string; params: unknown }> = [];
  const binding: WorkflowStarts = {
    get: async (id: string) => {
      if (!created.some((c) => c.id === id)) throw new Error(`instance.not_found: ${id}`);
      return { id };
    },
    create: async (options: { id: string; params: unknown }) => {
      if (created.some((c) => c.id === options.id)) throw new Error("instance.already_exists");
      created.push(options);
      return { id: options.id };
    },
  };
  return { created, binding };
}

describe("BatchVerification over the Workflow binding", () => {
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
      }).pipe(Effect.provide(BatchVerificationWorkflow(wf.binding)));
    },
  );
});
