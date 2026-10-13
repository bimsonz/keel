import type { Lanes } from "@keeltown/core/ports";
import { ManagedRuntime } from "effect";
import { LanesRpc } from "../adapters/driven/do-rpc/lanes.ts";
import { artifactsLocationHint } from "./do.ts";

const runtimes = new WeakMap<Env, ManagedRuntime.ManagedRuntime<Lanes, never>>();

/** The queue consumer's services, one runtime per Env: the lanes a Workflows report is passed to. */
export function queueRuntime(env: Env): ManagedRuntime.ManagedRuntime<Lanes, never> {
  let runtime = runtimes.get(env);
  if (runtime === undefined) {
    runtime = ManagedRuntime.make(LanesRpc(env.LANE, artifactsLocationHint(env)));
    runtimes.set(env, runtime);
  }
  return runtime;
}
