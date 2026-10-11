import type { WorkflowStep } from "cloudflare:workers";
import { ContentHash } from "@keeltown/core/kernel";
import type {
  BatchVerdicts,
  ChangePrecheck,
  Clock,
  CodeHost,
  EvidenceStore,
  Ids,
  Projects,
  VerifierRuntime,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  type Durable,
  type SuiteRunner,
  SuiteRuntimeCi,
} from "../adapters/driven/ci/suite-runtime.ts";
import { BatchVerdictsRpc, isLaneNamespace } from "../adapters/driven/do-rpc/batch-verdicts.ts";
import { ChangePrecheckRpc } from "../adapters/driven/do-rpc/change-precheck.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { WorkspacePoolRpc } from "../adapters/driven/do-rpc/workspace-pool.ts";
import { EvidenceStoreR2 } from "../adapters/driven/r2/evidence-store.ts";
import { SystemLive } from "../adapters/driven/system.ts";
import { artifactsLocationHint, codeHostLayer } from "./do.ts";

/**
 * A Workflow's composition root, built from `this.env` on each `run()`. Steps
 * retry by throwing; retries are configured on the step, never with
 * Effect.retry; ids, time and randomness come only from inside steps.
 */
export function workflowRuntime(_env: Env): ManagedRuntime.ManagedRuntime<Clock | Ids, never> {
  return ManagedRuntime.make(SystemLive);
}

/** PushObserved's composition root: each project's pool over its DO's RPC, placed as the pool's other callers place it. */
export function pushObservedRuntime(env: Env): ManagedRuntime.ManagedRuntime<WorkspacePool, never> {
  return ManagedRuntime.make(WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)));
}

/**
 * KeelVerify's composition root, per run: Tier 2 suites through the CI
 * engine's `runner`, evidence in ARCHIVE, verdicts to the Lane DO. `durable`
 * makes the runtime's own side effects Workflow steps, so a replay returns
 * what the first run stored.
 */
export function keelVerifyRuntime(
  env: Env,
  engine: { readonly runner: SuiteRunner; readonly step: WorkflowStep },
): ManagedRuntime.ManagedRuntime<
  Clock | Ids | EvidenceStore | BatchVerdicts | VerifierRuntime,
  never
> {
  const durable: Durable = (name, effect) =>
    Effect.promise(() =>
      engine.step.do(name, async (): Promise<string> => Effect.runPromise(effect)),
    ).pipe(Effect.map((stored) => Schema.decodeUnknownSync(ContentHash)(stored)));
  const evidence = EvidenceStoreR2(env.ARCHIVE);
  // recordVerdict is LaneRpc's; the Lane DO implements it. Until the
  // DO declares it, the namespace is checked by shape, and a call to a Lane
  // DO without the method fails the record step.
  const lanes: unknown = env.LANE;
  if (!isLaneNamespace(lanes)) throw new Error("LANE is not a Durable Object namespace");
  return ManagedRuntime.make(
    Layer.mergeAll(
      SystemLive,
      evidence,
      BatchVerdictsRpc(lanes),
      SuiteRuntimeCi({
        runner: engine.runner,
        durable,
        // A required secret on every deployed Worker; absent only in tests.
        literals: [env.CLOUDFLARE_ACCOUNT_ID].filter((l) => typeof l === "string" && l.length > 0),
      }).pipe(Layer.provide(evidence)),
    ),
  );
}

/**
 * Precheck's composition root, per run: the change through the Change
 * DO, settings through the Project DO, and the diff through the code host.
 */
export function precheckRuntime(
  env: Env,
): ManagedRuntime.ManagedRuntime<ChangePrecheck | Projects | CodeHost, never> {
  // Until the Project DO declares settings(), the policy step fails and retries.
  const project = (projectId: string) =>
    env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
  return ManagedRuntime.make(
    Layer.mergeAll(ChangePrecheckRpc(env.CHANGE), ProjectsRpc(project), codeHostLayer(env)),
  );
}
