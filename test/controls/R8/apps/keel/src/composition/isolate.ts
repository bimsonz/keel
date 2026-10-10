// A composition root may build and run a runtime: the canary, not a violation.
import { Effect, Layer, ManagedRuntime } from "effect";

export const runtime = ManagedRuntime.make(Layer.empty);
export const ran = runtime.runPromise(Effect.void);
