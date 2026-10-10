import type { Clock, Ids } from "@keeltown/core/ports";
import { ManagedRuntime } from "effect";
import { SystemLive } from "../adapters/driven/system.ts";

/**
 * A Workflow's composition root, built from `this.env` on each `run()`. Steps
 * retry by throwing; retries are configured on the step, never with
 * Effect.retry; ids, time and randomness come only from inside steps.
 */
export function workflowRuntime(_env: Env): ManagedRuntime.ManagedRuntime<Clock | Ids, never> {
  return ManagedRuntime.make(SystemLive);
}
