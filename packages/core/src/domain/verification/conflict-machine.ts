import { Result, Schema } from "effect";
import {
  type BatchId,
  type Committed,
  type ConflictId,
  type DecisionId,
  type EscalationId,
  type GuardId,
  IllegalTransition,
  type Instant,
  type NextAction,
  type SubjectId,
} from "../kernel/index.ts";
import { compare, type Move, type Predicate, type Proposition } from "../coordination/index.ts";
import type { Conflict, ConflictKind, ConflictOrigin, Party, World } from "./conflict.ts";
import { ConflictNotFound, ConflictStateRefused } from "./errors.ts";
import {
  ConflictDismissed,
  ConflictEscalated,
  ConflictProven,
  ConflictResolved,
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  WorldCheckRan,
} from "./events.ts";
import type { Probe } from "./probe.ts";

/**
 * The events a conflict folds: its own, the two probe events it moves on
 * (`ProbeDrafted`, `ProbeRan`), which its probe commits in the same DO, and
 * the suite cells of its world matrix (`WorldCheckRan`).
 */
export const ConflictEvent = Schema.Union([
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  WorldCheckRan,
  ConflictProven,
  ConflictDismissed,
  ConflictEscalated,
  ConflictResolved,
]);
export type ConflictEvent = typeof ConflictEvent.Type;

/** Proof that needs no probe, by kind: a refused merge, a failing guard, or a batch whose union fails while every subset passes. */
export type ProofWithoutProbe =
  | { readonly _tag: "merge-refused"; readonly batchId: BatchId }
  | { readonly _tag: "guard"; readonly guardId: GuardId }
  | { readonly _tag: "interaction"; readonly batchId: BatchId };

export type ConflictCommand =
  | {
      readonly _tag: "Suspect";
      readonly kind: ConflictKind;
      readonly parties: readonly Party[];
      readonly subjectId?: SubjectId;
      readonly predicate?: Predicate;
      readonly origin?: ConflictOrigin;
    }
  | { readonly _tag: "Prove"; readonly evidence: ProofWithoutProbe }
  /** A ruling: `decide` compares the two itself, and only a compatible or refining effect dismisses. */
  | { readonly _tag: "Dismiss"; readonly premise: Proposition; readonly effect: Proposition }
  /** React to the conflict's probe (in `facts.probe`) once it is admitted or discarded. */
  | { readonly _tag: "Settle"; readonly escalationId: EscalationId }
  /** The conflict is human-class: permission semantics, a destructive migration, an ambiguous requirement. */
  | { readonly _tag: "Escalate"; readonly escalationId: EscalationId }
  | { readonly _tag: "Resolve"; readonly move: Move; readonly decisionId?: DecisionId }
  /** A project suite's cell in the world matrix, recorded while the conflict's probe runs. */
  | {
      readonly _tag: "RecordCheck";
      readonly world: World;
      readonly check: string;
      readonly run: number;
      readonly outcome: "pass" | "fail" | "n/a";
      readonly counts?: {
        readonly passed: number;
        readonly failed: number;
        readonly skipped: number;
      };
      readonly reason?: string;
    };

/** Facts from I/O: the time, the conflict this decision is about, and its probe as the owning DO holds it. */
export interface ConflictFacts {
  readonly now: Instant;
  readonly conflictId: ConflictId;
  readonly probe?: Probe;
}

export type ConflictRejection = ConflictNotFound | ConflictStateRefused;

type Decision = Result.Result<readonly ConflictEvent[], ConflictRejection>;

const readFirst: NextAction = {
  kind: "read",
  title: "Read the conflict: its state decides which move applies",
};
const awaitProbe: NextAction = {
  kind: "wait",
  title:
    "Wait for the conflict's probe: only a discriminating probe proves it, and only a non-discriminating one dismisses it",
};
const askAPerson: NextAction = {
  kind: "escalate",
  title: "Escalate to a person: only a ruling resolves an escalated conflict",
};

/** The suite cell already recorded at the same world, check and run, if any. */
const sameCell = (
  conflict: Conflict,
  cell: { readonly world: World; readonly check: string; readonly run: number },
) =>
  conflict.checks?.find(
    (c) => c.world === cell.world && c.check === cell.check && c.run === cell.run,
  );

/** Which proof settles which kind without a probe; semantic and precedent-at-risk conflicts need one. */
const provesKind: Readonly<Record<ProofWithoutProbe["_tag"], ConflictKind>> = {
  "merge-refused": "textual",
  guard: "precedent",
  interaction: "interaction",
};

/** A suspicion as the owning DO may open it: subject-owned kinds carry their subject, lane-owned kinds none. */
const suspicionFault = (
  command: Extract<ConflictCommand, { _tag: "Suspect" }>,
): string | undefined => {
  if (command.parties.length === 0) return "no-parties";
  if (new Set(command.parties).size !== command.parties.length) return "party-twice";
  const subjectOwned = command.kind === "semantic" || command.kind === "precedent";
  if (subjectOwned !== (command.subjectId !== undefined)) return "subject-mismatch";
  if (command.kind === "semantic" && command.predicate === undefined) return "no-predicate";
  // A decision model only ever suspects a semantic disagreement.
  if (command.origin === "opinion" && command.kind !== "semantic") return "opinion-not-semantic";
  return undefined;
};

/**
 * Decides a command on a conflict (docs/domain/state-machines.md § Conflict).
 * Only proof or a ruling reaches Proven or Dismissed: proof without a probe
 * of the kind's own sort, an admitted probe, a lattice comparison this
 * function runs itself, or a probe that never discriminates. An unprovable
 * conflict escalates; it never blocks on opinion.
 */
export const decideConflict = (
  state: Conflict | undefined,
  command: ConflictCommand,
  facts: ConflictFacts,
): Decision => {
  if (state === undefined) {
    if (command._tag !== "Suspect")
      return Result.fail(new ConflictNotFound({ conflictId: facts.conflictId }));
    const fault = suspicionFault(command);
    return fault === undefined
      ? Result.succeed([
          ConflictSuspected.make({
            conflictId: facts.conflictId,
            kind: command.kind,
            parties: command.parties,
            ...(command.subjectId === undefined ? {} : { subjectId: command.subjectId }),
            ...(command.predicate === undefined ? {} : { predicate: command.predicate }),
            ...(command.origin === undefined ? {} : { origin: command.origin }),
          }),
        ])
      : Result.fail(
          new ConflictStateRefused({
            conflictId: facts.conflictId,
            command: command._tag,
            reason: fault,
            nextActions: [readFirst],
          }),
        );
  }
  const conflict = state;
  const refuse = (reason?: string, next: NextAction = readFirst): Decision =>
    Result.fail(
      new ConflictStateRefused({
        conflictId: conflict.id,
        state: conflict.state,
        command: command._tag,
        ...(reason === undefined ? {} : { reason }),
        nextActions: [next],
      }),
    );
  const open = conflict.state === "suspected" || conflict.state === "probing";
  switch (command._tag) {
    case "Suspect":
      return refuse();
    case "Prove":
      if (conflict.state !== "suspected") return refuse();
      return provesKind[command.evidence._tag] === conflict.kind
        ? Result.succeed([
            ConflictProven.make({ conflictId: conflict.id, evidence: command.evidence }),
          ])
        : refuse("proof-of-another-kind", awaitProbe);
    case "Dismiss": {
      if (conflict.state !== "suspected") return refuse();
      // A refused merge or a failing union has no propositions to compare.
      if (conflict.subjectId === undefined) return refuse("no-propositions", awaitProbe);
      // Over an opinion-derived effect the comparison is tainted: it is not a ruling.
      if (conflict.origin === "opinion") return refuse("opinion-is-not-a-ruling", awaitProbe);
      if (conflict.predicate !== undefined && command.premise.predicate !== conflict.predicate)
        return refuse("another-predicate");
      const { outcome } = compare(command.premise, command.effect);
      return outcome === "compatible" || outcome === "refines"
        ? Result.succeed([
            ConflictDismissed.make({ conflictId: conflict.id, evidence: `lattice:${outcome}` }),
          ])
        : refuse(`lattice:${outcome}`, awaitProbe);
    }
    case "Settle": {
      const probe = facts.probe;
      if (!open) return refuse();
      if (
        probe === undefined ||
        probe.conflictId !== conflict.id ||
        (conflict.probeId !== undefined && probe.id !== conflict.probeId)
      )
        return refuse("no-probe-of-this-conflict");
      const drafted = conflict.state === "probing";
      if (probe.state === "admitted" && drafted)
        return Result.succeed([
          ConflictProven.make({
            conflictId: conflict.id,
            evidence: { _tag: "probe", probeId: probe.id },
          }),
        ]);
      if (probe.state === "discarded" && probe.discarded === "non-discriminating" && drafted)
        return Result.succeed([
          ConflictDismissed.make({
            conflictId: conflict.id,
            evidence: `probe:${probe.id}:non-discriminating`,
          }),
        ]);
      const unprovable =
        (probe.state === "discarded" && probe.discarded === "unstable" && drafted) ||
        (probe.state === "discarded" && probe.discarded === "draft-failed" && !drafted);
      return unprovable
        ? Result.succeed([
            ConflictEscalated.make({
              conflictId: conflict.id,
              escalationId: command.escalationId,
              reason: "unprovable",
            }),
          ])
        : refuse("probe-pending", awaitProbe);
    }
    case "Escalate":
      return conflict.state === "proven"
        ? Result.succeed([
            ConflictEscalated.make({
              conflictId: conflict.id,
              escalationId: command.escalationId,
              reason: "human-class",
            }),
          ])
        : refuse();
    case "Resolve": {
      const ruled = conflict.state === "escalated" && command.decisionId !== undefined;
      if (conflict.state === "escalated" && !ruled) return refuse("no-ruling", askAPerson);
      return conflict.state === "proven" || ruled
        ? Result.succeed([
            ConflictResolved.make({
              conflictId: conflict.id,
              move: command.move,
              ...(command.decisionId === undefined ? {} : { decisionId: command.decisionId }),
            }),
          ])
        : refuse();
    }
    case "RecordCheck": {
      if (conflict.state !== "probing") return refuse(undefined, awaitProbe);
      const cell = {
        conflictId: conflict.id,
        world: command.world,
        check: command.check,
        run: command.run,
        outcome: command.outcome,
        ...(command.counts === undefined ? {} : { counts: command.counts }),
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      };
      if (!Schema.is(WorldCheckRan)({ _tag: "WorldCheckRan", ...cell }))
        return refuse("malformed-check");
      const recorded = sameCell(conflict, command);
      // A repeated cell is idempotent; a cell that changes its answer is refused.
      if (recorded !== undefined)
        return recorded.outcome === command.outcome ? Result.succeed([]) : refuse("cell-recorded");
      return Result.succeed([WorldCheckRan.make(cell)]);
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Conflict | undefined, event: ConflictEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a conflict ${state === undefined ? "not yet suspected" : state.state}`,
  );
};

/** Folds one committed event into the conflict, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveConflict = (
  state: Conflict | undefined,
  committed: Committed<ConflictEvent>,
): Conflict => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "ConflictSuspected"
      ? {
          id: event.conflictId,
          kind: event.kind,
          state: "suspected",
          parties: event.parties,
          ...(event.subjectId === undefined ? {} : { subjectId: event.subjectId }),
          ...(event.predicate === undefined ? {} : { predicate: event.predicate }),
          ...(event.origin === undefined ? {} : { origin: event.origin }),
          openedAt: committed.at,
        }
      : illegal(state, event);
  }
  const conflict = state;
  if (event.conflictId !== conflict.id) return illegal(conflict, event);
  switch (event._tag) {
    case "ConflictSuspected":
      return illegal(conflict, event);
    case "ProbeDrafted":
      return conflict.state === "suspected"
        ? { ...conflict, state: "probing", probeId: event.probeId }
        : illegal(conflict, event);
    case "ProbeRan":
      return conflict.state === "probing" && event.probeId === conflict.probeId
        ? { ...conflict }
        : illegal(conflict, event);
    case "WorldCheckRan":
      return conflict.state === "probing" && sameCell(conflict, event) === undefined
        ? {
            ...conflict,
            checks: [
              ...(conflict.checks ?? []),
              { world: event.world, check: event.check, run: event.run, outcome: event.outcome },
            ],
          }
        : illegal(conflict, event);
    case "ConflictProven": {
      const proof = event.evidence;
      const ok =
        proof._tag === "probe"
          ? conflict.state === "probing" && proof.probeId === conflict.probeId
          : conflict.state === "suspected" && provesKind[proof._tag] === conflict.kind;
      return ok ? { ...conflict, state: "proven" } : illegal(conflict, event);
    }
    case "ConflictDismissed":
      return conflict.state === "suspected" || conflict.state === "probing"
        ? { ...conflict, state: "dismissed" }
        : illegal(conflict, event);
    case "ConflictEscalated": {
      const ok =
        event.reason === "unprovable"
          ? conflict.state === "suspected" || conflict.state === "probing"
          : conflict.state === "proven";
      return ok
        ? { ...conflict, state: "escalated", escalationId: event.escalationId }
        : illegal(conflict, event);
    }
    case "ConflictResolved": {
      const ok =
        conflict.state === "proven" ||
        (conflict.state === "escalated" && event.decisionId !== undefined);
      return ok
        ? {
            ...conflict,
            state: "resolved",
            move: event.move,
            ...(event.decisionId === undefined ? {} : { decisionId: event.decisionId }),
          }
        : illegal(conflict, event);
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a conflict from its events in `seq` order. */
export const replayConflict = (events: readonly Committed<ConflictEvent>[]): Conflict | undefined =>
  events.reduce<Conflict | undefined>((state, event) => evolveConflict(state, event), undefined);
