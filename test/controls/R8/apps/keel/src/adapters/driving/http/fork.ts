// Control for R8: a driving adapter detaches a fiber, which dies with the response.
import { Effect } from "effect";

export const forked = Effect.forkDetach(Effect.void);
