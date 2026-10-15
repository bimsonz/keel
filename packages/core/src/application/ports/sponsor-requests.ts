import { Context, type Effect } from "effect";
import type { AgentId, Instant, UserId } from "../../domain/kernel/index.ts";

/** An agent's requests to one person, as one of its events leaves them. */
export interface SponsorRequestRow {
  readonly agentId: AgentId;
  readonly person: UserId;
  /** When the request was made, while one waits. */
  readonly askedAt?: Instant | undefined;
  /** When it lapses, while one waits. */
  readonly expiresAt?: Instant | undefined;
  /** When the person blocked the agent, while they do. */
  readonly blockedAt?: Instant | undefined;
}

/**
 * The sponsor requests addressed to people, as rows a person's own list and
 * the asking agent's object can read: a projection of what each agent's own
 * object keeps.
 *
 * - `apply` writes one agent's requests to one person, guarded by `seq`, the
 *   agent's event number: a write at or below the row's own changes nothing.
 * - `settle` ends every request the agent has waiting, once somebody sponsors it.
 * - `waitingFor` lists the requests waiting for a person at `now`, oldest
 *   first; `waitingCount` counts them. `blockedBy` lists the agents a person
 *   blocked, oldest block first.
 */
export class SponsorRequests extends Context.Service<
  SponsorRequests,
  {
    readonly apply: (row: SponsorRequestRow, seq: number) => Effect.Effect<void>;
    readonly settle: (agentId: AgentId) => Effect.Effect<void>;
    readonly waitingFor: (
      person: UserId,
      now: Instant,
    ) => Effect.Effect<readonly SponsorRequestRow[]>;
    readonly waitingCount: (person: UserId, now: Instant) => Effect.Effect<number>;
    readonly blockedBy: (person: UserId) => Effect.Effect<readonly SponsorRequestRow[]>;
  }
>()("keel/SponsorRequests") {}
