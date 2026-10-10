import { Context, type Effect } from "effect";
import type { IdOf, IdPrefix } from "../../domain/kernel/index.ts";

/** New identifiers: a type prefix and a ULID. */
export class Ids extends Context.Service<Ids, {
  readonly next: <P extends IdPrefix>(prefix: P) => Effect.Effect<IdOf[P]>;
}>()("keel/Ids") {}
