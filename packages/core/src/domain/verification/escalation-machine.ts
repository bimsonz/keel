import { Result, Schema } from "effect";
import {
  type Committed,
  type DecisionId,
  type EntityRef,
  type EscalationId,
  IllegalTransition,
  type Instant,
  type NextAction,
} from "../kernel/index.ts";
import { RulingGiven } from "../memory/index.ts";
import type {
  Escalation,
  EscalationCategory,
  EscalationEvidence,
  EscalationOption,
} from "./escalation.ts";
import {
  EscalationNotFound,
  EscalationStateRefused,
  InvalidEscalation,
  RulingOptionUnknown,
} from "./errors.ts";
import { EscalationRaised, EscalationWidened, EscalationWithdrawn } from "./events.ts";

/** The events the owning DO commits for one escalation. */
export const EscalationEvent = Schema.Union([
  EscalationRaised,
  RulingGiven,
  EscalationWithdrawn,
  EscalationWidened,
]);
export type EscalationEvent = typeof EscalationEvent.Type;

/**
 * Raised by the DO that needs the answer; ruled by an operator through the
 * doorway; withdrawn by its owner; widened by its owner once the person asked
 * first has had their turn.
 */
export type EscalationCommand =
  | {
      readonly _tag: "Raise";
      readonly question: string;
      readonly options: readonly EscalationOption[];
      readonly about: EntityRef;
      readonly category: EscalationCategory;
      readonly evidence: readonly EscalationEvidence[];
      readonly precedents: readonly DecisionId[];
      readonly default: string;
    }
  | {
      readonly _tag: "Rule";
      readonly option: string;
      readonly by: string;
      readonly rationale?: string;
    }
  | { readonly _tag: "Withdraw"; readonly reason: string }
  | { readonly _tag: "Widen" };

/** Facts from I/O: the time, and the escalation this decision is about. */
export interface EscalationFacts {
  readonly now: Instant;
  readonly escalationId: EscalationId;
}

export type EscalationRejection =
  | EscalationNotFound
  | EscalationStateRefused
  | InvalidEscalation
  | RulingOptionUnknown;

type Decision = Result.Result<readonly EscalationEvent[], EscalationRejection>;

/** The doorway operation that rules on an escalation. */
const GIVE_RULING = "Operator_giveRuling";
const LIST = "Operator_listEscalations";

const listOpen: NextAction = {
  kind: "read",
  title: "List the open escalations",
  operationId: LIST,
  args: { state: "open" },
};

/** One next action per option the escalation offers, each ready to rule. */
export const rulingActions = (escalation: Escalation): readonly NextAction[] =>
  escalation.options.map((o) => ({
    kind: "call",
    title: `Rule "${o.label}"`,
    operationId: GIVE_RULING,
    args: { escalationId: escalation.id, option: o.id },
  }));

/** Why a Raise cannot stand, or undefined when it can. */
const invalid = (command: Extract<EscalationCommand, { _tag: "Raise" }>): string | undefined => {
  const ids = command.options.map((o) => o.id);
  if (ids.length < 2) return `an escalation offers at least 2 options, not ${ids.length}`;
  if (new Set(ids).size !== ids.length) return "two options share an id";
  if (!ids.includes(command.default)) return `the default ${command.default} is not an option`;
  return undefined;
};

/**
 * Decides a command on an escalation (docs/domain/state-machines.md § Escalation).
 * While open, its owner holds; nothing here applies the default.
 */
export const decideEscalation = (
  state: Escalation | undefined,
  command: EscalationCommand,
  facts: EscalationFacts,
): Decision => {
  const escalationId = facts.escalationId;
  if (state === undefined) {
    if (command._tag !== "Raise")
      return Result.fail(new EscalationNotFound({ escalationId, nextActions: [listOpen] }));
    const reason = invalid(command);
    if (reason !== undefined)
      return Result.fail(
        new InvalidEscalation({
          escalationId,
          reason,
          nextActions: [
            { kind: "call", title: "Raise it again with at least two distinct options" },
          ],
        }),
      );
    return Result.succeed([
      EscalationRaised.make({
        escalationId,
        question: command.question,
        options: command.options,
        about: command.about,
        category: command.category,
        evidence: command.evidence,
        precedents: command.precedents,
        default: command.default,
      }),
    ]);
  }
  const escalation = state;
  const refuse = (): Decision =>
    Result.fail(
      new EscalationStateRefused({
        escalationId: escalation.id,
        state: escalation.state,
        command: command._tag,
        nextActions: [
          {
            kind: "read",
            title: "Read the escalation's ruling",
            operationId: LIST,
            args: { state: escalation.state },
          },
        ],
      }),
    );
  switch (command._tag) {
    case "Raise":
      return refuse();
    case "Rule":
      if (escalation.state !== "open") return refuse();
      if (!escalation.options.some((o) => o.id === command.option))
        return Result.fail(
          new RulingOptionUnknown({
            escalationId: escalation.id,
            option: command.option,
            nextActions: rulingActions(escalation),
          }),
        );
      return Result.succeed([
        RulingGiven.make({
          escalationId: escalation.id,
          option: command.option,
          by: command.by,
          ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
        }),
      ]);
    case "Withdraw":
      return escalation.state === "open"
        ? Result.succeed([
            EscalationWithdrawn.make({ escalationId: escalation.id, reason: command.reason }),
          ])
        : refuse();
    case "Widen":
      if (escalation.state !== "open") return refuse();
      // Once: an escalation already widened stays as it is, and commits nothing.
      return Result.succeed(
        escalation.widenedAt === undefined
          ? [EscalationWidened.make({ escalationId: escalation.id })]
          : [],
      );
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Escalation | undefined, event: EscalationEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to an escalation ${state === undefined ? "not yet raised" : state.state}`,
  );
};

/** Folds one committed event into the escalation, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveEscalation = (
  state: Escalation | undefined,
  committed: Committed<EscalationEvent>,
): Escalation => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "EscalationRaised"
      ? {
          id: event.escalationId,
          state: "open",
          question: event.question,
          options: event.options,
          about: event.about,
          category: event.category,
          evidence: event.evidence,
          precedents: event.precedents,
          default: event.default,
          raisedAt: committed.at,
        }
      : illegal(state, event);
  }
  const escalation = state;
  if (event.escalationId !== escalation.id) return illegal(escalation, event);
  switch (event._tag) {
    case "EscalationRaised":
      return illegal(escalation, event);
    case "RulingGiven":
      return escalation.state === "open" && escalation.options.some((o) => o.id === event.option)
        ? {
            ...escalation,
            state: "ruled",
            ruling: {
              option: event.option,
              by: event.by,
              ...(event.rationale === undefined ? {} : { rationale: event.rationale }),
            },
          }
        : illegal(escalation, event);
    case "EscalationWithdrawn":
      return escalation.state === "open"
        ? { ...escalation, state: "withdrawn", withdrawnReason: event.reason }
        : illegal(escalation, event);
    case "EscalationWidened":
      return escalation.state === "open" && escalation.widenedAt === undefined
        ? { ...escalation, widenedAt: committed.at }
        : illegal(escalation, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds an escalation from its events in `seq` order. */
export const replayEscalation = (
  events: readonly Committed<EscalationEvent>[],
): Escalation | undefined =>
  events.reduce<Escalation | undefined>(
    (state, event) => evolveEscalation(state, event),
    undefined,
  );
