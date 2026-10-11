import {
  type CandidateId,
  type ChangeId,
  CommitSha,
  type EscalationId,
  type GuardId,
  makeId,
  type VerdictId,
} from "@keeltown/core/kernel";
import {
  ChangeNotFound,
  type ChangeState,
  ChangeStateRefused,
} from "@keeltown/core/domain/coordination";
import { CandidateNotFound, ResultFenced } from "@keeltown/core/domain/integration";
import {
  ModelAbstained,
  type StepResult,
  type VerificationJob,
} from "@keeltown/core/domain/verification";
import {
  type BatchVerdict,
  BatchVerdicts,
  ChangePrecheck,
  commit,
  type DecisionRequest,
  type Transition,
  type DecisionResponse,
  DecisionModel,
  FlowSpecSource,
  GuardRepo,
  type GuardFile,
  HumanGate,
  ObjectNotFound,
  type PlatformFunctionCall,
  PlatformFunction,
  type PrecheckCall,
  type PrecheckWorkspace,
  type Ruling,
  VerifierRuntime,
} from "@keeltown/core/ports";
import { Effect, Layer, Result, Schema } from "effect";
import type { FlowSpecSourceHarness } from "../contracts/verification.ts";
import { makeEventOutboxMemory } from "./event-outbox.ts";
import { makeClockMemory } from "./identity.ts";

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

/**
 * FlowSpecSource over commits held in memory: `commit` files a set of paths
 * under a fresh repo and commit id, and `read` answers them as the CodeHost
 * adapter would read them from a tree.
 */
export function makeFlowSpecSourceMemory(): FlowSpecSourceHarness {
  const commits = new Map<string, Readonly<Record<string, string>>>();
  let n = 0;
  return {
    layer: Layer.succeed(
      FlowSpecSource,
      FlowSpecSource.of({
        read: (repo, base) => {
          const files = commits.get(`${repo.namespace}/${repo.name}@${base}`);
          if (files === undefined) return Effect.fail(new ObjectNotFound({ repo, oid: base }));
          const paths = Object.keys(files);
          return Effect.succeed({
            rootPaths: [...new Set(paths.map((p) => p.split("/")[0] ?? p))],
            ...(files[".keel/flow.json"] === undefined
              ? {}
              : { flowJson: files[".keel/flow.json"] }),
            ...(files["package.json"] === undefined ? {} : { packageJson: files["package.json"] }),
          });
        },
      }),
    ),
    commit: (files) =>
      Effect.sync(() => {
        n += 1;
        const repo = { namespace: "memory", name: `flow-${n}` };
        const base = CommitSha.make(n.toString(16).padStart(40, "0"));
        commits.set(`${repo.namespace}/${repo.name}@${base}`, files);
        return { repo, base };
      }),
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

/** A batch as the in-memory lane knows it: its members, its candidate, and the attempt and epoch results are fenced on. */
export interface LaneBatch {
  readonly members: readonly ChangeId[];
  readonly candidateId: CandidateId;
  readonly attempt: number;
  readonly chainEpoch: number;
}

/**
 * The lane side of `BatchVerdicts`, in memory: what the Lane DO's
 * `recordVerdict` does, so KeelVerify can be driven before it exists. One
 * commit per instance (cause `<instanceId>:recordVerdict`) appends
 * VerdictIssued and BatchVerified for a land, or BatchFailed otherwise. A
 * failure is attributed as the lane does at L1: a batch of one to its change,
 * a larger one `unattributed`; a verdict that is not a bounce (an abstaining
 * runner parks) is `infra`, which requeues without blame.
 */
export function makeBatchVerdictsMemory(batches: ReadonlyMap<string, LaneBatch> = new Map()) {
  const outbox = makeEventOutboxMemory();
  const clock = makeClockMemory();
  const recorded: { laneId: string; verdict: BatchVerdict }[] = [];
  const record = (laneId: string, v: BatchVerdict) =>
    commit(
      { entity: { kind: "batch", id: v.fence.batchId }, cause: `${v.instanceId}:recordVerdict` },
      (): Result.Result<Transition<undefined>, CandidateNotFound | ResultFenced> => {
        const batch = batches.get(v.fence.batchId);
        if (batch === undefined || batch.candidateId !== v.candidateId)
          return Result.fail(new CandidateNotFound({ candidateId: v.candidateId }));
        if (batch.attempt !== v.fence.attempt || batch.chainEpoch !== v.fence.chainEpoch)
          return Result.fail(new ResultFenced(v.fence));
        recorded.push({ laneId, verdict: v });
        const issued = {
          _tag: "VerdictIssued",
          verdictId: v.verdictId,
          subject: v.fence.batchId,
          outcome: v.outcome,
          evidence: [...v.evidence],
          planHash: v.planHash,
        };
        const settled =
          v.outcome === "land"
            ? {
                _tag: "BatchVerified",
                batchId: v.fence.batchId,
                candidateId: v.candidateId,
                verdictId: v.verdictId,
              }
            : {
                _tag: "BatchFailed",
                batchId: v.fence.batchId,
                candidateId: v.candidateId,
                verdictId: v.verdictId,
                attribution:
                  v.outcome !== "bounce"
                    ? "infra"
                    : batch.members.length === 1 && batch.members[0] !== undefined
                      ? batch.members[0]
                      : "unattributed",
              };
        return Result.succeed({
          drafts: [{ payload: issued }, { payload: settled }],
          value: undefined,
        });
      },
    ).pipe(Effect.asVoid, Effect.provide(outbox.layer), Effect.provide(clock.layer));
  return {
    recorded,
    outbox,
    layer: Layer.succeed(BatchVerdicts, BatchVerdicts.of({ record })),
  };
}

/** A change as Precheck sees it in memory: its revision, state and workspace, and the calls it took. */
interface PrecheckedChange {
  revision: number;
  state: ChangeState;
  readonly workspace: PrecheckWorkspace | undefined;
  readonly replies: Map<string, VerdictId | undefined>;
}

/**
 * The Change DO's side of `ChangePrecheck`, in memory: the transitions its
 * machine takes (submitted → deriving on `started`, then bounced on
 * `refused`, or on `compiled` verifying and, with no step before the queue
 * at L1, queued in the same commit), idempotent by instance, and
 * ChangeStateRefused for a stale revision or a step the state does not allow.
 * `submit` seeds a change; `calls` lists the writes that took effect.
 */
export function makeChangePrecheckMemory() {
  const changes = new Map<ChangeId, PrecheckedChange>();
  let verdicts = 0;
  const calls: { changeId: ChangeId; method: string; call: PrecheckCall }[] = [];
  const known = (changeId: ChangeId) => {
    const change = changes.get(changeId);
    return change === undefined
      ? Effect.fail(new ChangeNotFound({ changeId }))
      : Effect.succeed(change);
  };
  const refusedBy = (changeId: ChangeId, change: PrecheckedChange, command: string) =>
    new ChangeStateRefused({ changeId, state: change.state, command });
  /** One write: a replay answers what the first did; otherwise `from` must hold at `call.revision`. */
  const write = (
    changeId: ChangeId,
    method: string,
    call: PrecheckCall,
    from: ChangeState,
    to: ChangeState,
    reply: () => VerdictId | undefined,
  ) =>
    Effect.flatMap(known(changeId), (change) => {
      const key = `${call.instanceId}:${method}`;
      if (change.replies.has(key)) return Effect.succeed(change.replies.get(key));
      if (call.revision !== change.revision || change.state !== from)
        return Effect.fail(refusedBy(changeId, change, method));
      const answer = reply();
      change.replies.set(key, answer);
      change.state = to;
      calls.push({ changeId, method, call });
      return Effect.succeed(answer);
    });
  return {
    calls,
    /** Seeds `changeId` as submitted at `revision`, holding `workspace` (none: it holds none yet). */
    submit: (changeId: ChangeId, revision: number, workspace?: PrecheckWorkspace) => {
      changes.set(changeId, { revision, state: "submitted", workspace, replies: new Map() });
    },
    /** The change's state, for a test to read. */
    stateOf: (changeId: ChangeId) => changes.get(changeId)?.state,
    layer: Layer.succeed(
      ChangePrecheck,
      ChangePrecheck.of({
        workspace: (changeId) =>
          Effect.flatMap(known(changeId), (change) =>
            change.workspace === undefined
              ? Effect.fail(refusedBy(changeId, change, "workspace"))
              : Effect.succeed(change.workspace),
          ),
        started: (changeId, call) =>
          write(changeId, "precheckStarted", call, "submitted", "deriving", () => undefined).pipe(
            Effect.asVoid,
          ),
        refused: (changeId, refusal) =>
          write(changeId, "precheckRefused", refusal, "deriving", "bounced", () =>
            makeId("vrd", String((verdicts += 1)).padStart(26, "0")),
          ).pipe(
            Effect.flatMap((verdictId) =>
              verdictId === undefined
                ? Effect.die("a refusal always issues a verdict")
                : Effect.succeed(verdictId),
            ),
          ),
        compiled: (changeId, plan) =>
          write(changeId, "planCompiled", plan, "deriving", "queued", () => undefined).pipe(
            Effect.asVoid,
          ),
      }),
    ),
  };
}
