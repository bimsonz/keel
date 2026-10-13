import { Context, type Effect, Schema } from "effect";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  DecisionId,
  type EscalationId,
  type Instant,
  NamespaceId,
  ProjectId,
  UserId,
} from "../../domain/kernel/index.ts";
import type { EscalationState } from "../../domain/memory/index.ts";
import {
  Escalation,
  type EscalationNotFound,
  type EscalationStateRefused,
  type RulingOptionUnknown,
} from "../../domain/verification/index.ts";

/**
 * An escalation with where it belongs: the namespace whose object hosts it,
 * the project its question is about, the user asked first, and the decision
 * its ruling recorded.
 */
export const EscalationRecord = Schema.Struct({
  escalation: Escalation,
  namespace: NamespaceId,
  project: ProjectId,
  sponsor: Schema.optional(UserId),
  decisionId: Schema.optional(DecisionId),
});
export type EscalationRecord = typeof EscalationRecord.Type;

/**
 * An escalation as the Projector reads it: the record, with the label Keel
 * gave its question when it was raised (`E-n`, counted per project).
 */
export const LabelledEscalation = Schema.Struct({
  ...EscalationRecord.fields,
  label: Schema.String,
});
export type LabelledEscalation = typeof LabelledEscalation.Type;

/** What a ruling's decision chose: the option's id, and its label as the decision's summary. */
export const DecisionChosen = Schema.Struct({ option: Schema.String, summary: Schema.String });
export type DecisionChosen = typeof DecisionChosen.Type;

/**
 * Who reads the list. An agent reads every escalation of its own project. A
 * person reads their inbox: `listedTo` says which escalations are theirs to
 * answer, from the namespaces they maintain.
 */
export type EscalationReader =
  | { readonly _tag: "Project"; readonly project: ProjectId }
  | { readonly _tag: "User"; readonly userId: UserId; readonly maintains: readonly NamespaceId[] };

export interface EscalationListRead {
  readonly reader: EscalationReader;
  /** The reader's clock: the maintainers' turn comes by it. */
  readonly now: Instant;
  readonly state?: EscalationState | undefined;
  /** The `nextCursor` of the page before; absent reads from the newest. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EscalationListPage {
  /** Newest first. */
  readonly items: readonly LabelledEscalation[];
  readonly nextCursor?: string | undefined;
}

export interface RulingCommand {
  readonly escalationId: EscalationId;
  /** One of the escalation's option ids. */
  readonly option: string;
  readonly by: UserId;
  readonly rationale?: string | undefined;
  readonly idempotencyKey: string;
}

export type RulingRefusal =
  | EscalationNotFound
  | EscalationStateRefused
  | RulingOptionUnknown
  | IdempotencyConflict;

/**
 * The questions Keel has put to people, and their answers. The reads come
 * from the Projector's fold of the escalations' events; a ruling goes to the
 * escalation's namespace object, which records the decision with it.
 */
export class Escalations extends Context.Service<
  Escalations,
  {
    readonly list: (read: EscalationListRead) => Effect.Effect<EscalationListPage>;
    readonly get: (
      escalationId: EscalationId,
    ) => Effect.Effect<LabelledEscalation, EscalationNotFound>;
    /**
     * A person's answer: RulingGiven and its DecisionRecorded, together. Once
     * per escalation; the same key again answers the escalation as it stands,
     * and the same key with another body is an IdempotencyConflict.
     */
    readonly rule: (command: RulingCommand) => Effect.Effect<LabelledEscalation, RulingRefusal>;
  }
>()("keel/Escalations") {}
