import { systemClock, type Clock } from "./clock.ts";
import { randomIds, type IdGenerator } from "./ids.ts";
import { MemoryStore } from "./store/memory.ts";
import type { Store } from "./store/types.ts";

/** Everything the app needs from the outside world. */
export interface Deps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** An empty in-memory forge on the real clock with random identifiers. */
export function memoryDeps(): Deps {
  return { store: new MemoryStore(), clock: systemClock, ids: randomIds() };
}
