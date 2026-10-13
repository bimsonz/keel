import { Context, type Effect } from "effect";
import type {
  AgentId,
  EscalationId,
  NamespaceId,
  ProjectId,
  UserId,
} from "../../domain/kernel/index.ts";
import type { EscalationCommand, InvalidEscalation } from "../../domain/verification/index.ts";
import type { EscalationRecord } from "./escalations.ts";

/** What a person is asked: the domain's Raise, without its tag. */
export type EscalationAsk = Omit<Extract<EscalationCommand, { _tag: "Raise" }>, "_tag">;

export interface RaiseRequest {
  /** The namespace that owns the project: its object (`ns:<id>`) hosts the escalation. */
  readonly namespace: NamespaceId;
  /** Derived from what the question is about, so a repeated raise is the same escalation. */
  readonly escalationId: EscalationId;
  readonly project: ProjectId;
  /** The user asked first. Absent when nobody vouches for the agent concerned: the namespace's maintainers are asked at once. */
  readonly sponsor?: UserId | undefined;
  /**
   * The agent the question concerns. Where a member invited it into the
   * namespace, or the namespace's person invited it to this project, they
   * answer for it there and are the one asked first, whoever `sponsor` names.
   */
  readonly agent?: AgentId | undefined;
  /** The object told when a person has ruled: it hears the escalation's DecisionRecorded. */
  readonly raisedBy: string;
  readonly ask: EscalationAsk;
}

/**
 * Puts a question to a person. Nothing waits on the answer: the object that
 * raised it hears the ruling's decision as an event, and holds meanwhile.
 * Raising the same escalation again answers it as it stands and asks nobody
 * twice.
 */
export class HumanGate extends Context.Service<
  HumanGate,
  {
    readonly raise: (request: RaiseRequest) => Effect.Effect<EscalationRecord, InvalidEscalation>;
  }
>()("keel/HumanGate") {}
