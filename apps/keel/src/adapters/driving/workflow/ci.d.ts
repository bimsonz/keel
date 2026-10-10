import type { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

/**
 * What Keel uses of @cloudflare/ci 0.2.0, declared here because the package
 * ships unbuilt TypeScript that fails this repo's compiler flags. Grow these
 * declarations as KeelVerify uses more of the engine; ci.js re-exports the
 * real implementation.
 */
/** A CI run's parameters: the source to verify, plus any fields the caller adds (S15: they survive). */
export type CiParams = Readonly<Record<string, unknown>>;

/** The engine's handle for Tier 2 runners inside a pipeline. */
export interface CiContext {
  readonly runner: (...args: never[]) => unknown;
}

/** The CI engine's Workflow, over Cloudflare Artifacts (its default provider). */
export declare abstract class CIWorkflow<Bindings> extends WorkflowEntrypoint<Bindings, CiParams> {
  protected abstract pipeline(event: WorkflowEvent<CiParams>, step: WorkflowStep, ci: CiContext): Promise<void>;
}
