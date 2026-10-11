import { Context, type Effect } from "effect";
import type {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  AgentToken,
  SessionSponsorRefused,
  Sponsor,
} from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";
import type { Session } from "../../domain/memory/index.ts";

/** An agent's request to open a session. */
export interface OpenSessionInput {
  readonly harness?: string;
  readonly model?: string;
  /** The sponsor the request names: only the one the session takes is accepted. */
  readonly onBehalfOf?: Sponsor;
  readonly idempotencyKey: string;
}

/** Agents' sessions, which their AgentSession DOs hold. */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Opens a session for the principal's agent, acting for its token's
     * sponsor, else its enrolment's: a request naming another is
     * SessionSponsorRefused. The session becomes the agent's current one. The
     * same Idempotency-Key and body answers the same session; another body is
     * an IdempotencyConflict.
     */
    readonly open: (
      principal: AgentToken,
      input: OpenSessionInput,
    ) => Effect.Effect<
      Session,
      AgentNotKnown | AgentNotAdmitted | IdempotencyConflict | SessionSponsorRefused
    >;
    /** The agent's current session; null when it has opened none, or has no session state at all. */
    readonly current: (agentId: AgentId) => Effect.Effect<Session | null>;
  }
>()("keel/Sessions") {}
