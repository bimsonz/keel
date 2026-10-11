import { DurableObject } from "cloudflare:workers";
import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { Semaphore } from "@keeltown/runner-protocol";
import { Exit, Schema } from "effect";
import { verifierRuntime } from "../../../composition/do.ts";
import {
  encodeExit,
  ProbeRunRequest,
  VerifierCodecs,
  type VerifierRpc,
} from "../../../rpc/index.ts";
import {
  type BundleCache,
  PROBE_DEADLINE_MS,
  PROBE_SLOTS,
  runProbe,
  type Tier1,
} from "./tier1/run-probe.ts";

const decodeProbeRun = Schema.decodeUnknownExit(ProbeRunRequest);

/**
 * One VerifierDO per (probe, world): it runs that probe against that world in
 * throwaway isolates with no outbound network, at most PROBE_SLOTS at once
 * (the rest wait), each run reusing the one bundle built for the pair. Plan
 * jobs (`run`) still answer VerifierUnavailable until Tier 1 steps are
 * gives Tier 1 steps to this DO.
 */
export class VerifierDO extends DurableObject<Env> implements VerifierRpc {
  private readonly runtime: ReturnType<typeof verifierRuntime>;
  private readonly tier1: Tier1;
  private readonly bundled: BundleCache = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = verifierRuntime(env);
    this.tier1 = {
      env,
      slots: new Semaphore(PROBE_SLOTS),
      deadlineMs: PROBE_DEADLINE_MS,
    };
  }

  async run(_job: unknown) {
    return encodeExit(
      VerifierCodecs.run,
      Exit.fail(new VerifierUnavailable({ reason: "Tier 1 plan steps are not implemented yet" })),
    );
  }

  async runProbe(request: unknown) {
    const decoded = decodeProbeRun(request);
    if (Exit.isFailure(decoded))
      return encodeExit(
        VerifierCodecs.runProbe,
        Exit.fail(new VerifierUnavailable({ reason: "the probe run request did not decode" })),
      );
    const answer = await runProbe(this.tier1, this.bundled, decoded.value);
    if (answer._tag === "unavailable")
      return encodeExit(
        VerifierCodecs.runProbe,
        Exit.fail(new VerifierUnavailable({ reason: answer.reason })),
      );
    return encodeExit(
      VerifierCodecs.runProbe,
      Exit.succeed({
        run: answer.run,
        queued: answer.queued,
        ...(answer.instance === undefined ? {} : { instance: answer.instance }),
      }),
    );
  }
}
