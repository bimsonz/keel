import { Context, type Effect } from "effect";
import type { WorldCheckJob } from "../verification/index.ts";

/**
 * Starts a conflict's world checks (KeelWorldCheck), one instance per world
 * (`world-<conflictId>-<world>`). Starting an instance that already exists
 * succeeds without starting another, so a retried step is idempotent. Each
 * instance records its checks in the conflict's ledger itself.
 */
export class WorldChecks extends Context.Service<
  WorldChecks,
  {
    readonly start: (instanceId: string, job: WorldCheckJob) => Effect.Effect<void>;
  }
>()("keel/WorldChecks") {}
