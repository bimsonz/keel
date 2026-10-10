import { Context, type Effect } from "effect";

/**
 * Work that may outlive the response but need not happen. Work that must
 * happen goes through the outbox, a Queue or a Workflow instead.
 */
export class Background extends Context.Service<
  Background,
  {
    readonly run: (work: Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("keel/Background") {}
