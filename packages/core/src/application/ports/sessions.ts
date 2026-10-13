import { Context, type Effect } from "effect";
import type {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  AgentToken,
} from "../../domain/identity/index.ts";
import type { AgentId, RunId } from "../../domain/kernel/index.ts";
import type { Session } from "../../domain/memory/index.ts";

/** An agent's request to open a session. */
export interface OpenSessionInput {
  readonly harness?: string;
  readonly model?: string;
  readonly idempotencyKey: string;
}

/** Agents' sessions, which their AgentSession DOs hold. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Opens a session for the principal's agent, sponsored by the user its
     * enrolment names. The session becomes the current one of the run the
     * principal's token names (of the agent itself when it names none), and
     * replaces no other run's. The same Idempotency-Key and body answers the
     * same session; another body is an IdempotencyConflict.
     */
    readonly open: (
      principal: AgentToken,
      input: OpenSessionInput,
    ) => Effect.Effect<Session, AgentNotKnown | AgentNotAdmitted | IdempotencyConflict>;
    /** The current session of a run of the agent (of the agent itself, for no run); null when it has opened none, or has no session state at all. */
    readonly current: (agentId: AgentId, run?: RunId) => Effect.Effect<Session | null>;
  }
>()("keel/Sessions") {}
