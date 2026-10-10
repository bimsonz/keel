import { Context, type Effect } from "effect";
import type {
  Agent,
  AgentKind,
  IdempotencyConflict,
  Principal,
  Scope,
} from "../../domain/identity/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";

export interface EnrolInput {
  readonly name: string;
  readonly kind: AgentKind;
  readonly scopes: readonly Scope[];
  /** The project the agent works in; the operator's own when absent. */
  readonly projectId?: ProjectId;
  readonly idempotencyKey: string;
}

export interface Enrolment {
  readonly agent: Agent;
  readonly clientId: string;
  /** Shown once, here; Keel keeps only its hash. */
  readonly clientSecret: string;
}

/**
 * The isolate's way to enrol an agent in its AgentSession DO (`agent:<id>`),
 * the agents' source of truth. The DO writes the AgentDirectory projection
 * before it answers, so the credential exchanges for a token at once.
 * `enrol` is idempotent by Idempotency-Key (the agent id is derived from the
 * operator and the key); a retry re-issues the secret, because the first answer
 * was the only place it was shown.
 */
export class Enrolments extends Context.Service<
  Enrolments,
  {
    readonly enrol: (
      principal: Principal,
      input: EnrolInput,
    ) => Effect.Effect<Enrolment, IdempotencyConflict>;
  }
>()("keel/Enrolments") {}
