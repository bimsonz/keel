import { DurableObject } from "cloudflare:workers";
import { durableObjectRuntime, type DurableObjectRuntime } from "../../../composition/do.ts";

/**
 * The Project DO (`project:<id>`): settings and the subject registry. Keel builds its RPC methods here, against the contract in
 * src/rpc. The runtime is built once, in the constructor.
 */
export class ProjectDO extends DurableObject<Env> {
  protected readonly runtime: DurableObjectRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = durableObjectRuntime(ctx);
  }
}
