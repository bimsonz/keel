import { Context, type Effect, type Redacted } from "effect";
import type { DeploymentFailed } from "../../domain/delivery/index.ts";
import type { Json } from "../../domain/kernel/index.ts";

/** The account a version goes to: its id, and the workers.dev subdomain its addresses are under (`<name>.workers.dev`). */
export interface DeployAccount {
  readonly accountId: string;
  readonly workersDev: string;
}

/** A Worker version as Keel uploads it: one ES module, and the facts its wrangler config gave. */
export interface WorkerUpload {
  readonly worker: string;
  readonly mainModule: string;
  /** The module, gzipped and base64, as the build stored it. */
  readonly moduleGzip: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  /** Plain vars: a string is sent as text, anything else as JSON. No other binding is sent. */
  readonly vars: Readonly<Record<string, Json>>;
  /** The change's stable alias, when the version is one change's. */
  readonly alias?: string;
  /** What the version is tagged with on the account: the candidate it was built from. */
  readonly tag: string;
  readonly message: string;
}

/** A version uploaded and not deployed, and the addresses it answers at, each a bare https origin. */
export interface PreviewMade {
  readonly versionId: string;
  readonly url: string;
  readonly aliasUrl?: string;
}

/**
 * A provider's Workers, as Keel previews and deploys them (ADR 0008, ADR
 * 0015). The token is the caller's to reveal and is used only to authorise
 * each call: no answer, error or log carries it.
 *
 * - `preview` uploads a version that is not deployed, making the Worker first
 *   (with no code and no deployment) when the account has none of its name.
 * - `promote` deploys a version Keel uploaded to all of the Worker's traffic.
 * - `deleteVersion` deletes a version that is not deployed.
 */
export class Deployer extends Context.Service<
  Deployer,
  {
    readonly preview: (
      account: DeployAccount,
      token: Redacted.Redacted,
      upload: WorkerUpload,
    ) => Effect.Effect<PreviewMade, DeploymentFailed>;
    readonly promote: (
      account: DeployAccount,
      token: Redacted.Redacted,
      deploy: { readonly worker: string; readonly versionId: string; readonly message: string },
    ) => Effect.Effect<{ readonly deploymentId: string }, DeploymentFailed>;
    readonly deleteVersion: (
      account: DeployAccount,
      token: Redacted.Redacted,
      version: { readonly worker: string; readonly versionId: string },
    ) => Effect.Effect<void, DeploymentFailed>;
  }
>()("keel/Deployer") {}
