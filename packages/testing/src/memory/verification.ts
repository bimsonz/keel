import { CommitSha, type EscalationId, type GuardId, makeId } from "@keeltown/core/kernel";
import {
  FlowSpecInvalid,
  ModelAbstained,
  type FlowSpec,
  type StepResult,
  type VerificationJob,
} from "@keeltown/core/domain/verification";
import {
  type DecisionRequest,
  type DecisionResponse,
  DecisionModel,
  FlowSpecSource,
  GuardRepo,
  type GuardFile,
  HumanGate,
  type PlatformFunctionCall,
  PlatformFunction,
  type Ruling,
  VerifierRuntime,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

/**
 * A scripted decision model. Without a script every question is answered
 * `unclear` with certainty, which is the safe answer: opinion that routes
 * nothing.
 */
export function makeDecisionModelMemory(
  script?: (request: DecisionRequest) => DecisionResponse | "abstain",
) {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    layer: Layer.succeed(
      DecisionModel,
      DecisionModel.of({
        ask: (request) =>
          Effect.suspend(() => {
            asked.push(request);
            const answer = script?.(request) ?? {
              model: "scripted",
              answers: request.questions.map((q) => ({
                questionId: q.id,
                probabilities: { unclear: 1 },
              })),
            };
            return answer === "abstain"
              ? Effect.fail(new ModelAbstained({ reason: "unavailable" }))
              : Effect.succeed(answer);
          }),
      }),
    ),
  };
}

export function makePlatformFunctionMemory(responses: Readonly<Record<string, unknown>> = {}) {
  const calls: PlatformFunctionCall[] = [];
  return {
    calls,
    layer: Layer.succeed(
      PlatformFunction,
      PlatformFunction.of({
        call: (call) =>
          Effect.suspend(() => {
            calls.push(call);
            return call.name in responses
              ? Effect.succeed(responses[call.name])
              : Effect.fail(new ModelAbstained({ reason: "unavailable" }));
          }),
      }),
    ),
  };
}

/** Every step passes at Tier 0 unless `outcome` says otherwise. */
export function makeVerifierRuntimeMemory(
  outcome?: (step: VerificationJob["steps"][number]) => StepResult["outcome"],
) {
  const jobs: VerificationJob[] = [];
  return {
    jobs,
    layer: Layer.succeed(
      VerifierRuntime,
      VerifierRuntime.of({
        run: (job) =>
          Effect.sync(() => {
            jobs.push(job);
            return job.steps.map((step) => ({
              stepId: step.id,
              outcome: outcome?.(step) ?? "pass",
              evidenceClass: step.evidenceCeiling,
              tier: step.tier,
              durationMs: 0,
            }));
          }),
      }),
    ),
  };
}

export function makeFlowSpecSourceMemory(specs: ReadonlyMap<string, FlowSpec> = new Map()) {
  return {
    layer: Layer.succeed(
      FlowSpecSource,
      FlowSpecSource.of({
        read: (projectId, base) => {
          const spec = specs.get(`${projectId}@${base}`);
          return spec === undefined
            ? Effect.fail(new FlowSpecInvalid({ reason: "no flow spec at the base commit" }))
            : Effect.succeed(spec);
        },
      }),
    ),
  };
}

/** A deterministic 40-hex commit id per admission. */
const guardCommit = (n: number): string => n.toString(16).padStart(40, "0");

export function makeGuardRepoMemory() {
  const guards = new Map<string, GuardFile[]>();
  return {
    guards,
    layer: Layer.succeed(
      GuardRepo,
      GuardRepo.of({
        list: (projectId) => Effect.sync(() => guards.get(projectId) ?? []),
        admit: (projectId, guardId: GuardId, files) =>
          Effect.sync(() => {
            const existing = guards.get(projectId) ?? [];
            guards.set(projectId, [
              ...existing,
              ...[...files.keys()].map((path) => ({ guardId, path })),
            ]);
            return Schema.decodeUnknownSync(CommitSha)(
              guardCommit(guards.get(projectId)?.length ?? 0),
            );
          }),
      }),
    ),
  };
}

/** Escalations wait for `rule` to be called; `awaitRuling` resolves when it is. */
export function makeHumanGateMemory() {
  const raised: { readonly escalationId: EscalationId; readonly question: string }[] = [];
  const waiting = new Map<EscalationId, (ruling: Ruling) => void>();
  const ruled = new Map<EscalationId, Ruling>();
  let counter = 0;
  return {
    raised,
    rule: (escalationId: EscalationId, option: string, by = "test") => {
      const ruling = { escalationId, option, by };
      ruled.set(escalationId, ruling);
      waiting.get(escalationId)?.(ruling);
    },
    layer: Layer.succeed(
      HumanGate,
      HumanGate.of({
        raise: (request) =>
          Effect.sync(() => {
            counter += 1;
            const escalationId = makeId("esc", counter.toString().padStart(26, "0"));
            raised.push({ escalationId, question: request.question });
            return escalationId;
          }),
        awaitRuling: (escalationId) =>
          Effect.callback<Ruling>((resume) => {
            const already = ruled.get(escalationId);
            if (already !== undefined) resume(Effect.succeed(already));
            else waiting.set(escalationId, (ruling) => resume(Effect.succeed(ruling)));
          }),
      }),
    ),
  };
}
