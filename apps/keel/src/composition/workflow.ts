import type { WorkflowStep } from "cloudflare:workers";
import { type DurableReport, StoredStepReport } from "@keeltown/core/application/verification";
import { ContentHash } from "@keeltown/core/kernel";
import type {
  AdmittedGuards,
  BatchVerdicts,
  CandidateBundles,
  CandidateComposer,
  ChangePrecheck,
  Clock,
  CodeHost,
  EvidenceStore,
  FlowSpecSource,
  Ids,
  NoopWorlds,
  PlanStore,
  PlatformFunction,
  ProbeChanges,
  ProbeLedger,
  ProbeRunner,
  ProbeSources,
  ProbeStore,
  Projects,
  SyntaxSource,
  Trunks,
  VerifierRuntime,
  WorkspacePool,
  WorldChecks,
} from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  type Durable,
  type SuiteRunner,
  SuiteRuntimeCi,
} from "../adapters/driven/ci/suite-runtime.ts";
import { BatchVerdictsRpc, isLaneNamespace } from "../adapters/driven/do-rpc/batch-verdicts.ts";
import { AdmittedGuardsCodeHost } from "../adapters/driven/gitcore/admitted-guards.ts";
import { FlowSpecSourceCodeHost } from "../adapters/driven/gitcore/flow-spec-source.ts";
import { SyntaxSourceTreeSitter } from "../adapters/driven/syntax/syntax-source.ts";
import { SYNTAX_WASM } from "../adapters/driven/syntax/wasm.ts";
import { ChangePrecheckRpc } from "../adapters/driven/do-rpc/change-precheck.ts";
import { ProbeChangesRpc } from "../adapters/driven/do-rpc/probe-changes.ts";
import { ProbeLedgerRpc } from "../adapters/driven/do-rpc/probe-ledger.ts";
import { TrunksRpc } from "../adapters/driven/do-rpc/trunks.ts";
import { CandidateBundlesGitCore } from "../adapters/driven/gitcore/candidate-bundles.ts";
import { CandidateComposerGitCore } from "../adapters/driven/gitcore/candidate-composer.ts";
import { ProbeSourcesCodeHost } from "../adapters/driven/gitcore/probe-sources.ts";
import { BundleStoreR2 } from "../adapters/driven/r2/bundle-store.ts";
import { NoopWorldsBundles } from "../adapters/driven/r2/noop-world.ts";
import { WorldChecksWorkflow } from "../adapters/driven/workflow/world-checks.ts";
import { ProbeRunnerRpc, verifierEntrypoint } from "../adapters/driven/do-rpc/probe-runner.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { WorkspacePoolRpc } from "../adapters/driven/do-rpc/workspace-pool.ts";
import { EvidenceStoreR2 } from "../adapters/driven/r2/evidence-store.ts";
import { PlanStoreR2 } from "../adapters/driven/r2/plan-store.ts";
import { ProbeStoreR2 } from "../adapters/driven/r2/probe-store.ts";
import { SystemLive } from "../adapters/driven/system.ts";
import {
  modelPins,
  PlatformFunctionWorkersAI,
  type StreamingAi,
} from "../adapters/driven/workers-ai/platform-function.ts";
import { artifactsLocationHint, artifactsObjects, codeHostLayer } from "./do.ts";

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
 * KeelVerify's composition root, per run: the plan from the plan store
 * (ARCHIVE), Tier 2 steps through the CI engine's `runner`, guard steps on
 * keel-verify's VerifierDOs, evidence in ARCHIVE, verdicts to the Lane DO.
 * `durable` makes the runtime's own side effects Workflow steps, so a replay
 * returns what the first run stored.
 */
export function keelVerifyRuntime(
  env: Env,
  engine: { readonly runner: SuiteRunner; readonly step: WorkflowStep },
): ManagedRuntime.ManagedRuntime<
  Clock | Ids | EvidenceStore | BatchVerdicts | VerifierRuntime | PlanStore | ProbeRunner,
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
      PlanStoreR2(env.ARCHIVE),
      ProbeRunnerRpc(verifierEntrypoint(env.VERIFIER)),
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
 * A step's report as a durable Workflow step: the first run reports and
 * persists it as JSON, and a replay decodes what was persisted.
 */
export const durableReport =
  (step: WorkflowStep): DurableReport =>
  (name, report) =>
    Effect.promise(() =>
      step.do(name, async (): Promise<string> =>
        JSON.stringify(Schema.encodeSync(StoredStepReport)(await Effect.runPromise(report))),
      ),
    ).pipe(Effect.map((stored) => Schema.decodeUnknownSync(StoredStepReport)(JSON.parse(stored))));

/**
 * Precheck's composition root, per run: the change through the Change
 * DO, settings and the live anchors through the Project DO, the diff and the
 * parsed source through the code host, and the derivation record kept in
 * ARCHIVE beside the plan.
 */
export function precheckRuntime(
  env: Env,
): ManagedRuntime.ManagedRuntime<
  | ChangePrecheck
  | Projects
  | CodeHost
  | FlowSpecSource
  | AdmittedGuards
  | SyntaxSource
  | PlanStore
  | EvidenceStore,
  never
> {
  const project = (projectId: string) =>
    env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
  const code = codeHostLayer(env);
  return ManagedRuntime.make(
    Layer.mergeAll(
      ChangePrecheckRpc(env.CHANGE),
      ProjectsRpc(project),
      code,
      Layer.mergeAll(
        FlowSpecSourceCodeHost,
        AdmittedGuardsCodeHost(),
        SyntaxSourceTreeSitter(SYNTAX_WASM),
      ).pipe(Layer.provide(code)),
      PlanStoreR2(env.ARCHIVE),
      EvidenceStoreR2(env.ARCHIVE),
    ),
  );
}

/**
 * Probe drafting's driven adapters: each PlatformFunction on the model
 * PLATFORM_FUNCTION_PINS names, drafted probes kept in BUNDLES, and the world
 * matrix run on keel-verify's VerifierDOs. The Probe Workflow composes exactly
 * this; a pin that is missing or not an exact model stops it here.
 */
export function probeDraftingLayer(env: {
  readonly AI: StreamingAi;
  readonly PLATFORM_FUNCTION_PINS: unknown;
  readonly BUNDLES: R2Bucket;
  readonly VERIFIER: Fetcher;
}): Layer.Layer<PlatformFunction | ProbeStore | ProbeRunner> {
  return Layer.mergeAll(
    PlatformFunctionWorkersAI(env.AI, modelPins(env.PLATFORM_FUNCTION_PINS)),
    ProbeStoreR2(env.BUNDLES),
    ProbeRunnerRpc(verifierEntrypoint(env.VERIFIER)),
  );
}

/** Everything the Probe program reads and writes. */
export type ProbeServices =
  | Clock
  | Ids
  | CodeHost
  | ProbeLedger
  | ProbeChanges
  | Trunks
  | AdmittedGuards
  | CandidateBundles
  | CandidateComposer
  | ProbeSources
  | NoopWorlds
  | EvidenceStore
  | PlatformFunction
  | ProbeStore
  | ProbeRunner
  | FlowSpecSource
  | PlanStore
  | WorldChecks;

/**
 * The Probe Workflow's composition root, per run: the conflict's ledger on
 * its Subject DO, each party through its Change DO, trunk's head from the
 * Trunk DO, every world read and bundled through GitCore over the Artifacts
 * bindings and kept in BUNDLES (A-noop built from A's bundle), cell evidence
 * in ARCHIVE, drafting as probeDraftingLayer composes it, and an admitted
 * guard committed to the project's guard repo.
 */
export function probeRuntime(env: Env): ManagedRuntime.ManagedRuntime<ProbeServices, never> {
  const code = codeHostLayer(env);
  const objects = artifactsObjects(env);
  const bundles = BundleStoreR2(env.BUNDLES);
  return ManagedRuntime.make(
    Layer.mergeAll(
      SystemLive,
      code,
      ProbeLedgerRpc((address) => env.SUBJECT.get(env.SUBJECT.idFromName(address))),
      ProbeChangesRpc((changeId) =>
        env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`)),
      ).pipe(Layer.provide(code)),
      TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
      AdmittedGuardsCodeHost().pipe(Layer.provide(code)),
      CandidateComposerGitCore(objects).pipe(Layer.provide(code)),
      CandidateBundlesGitCore(objects).pipe(Layer.provide(bundles)),
      ProbeSourcesCodeHost.pipe(Layer.provide(code)),
      NoopWorldsBundles.pipe(Layer.provide(bundles)),
      EvidenceStoreR2(env.ARCHIVE),
      probeDraftingLayer(env),
      FlowSpecSourceCodeHost.pipe(Layer.provide(code)),
      PlanStoreR2(env.ARCHIVE),
      WorldChecksWorkflow(env.WORLD_CHECK),
    ),
  );
}

/**
 * KeelWorldCheck's composition root, per run: plans from the plan store
 * (ARCHIVE), Tier 2 steps through the CI engine's `runner` on the world's
 * bundle, evidence in ARCHIVE, and each check recorded to the conflict's
 * Subject DO. `step` makes the evidence writes Workflow steps, as KeelVerify's.
 */
export function worldCheckRuntime(
  env: Env,
  engine: { readonly runner: SuiteRunner; readonly step: WorkflowStep },
): ManagedRuntime.ManagedRuntime<
  Clock | Ids | EvidenceStore | VerifierRuntime | PlanStore | ProbeLedger | ProbeChanges,
  never
> {
  const durable: Durable = (name, effect) =>
    Effect.promise(() =>
      engine.step.do(name, async (): Promise<string> => Effect.runPromise(effect)),
    ).pipe(Effect.map((stored) => Schema.decodeUnknownSync(ContentHash)(stored)));
  const evidence = EvidenceStoreR2(env.ARCHIVE);
  return ManagedRuntime.make(
    Layer.mergeAll(
      SystemLive,
      evidence,
      PlanStoreR2(env.ARCHIVE),
      ProbeLedgerRpc((address) => env.SUBJECT.get(env.SUBJECT.idFromName(address))),
      ProbeChangesRpc((changeId) =>
        env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`)),
      ).pipe(Layer.provide(codeHostLayer(env))),
      SuiteRuntimeCi({
        runner: engine.runner,
        durable,
        literals: [env.CLOUDFLARE_ACCOUNT_ID].filter((l) => typeof l === "string" && l.length > 0),
      }).pipe(Layer.provide(evidence)),
    ),
  );
}
