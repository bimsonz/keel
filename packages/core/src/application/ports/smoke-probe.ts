import { Context, type Effect } from "effect";
import type { SmokeAnswer } from "../../domain/delivery/index.ts";

/**
 * Asks a preview one smoke request: a GET of the address `smokeUrl` made, no
 * redirect followed, bounded in time, the body read only so far. What comes
 * back, or why nothing did.
 */
export class SmokeProbe extends Context.Service<
  SmokeProbe,
  { readonly ask: (url: string) => Effect.Effect<SmokeAnswer> }
>()("keel/SmokeProbe") {}
