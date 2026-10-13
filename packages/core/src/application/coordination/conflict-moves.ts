import { Effect, Option, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  byAgent,
  ConflictId,
  type EventEnvelope,
  type Instant,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import { DecisionRecorded } from "../../domain/memory/index.ts";
import {
  type ConflictCommand,
  ConflictNotFound,
  type ConflictStateRefused,
  decideConflict,
  MoveRefused,
} from "../../domain/verification/index.ts";
import { commit, type Transaction, type Transition } from "../ports/commit.ts";
import {
  AgentDirectory,
  Clock,
  type ConflictView,
  EntityStore,
  EventOutbox,
  type FailedDraft,
  HumanGate,
  type ProbeCell,
  ProjectNamespaces,
  type ResolveCommand,
  type SubjectRef,
} from "../ports/index.ts";
import { subjectAddress } from "./change.ts";
import { askAbout, escalationIdOf } from "./escalations.ts";
import { changeParties } from "./party-conflicts.ts";
import {
  conflictRef,
  conflictView,
  ledgerStep,
  probeCellRan,
  probeDraftFailed,
  storedConflict,
  viewOf,
} from "./probe-ledger.ts";
import { holderAgent, type SubjectReaction } from "./subject.ts";

/** Whether the conflict's probe ended unprovable and its settle waits on an escalation. */
const awaitsEscalation = ({ conflict, probe }: ConflictView, now: Instant): boolean => {
  const settled = decideConflict(
    conflict,
    { _tag: "Settle" },
    { now, conflictId: conflict.id, ...(probe === undefined ? {} : { probe }) },
  );
  return (
    Result.isFailure(settled) &&
    settled.failure._tag === "ConflictStateRefused" &&
    settled.failure.reason === "escalation-required"
  );
};

/**
 * One move of the conflict's own machine as a commit's decision. The machine
 * refusing the move is the caller's to answer; anything else (the conflict
 * gone, its probe's machine) cannot come of a conflict move and is a defect.
 */
const conflictMove =
  (conflictId: ConflictId, command: ConflictCommand) =>
  (tx: Transaction): Result.Result<Transition<undefined>, ConflictStateRefused> => {
    const moved = ledgerStep(tx, conflictId, { _tag: "Conflict", command });
    if (Result.isSuccess(moved)) return Result.succeed({ drafts: moved.success, value: undefined });
    if (moved.failure._tag !== "ConflictStateRefused") throw moved.failure;
    return Result.fail(moved.failure);
  };

/**
 * Keel escalates on its own in one case: a conflict its probe could not
 * decide (unstable, or never drafted). The probe step has committed; this
 * raises the conflict's escalation in the project's namespace, asking the
 * sponsor of the premise holder's agent first, and then settles the conflict
 * with the escalation's id: ConflictEscalated `unprovable`.
 *
 * It reads the conflict as it stands, not what the step just did, so a
 * retried step finishes an escalation that was raised and never settled, and
 * a conflict that needs none is left alone. A project that belongs to no
 * namespace has nobody to ask: the conflict stays open.
 */
export const escalateUnprovable = Effect.fn("coordination/escalateUnprovable")(function* (
  at: SubjectRef,
  conflictId: ConflictId,
) {
  const store = yield* EntityStore;
  const view = viewOf(store, conflictId);
  if (view === undefined || !awaitsEscalation(view, yield* (yield* Clock).now)) return;
  const place = yield* (yield* ProjectNamespaces).byId(at.projectId);
  if (Option.isNone(place)) {
    yield* Effect.logWarning(
      `${conflictId} is unprovable and ${at.projectId} belongs to no namespace: nobody is asked`,
    );
    return;
  }
  const holder = view.conflict.premise?.holder;
  const agentId = holder === undefined ? undefined : holderAgent(store, holder);
  const agent =
    agentId === undefined
      ? undefined
      : Option.getOrUndefined(yield* (yield* AgentDirectory).findAgent(agentId));
  const escalationId = escalationIdOf(conflictId);
  yield* (yield* HumanGate)
    .raise({
      namespace: place.value.namespace,
      escalationId,
      project: at.projectId,
      sponsor: agent?.sponsor,
      raisedBy: subjectAddress(at.projectId, at.key),
      ask: askAbout(view, "unprovable"),
    })
    .pipe(Effect.orDie);
  yield* commit(
    {
      entity: conflictRef(conflictId),
      cause: `settle-escalated:${conflictId}`,
      project: at.projectId,
    },
    conflictMove(conflictId, { _tag: "Settle", escalationId }),
  ).pipe(
    // Settled meanwhile by another call of this step: the conflict is where this one was taking it.
    Effect.catchTag("ConflictStateRefused", () => Effect.void),
  );
});

/** `probeDraftFailed`, then the escalation an unprovable conflict needs: what the Subject DO runs. */
export const probeDraftFailedAt = Effect.fn("coordination/probeDraftFailedAt")(function* (
  at: SubjectRef,
  failed: FailedDraft,
) {
  yield* probeDraftFailed(at.projectId, failed);
  yield* escalateUnprovable(at, failed.conflictId);
  return yield* conflictView(failed.conflictId);
});

/** `probeCellRan`, then the escalation an unprovable conflict needs: what the Subject DO runs. */
export const probeCellRanAt = Effect.fn("coordination/probeCellRanAt")(function* (
  at: SubjectRef,
  cell: ProbeCell,
) {
  yield* probeCellRan(at.projectId, cell);
  yield* escalateUnprovable(at, cell.conflictId);
  return yield* conflictView(cell.conflictId);
});

const refused = (conflictId: ConflictId, reason: string) => new MoveRefused({ conflictId, reason });

/**
 * A party's move on a conflict of this subject. One move is built: `escalate`
 * puts a proven conflict to a person. It raises the conflict's escalation in
 * the project's namespace, asking the escalating agent's sponsor first, and
 * then commits ConflictEscalated `human-class` under the agent's own name, so
 * each party's Change DO parks where the machine parks it.
 *
 * A conflict already with a person answers as it stands: the other party's
 * escalate, or a retry, asks nobody twice. The same Idempotency-Key with
 * another body is an IdempotencyConflict. MoveRefused for a change that is no
 * party, a conflict the machine will not escalate from where it is, a project
 * that belongs to no namespace, and every move but `escalate`.
 */
export const resolveConflict = Effect.fn("coordination/resolveConflict")(function* (
  at: SubjectRef,
  command: ResolveCommand,
) {
  const { conflictId } = command;
  const store = yield* EntityStore;
  const view = viewOf(store, conflictId);
  if (view === undefined) return yield* new ConflictNotFound({ conflictId });
  if (command.move !== "escalate")
    return yield* refused(conflictId, `the move ${command.move} is not built yet`);
  if (!changeParties(view.conflict.parties).includes(command.changeId))
    return yield* refused(conflictId, `${command.changeId} is not a party to the conflict`);
  const entity = conflictRef(conflictId);
  const fingerprint = `${command.changeId}/${command.move}`;
  const prior = (yield* EventOutbox).committed(entity, command.idempotencyKey);
  if (prior !== undefined)
    return prior.fingerprint === fingerprint
      ? view
      : yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  if (view.conflict.state === "escalated") return view;
  const escalationId = escalationIdOf(conflictId);
  const escalate = { _tag: "Escalate", escalationId } as const;
  const now = yield* (yield* Clock).now;
  if (Result.isFailure(decideConflict(view.conflict, escalate, { now, conflictId })))
    return yield* refused(conflictId, `a ${view.conflict.state} conflict cannot be escalated`);
  const place = yield* (yield* ProjectNamespaces).byId(at.projectId);
  if (Option.isNone(place))
    return yield* refused(
      conflictId,
      "the project belongs to no namespace: there is nobody to ask",
    );
  yield* (yield* HumanGate)
    .raise({
      namespace: place.value.namespace,
      escalationId,
      project: at.projectId,
      sponsor: command.sponsor,
      raisedBy: subjectAddress(at.projectId, at.key),
      ask: askAbout(view, "human-class", command.note),
    })
    .pipe(Effect.orDie);
  yield* commit(
    {
      entity,
      cause: command.idempotencyKey,
      fingerprint,
      project: at.projectId,
      ...byAgent(command.agentId, command.run),
    },
    conflictMove(conflictId, escalate),
  ).pipe(
    // The other party's escalate committed while this one asked: the conflict is with a person either way.
    Effect.catchTag("ConflictStateRefused", (refusal) =>
      storedConflict(store, conflictId)?.state === "escalated"
        ? Effect.void
        : Effect.fail(
            refused(
              conflictId,
              refusal.reason ?? `a ${refusal.state} conflict cannot be escalated`,
            ),
          ),
    ),
  );
  return yield* conflictView(conflictId);
});

const decodeRecorded = Schema.decodeUnknownOption(DecisionRecorded);
const decodeConflictId = Schema.decodeUnknownOption(ConflictId);

/**
 * A Subject DO hears the decision a ruling recorded on an escalation it
 * raised, inside the transaction that receives it: the conflict the decision
 * is about resolves with that decision, ConflictResolved on the conflict's
 * own entity, and each party's Change DO hears it. The move is `escalate`:
 * what was ruled is on the decision. Keel resolves nothing a person did not
 * rule on: a decision of another escalation, or of a conflict that is not
 * with a person, commits nothing and is reported.
 */
export function hearDecision(
  tx: Transaction,
  projectId: ProjectId,
  event: EventEnvelope,
): SubjectReaction {
  const recorded = decodeRecorded(event.payload);
  if (event.type !== "DecisionRecorded" || Option.isNone(recorded)) return { drafts: [] };
  const { decisionId, escalationId } = recorded.value;
  const about = event.affected.find((ref) => ref.kind === "conflict");
  const conflictId = Option.getOrUndefined(decodeConflictId(about?.id));
  const conflict = conflictId === undefined ? undefined : storedConflict(tx.store, conflictId);
  if (conflictId === undefined || conflict === undefined)
    return { drafts: [], problems: [`${decisionId} names no conflict this subject hosts`] };
  if (conflict.escalationId !== escalationId)
    return {
      drafts: [],
      problems: [`${decisionId} rules on ${escalationId}, which is not ${conflictId}'s escalation`],
    };
  const resolved = ledgerStep(tx, conflictId, {
    _tag: "Conflict",
    command: { _tag: "Resolve", move: "escalate", decisionId },
  });
  return Result.isFailure(resolved)
    ? {
        drafts: [],
        problems: [`${decisionId} did not resolve ${conflictId}: ${resolved.failure._tag}`],
      }
    : { entity: conflictRef(conflictId), drafts: resolved.success, project: projectId };
}
