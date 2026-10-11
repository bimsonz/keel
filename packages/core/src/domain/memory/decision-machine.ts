import { Result, Schema } from "effect";
import { readScope, scopeCovers } from "../coordination/index.ts";
import {
  type ChangeId,
  type Committed,
  type DecisionId,
  type EscalationId,
  IllegalTransition,
  type Instant,
  type NextAction,
} from "../kernel/index.ts";
import { DecisionStateRefused } from "./errors.ts";
import { DecisionOverruled, DecisionRecorded, DecisionSuperseded } from "./events.ts";
import type { Decision, EscalationState } from "./memory.ts";

/** The events the Subject DO commits for one decision. */
export const DecisionEvent = Schema.Union([
  DecisionRecorded,
  DecisionSuperseded,
  DecisionOverruled,
]);
export type DecisionEvent = typeof DecisionEvent.Type;

/**
 * What the Decision machine reads of an escalation, looked up by the owning
 * DO. Verification's `Escalation` state has this shape.
 */
export interface RulingFacts {
  readonly id: EscalationId;
  readonly state: EscalationState;
  readonly category: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly consequence: string;
  }[];
  readonly evidence: readonly { readonly class: string; readonly summary: string }[];
  readonly ruling?: { readonly option: string } | undefined;
}

export type DecisionCommand =
  /** Record the ruling on `facts.escalation`, over a scope in the proposition grammar (absent: everywhere). */
  | { readonly _tag: "Record"; readonly scope?: string }
  /** A later decision `by`, over `scope`, replaces this one. */
  | { readonly _tag: "Supersede"; readonly by: DecisionId; readonly scope?: string }
  /** An overrule request, escalated and ruled `overrule` (`facts.escalation`), replaces this one. */
  | { readonly _tag: "Overrule"; readonly by: DecisionId; readonly requestedBy: ChangeId };

export interface DecisionFacts {
  readonly now: Instant;
  readonly decisionId: DecisionId;
  readonly escalation?: RulingFacts;
}

export type DecisionRejection = DecisionStateRefused;

type Outcome = Result.Result<readonly DecisionEvent[], DecisionRejection>;

/** The option an escalation must be ruled with, under the category, for an overrule to stand (R6). */
export const OVERRULE = "overrule";

const readEscalations: NextAction = {
  kind: "read",
  title: "List the escalations, to find the ruling this needs",
  operationId: "Operator_listEscalations",
};

/** A scope a later decision must cover: same or wider (R4), unreadable never covers. */
const covers = (outer: string | undefined, inner: string | undefined): boolean => {
  const o = readScope(outer);
  const i = readScope(inner);
  return Result.isSuccess(o) && Result.isSuccess(i) && scopeCovers(o.success, i.success);
};

/**
 * Decides a command on a decision (docs/domain/state-machines.md § Decision).
 * A decision is recorded only from a ruled escalation, and its alternatives
 * are exactly the options the ruling did not choose.
 */
export const decideDecision = (
  state: Decision | undefined,
  command: DecisionCommand,
  facts: DecisionFacts,
): Outcome => {
  const refuse = (reason?: string): Outcome =>
    Result.fail(
      new DecisionStateRefused({
        decisionId: state?.id ?? facts.decisionId,
        ...(state === undefined ? {} : { state: state.state }),
        command: command._tag,
        ...(reason === undefined ? {} : { reason }),
        nextActions: [readEscalations],
      }),
    );
  const escalation = facts.escalation;
  if (state === undefined) {
    if (command._tag !== "Record") return refuse();
    const ruling = escalation?.state === "ruled" ? escalation.ruling : undefined;
    const chosen = escalation?.options.find((o) => o.id === ruling?.option);
    if (escalation === undefined || chosen === undefined) return refuse("escalation-not-ruled");
    return Result.succeed([
      DecisionRecorded.make({
        decisionId: facts.decisionId,
        escalationId: escalation.id,
        option: chosen.id,
        summary: chosen.label,
        ...(command.scope === undefined ? {} : { scope: command.scope }),
        evidence: escalation.evidence.map((e) => `${e.class}: ${e.summary}`),
        alternatives: escalation.options
          .filter((o) => o.id !== chosen.id)
          .map((o) => ({ option: o.id, reasonRejected: o.consequence })),
      }),
    ]);
  }
  const decision = state;
  switch (command._tag) {
    case "Record":
      return refuse();
    case "Supersede":
      if (decision.state !== "active") return refuse();
      return covers(command.scope, decision.scope)
        ? Result.succeed([DecisionSuperseded.make({ decisionId: decision.id, by: command.by })])
        : refuse("narrower-scope");
    case "Overrule":
      if (decision.state !== "active") return refuse();
      return escalation?.state === "ruled" &&
        escalation.category === "overrule-request" &&
        escalation.ruling?.option === OVERRULE
        ? Result.succeed([
            DecisionOverruled.make({
              decisionId: decision.id,
              by: command.by,
              requestedBy: command.requestedBy,
            }),
          ])
        : refuse("overrule-not-ruled");
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Decision | undefined, event: DecisionEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a decision ${state === undefined ? "not yet recorded" : state.state}`,
  );
};

/** Folds one committed event into the decision, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveDecision = (
  state: Decision | undefined,
  committed: Committed<DecisionEvent>,
): Decision => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "DecisionRecorded"
      ? {
          id: event.decisionId,
          escalationId: event.escalationId,
          option: event.option,
          summary: event.summary,
          ...(event.scope === undefined ? {} : { scope: event.scope }),
          evidence: event.evidence,
          alternatives: event.alternatives,
          decidedAt: committed.at,
          state: "active",
        }
      : illegal(state, event);
  }
  const decision = state;
  if (event.decisionId !== decision.id) return illegal(decision, event);
  switch (event._tag) {
    case "DecisionRecorded":
      return illegal(decision, event);
    case "DecisionSuperseded":
      return decision.state === "active"
        ? { ...decision, state: "superseded", endedBy: event.by }
        : illegal(decision, event);
    case "DecisionOverruled":
      return decision.state === "active"
        ? { ...decision, state: "overruled", endedBy: event.by }
        : illegal(decision, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a decision from its events in `seq` order. */
export const replayDecision = (events: readonly Committed<DecisionEvent>[]): Decision | undefined =>
  events.reduce<Decision | undefined>((state, event) => evolveDecision(state, event), undefined);
