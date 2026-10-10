import { Context, type Effect } from "effect";
import type { EntityRef, EscalationId } from "../../domain/kernel/index.ts";

export interface EscalationRequest {
  readonly question: string;
  readonly options: readonly string[];
  readonly consequences: readonly string[];
  readonly about: EntityRef;
}

export interface Ruling {
  readonly escalationId: EscalationId;
  readonly option: string;
  readonly by: string;
}

/** Routes a question to a person and waits, event-driven, for the ruling. The default meanwhile is hold. */
export class HumanGate extends Context.Service<HumanGate, {
  readonly raise: (request: EscalationRequest) => Effect.Effect<EscalationId>;
  readonly awaitRuling: (escalationId: EscalationId) => Effect.Effect<Ruling>;
}>()("keel/HumanGate") {}
