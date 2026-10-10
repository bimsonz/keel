import { DurableObject } from "cloudflare:workers";
import { durableObjectRuntime, type DurableObjectRuntime } from "../../../composition/do.ts";

/**
 * The Lane DO (`lane:<project>:<id>`): the queue, batching, bisection, textual and interaction conflicts. Keel builds its RPC methods here, against the contract in
 * src/rpc. The runtime is built once, in the constructor.
 */
export class LaneDO extends DurableObject<Env> {
  protected readonly runtime: DurableObjectRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = durableObjectRuntime(ctx);
  }
}
