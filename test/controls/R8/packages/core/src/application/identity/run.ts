// Control for R8: a use-case runs its own effect.
import { Effect } from "effect";

export const ran = Effect.runPromise(Effect.void);
