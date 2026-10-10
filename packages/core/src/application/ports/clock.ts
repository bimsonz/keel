import { Context, type Effect } from "effect";
import type { Instant } from "../../domain/kernel/index.ts";

/** The current time. Ambient non-determinism reaches use-cases only through a port. */
export class Clock extends Context.Service<
  Clock,
  {
    readonly now: Effect.Effect<Instant>;
  }
>()("keel/Clock") {}
