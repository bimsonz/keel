import { DurableObject } from "cloudflare:workers";
import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { Exit } from "effect";
import { verifierRuntime } from "../../../composition/do.ts";
import { encodeExit, VerifierCodecs, type VerifierRpc } from "../../../rpc/index.ts";

/**
 * One VerifierDO per world: it runs a job's steps in throwaway isolates with
 * no outbound network. Until the Tier 1 runner lands (spike S14), every
 * job answers VerifierUnavailable through the Exit envelope.
 */
export class VerifierDO extends DurableObject<Env> implements VerifierRpc {
  private readonly runtime: ReturnType<typeof verifierRuntime>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = verifierRuntime(env);
  }

  async run(_job: unknown) {
    return encodeExit(
      VerifierCodecs.run,
      Exit.fail(new VerifierUnavailable({ reason: "Tier 1 execution is not implemented yet" })),
    );
  }
}
