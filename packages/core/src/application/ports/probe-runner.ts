import { Context, type Effect, Schema } from "effect";
import type { ContentHash, NamespaceId } from "../../domain/kernel/index.ts";
import type { World } from "../../domain/verification/index.ts";
import type { ProbeRun } from "../verification/index.ts";

/** The runner could not run the probe at all (unreachable, out of time): no answer, and nothing about the probe. */
export class ProbeRunnerUnavailable extends Schema.TaggedError<ProbeRunnerUnavailable>()(
  "ProbeRunnerUnavailable",
  { reason: Schema.String },
) {}

/** One probe run: the probe's bundle, run against one world's tree, on calibration run `run`. Both bundles are the namespace's. */
export interface ProbeRunRequest {
  readonly namespace: NamespaceId;
  readonly probe: ContentHash;
  readonly world: World;
  readonly worldBundle: ContentHash;
  readonly run: number;
}

/** Whether a probe could run against a world as the namespace's store stands, and why not. */
export type WorldReadiness =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Unready"; readonly reason: string };

/**
 * Runs a probe in Tier 1 against one world (VerifierDO, spike S14): a fresh
 * isolate per run, no outbound network, a deadline. It answers what the
 * probe's runner reported, read against the exit-code and JSON-line contract
 * (`readProbeRun`); a broken probe is a harness error, never a cell.
 *
 * `ready` asks, before any probe exists, whether one could run against a
 * world bundle. Unready is the namespace's store as it stands (no deps bundle
 * for the world's lockfile, a bundle missing or forged), which no retry
 * changes; a runner that did not answer fails as unavailable, which says
 * nothing of the world.
 */
export class ProbeRunner extends Context.Service<
  ProbeRunner,
  {
    readonly run: (request: ProbeRunRequest) => Effect.Effect<ProbeRun, ProbeRunnerUnavailable>;
    readonly ready: (
      request: Pick<ProbeRunRequest, "namespace" | "worldBundle">,
    ) => Effect.Effect<WorldReadiness, ProbeRunnerUnavailable>;
  }
>()("keel/ProbeRunner") {}
