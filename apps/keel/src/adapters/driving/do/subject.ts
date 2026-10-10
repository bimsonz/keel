import { DurableObject } from "cloudflare:workers";
import { durableObjectRuntime, type DurableObjectRuntime } from "../../../composition/do.ts";

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout and semantic conflicts. Keel builds its RPC methods here, against the contract in
 * src/rpc. The runtime is built once, in the constructor.
 */
export class SubjectDO extends DurableObject<Env> {
  protected readonly runtime: DurableObjectRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = durableObjectRuntime(ctx);
  }
}
