import { Context, type Effect, Schema } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { World } from "../../domain/verification/index.ts";
import type { ProbeRun } from "../verification/index.ts";

/** The runner could not run the probe at all (unreachable, out of time): no answer, and nothing about the probe. */
export class ProbeRunnerUnavailable extends Schema.TaggedError<ProbeRunnerUnavailable>()(
  "ProbeRunnerUnavailable",
  { reason: Schema.String },
) {}

/** One probe run: the probe's bundle, run against one world's tree, on calibration run `run`. */
export interface ProbeRunRequest {
  readonly probe: ContentHash;
  readonly world: World;
  readonly worldBundle: ContentHash;
  readonly run: number;
}

/**
 * Runs a probe in Tier 1 against one world (VerifierDO, spike S14): a fresh
 * isolate per run, no outbound network, a deadline. It answers what the
 * probe's runner reported, read against the exit-code and JSON-line contract
 * (`readProbeRun`); a broken probe is a harness error, never a cell.
 */
export class ProbeRunner extends Context.Service<
  ProbeRunner,
  {
    readonly run: (request: ProbeRunRequest) => Effect.Effect<ProbeRun, ProbeRunnerUnavailable>;
  }
>()("keel/ProbeRunner") {}
