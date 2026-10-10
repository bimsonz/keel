import type { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

/**
 * What Keel uses of @cloudflare/ci 0.2.0, declared here because the package
 * ships unbuilt TypeScript that fails this repo's compiler flags. Grow these
 * declarations as KeelVerify uses more of the engine; ci.js re-exports the
 * real implementation. Shapes follow the package's source (src/pipeline/types.ts,
 * src/source-control.ts, src/source-control-adapter.ts).
 */

/** A CI run's parameters: the engine's source fields plus any fields the caller adds (S15: they survive). */
export type CiParams = Readonly<Record<string, unknown>>;

/** Per-step engine config. Defaults: 2 retries 30 s apart, linear, and a 12-minute timeout. */
export interface RunnerConfig {
  readonly retries?: {
    readonly limit: number;
    readonly delay: number;
    readonly backoff?: "constant" | "linear" | "exponential";
  };
  readonly timeout?: number;
  readonly commandTimeoutMs?: number;
  readonly snapshotRetentionSeconds?: number;
}

/**
 * One Tier 2 runner: a fresh sandbox, the source checked out into
 * `/workspace`, then `command`. Keel never hands a runner a credential, so
 * both credential options exist only as the literal `false` (guard:
 * runner-credentials). No `cache` and no `secrets`: Keel uses neither.
 */
export interface RunnerOptions {
  readonly name: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly config?: RunnerConfig;
  readonly cloudflareCredentials: false;
  readonly sourceControlCredentials: false;
}

/** A log is a string up to 300,000 bytes and a stream beyond that. Persisted unredacted as step output. */
export interface CiRunnerLogs {
  readonly stdout: string | ReadableStream<Uint8Array>;
  readonly stderr: string | ReadableStream<Uint8Array>;
}

/**
 * A finished runner. A non-zero exit throws inside the engine's step instead
 * of returning, so `exitCode` here is always 0.
 */
export interface CiRunnerResult {
  readonly exitCode: number;
  readonly logs: CiRunnerLogs;
  readonly snapshot: { readonly id: string; readonly dir: string; readonly localBucket?: boolean };
  runner(options: RunnerOptions): Promise<CiRunnerResult>;
}

/** The engine's handle for Tier 2 runners inside a pipeline. */
export interface CiContext {
  runner(options: RunnerOptions): Promise<CiRunnerResult>;
}

/** Where a runner's source comes from. Keel only ever uses an archive: no git, no token. */
export type SourceControlCheckout = { readonly kind: "archive"; readonly url: string };

/** The source a runner verifies, as the engine passes it to the provider. */
export interface SourceControlSource {
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
  readonly providerData: unknown;
}

/** The engine's per-run provider. Every method the type requires, whether or not the engine calls it. */
export interface SourceControlProvider {
  receiveEvent(event: { body: string; headers: Headers }): Promise<null>;
  getSourceCheckout(source: SourceControlSource): Promise<SourceControlCheckout>;
  listTreeBlobs(source: SourceControlSource, paths: string[]): Promise<null>;
  getStepCredentialEnv(source: SourceControlSource): Promise<Record<string, string>>;
  getPushCredentials(source: SourceControlSource): Promise<never>;
  createPullRequest(input: unknown): Promise<{ status: "skipped" }>;
  startStepNotification(input: unknown): Promise<null>;
}

/** What `static getProvider()` returns: the adapter the engine checks a payload against and builds a provider from. */
export interface SourceControlAdapter {
  readonly id: string;
  readonly repository: { readonly owner?: string; readonly repo?: string };
  create(env: unknown): SourceControlProvider;
  accepts(source: { provider: string; owner: string; repo: string }): boolean;
  assertSource(source: { provider: string; owner: string; repo: string }): void;
}

/** The CI engine's Workflow. `run()` normalises the payload, asks the provider to accept it, then calls `pipeline()`. */
export declare abstract class CIWorkflow<Bindings> extends WorkflowEntrypoint<Bindings, CiParams> {
  static getProvider(): SourceControlAdapter;
  protected abstract pipeline(
    event: WorkflowEvent<CiParams>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void>;
}
