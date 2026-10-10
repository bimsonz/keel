import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, RunnerMessage, StepFinished } from "../src/index.ts";

const fence = { batchId: "bat_1", attempt: 1, chainEpoch: 7 };
const hash = `sha256:${"ab".repeat(32)}`;

const messages = [
  {
    _tag: "JobSubmitted",
    protocol: PROTOCOL_VERSION,
    jobId: "job-1",
    attempt: 1,
    fence,
    bundle: { hash, r2Key: "bundles/job-1" },
    steps: [
      {
        stepId: "s1",
        kind: "probe",
        runs: hash,
        world: "AB",
        tier: 1,
        tierReason: "worker-native tests",
        outcomes: ["pass", "fail", "abstain"],
      },
    ],
    budget: { cpuMs: 30_000, wallMs: 60_000, subrequests: 0 },
  },
  { _tag: "StepStarted", protocol: PROTOCOL_VERSION, jobId: "job-1", fence, stepId: "s1", tier: 1 },
  {
    _tag: "StepLogChunk",
    protocol: PROTOCOL_VERSION,
    jobId: "job-1",
    stepId: "s1",
    seq: 0,
    r2Key: "logs/job-1/s1/0",
  },
  {
    _tag: "StepFinished",
    protocol: PROTOCOL_VERSION,
    jobId: "job-1",
    fence,
    stepId: "s1",
    outcome: "abstain",
    evidenceClass: "proof",
    tier: 1,
    tierReason: "worker-native tests",
    durationMs: 12.5,
  },
  {
    _tag: "EscalationRequested",
    protocol: PROTOCOL_VERSION,
    jobId: "job-1",
    fence,
    stepId: "s1",
    from: 1,
    to: 2,
    reason: "exit 127: cargo not found",
  },
  { _tag: "JobFinished", protocol: PROTOCOL_VERSION, jobId: "job-1", fence, outcome: "completed" },
  {
    _tag: "JobCancelled",
    protocol: PROTOCOL_VERSION,
    jobId: "job-1",
    fence,
    reason: "superseded attempt",
  },
];

const codec = Schema.toCodecJson(RunnerMessage);

describe("runner protocol v0", () => {
  it.each(messages.map((m) => [m._tag, m] as const))(
    "round-trips %s through JSON",
    (_tag, message) => {
      const decoded = Schema.decodeUnknownSync(codec)(message);
      const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(decoded)));
      expect(wire).toEqual(message);
    },
  );

  it("refuses a message from another protocol version", () => {
    expect(() =>
      Schema.decodeUnknownSync(codec)({ ...messages[5], protocol: "keel-runner/1" }),
    ).toThrow(/keel-runner/);
  });

  it("refuses a step outcome outside the declared set", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(StepFinished));
    expect(() => decode({ ...messages[3], outcome: "maybe" })).toThrow(/outcome/);
  });
});
