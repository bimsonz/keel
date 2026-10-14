import {
  changeView,
  conflictRecord,
  decisionsAtPath,
  decisionsOfGuards,
  decisionsOnSubjects,
  escalationView,
  foldViews,
  listChanges,
  listEscalations,
  listConflicts,
  probeConflict,
  FEED_END,
  getDecision,
  listDecisions,
  readFeed,
  recordFeed,
  viewSnapshot,
} from "@keeltown/core/application/memory";
import {
  noteInvitation,
  noteStanding,
  repairInvitations,
  repairStandings,
} from "@keeltown/core/application/identity";
import { noteVisibility, repairVisibility } from "@keeltown/core/application/integration";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, type Stored, type Transaction } from "@keeltown/core/ports";
import { EscalationNotFound } from "@keeltown/core/domain/verification";
import { Effect, Schema } from "effect";
import { type ProjectorServices, projectorServices } from "../../../composition/do.ts";
import {
  ChangeRead,
  ChangesRead,
  ConflictRead,
  ConflictsRead,
  DecisionRead,
  DecisionsRead,
  EscalationRead,
  EscalationsRead,
  GuardDecisionsRead,
  PathDecisionsRead,
  ProbeConflictRead,
  ProjectorCodecs,
  ProjectorRead,
  type ProjectorRpc,
  SnapshotRead,
  SubjectDecisionsRead,
} from "../../../rpc/index.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** Where the Projector counts the nudges it has had. */
export const NUDGES = { kind: "projector", id: "nudges" } as const;

/**
 * The Projector DO: every event Keel commits arrives here and joins the feed,
 * which the console reads. It drains the operation log into read models when
 * nudged; every outbox flush nudges it, the one sanctioned exception to
 * "nothing polls". Until the operation log exists a nudge only counts
 * itself. It does not deliver to itself.
 */
export class ProjectorDO extends KeelObjectWith<ProjectorServices> implements ProjectorRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    // The directory and the places are for the repairs: the AgentSession and Project DOs write them inline, and this repeats it.
    super(ctx, env, projectorServices(env), { projected: false });
  }

  async nudge() {
    const program = Effect.gen(function* () {
      const store = yield* EntityStore;
      store.transaction(() => {
        const seen: Stored = store.get(NUDGES.kind, NUDGES.id) ?? 0;
        store.put(NUDGES.kind, NUDGES.id, (typeof seen === "number" ? seen : 0) + 1);
      });
      return { drained: 0 };
    });
    return this.answer(ProjectorCodecs.nudge, program);
  }

  /**
   * Every arrival joins the feed, then the read models beside it, in the
   * receipt's transaction: the receipt's dedupe makes a redelivery a no-op,
   * and `answer` wakes any reader. An event a read model cannot take stays in
   * the feed and is logged here.
   */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction {
    recordFeed(tx.store, event);
    const skipped = foldViews(tx.store, event);
    if (skipped !== undefined) console.warn("projector read model skipped an event", skipped);
    noteStanding(tx.store, event);
    noteVisibility(tx.store, event);
    noteInvitation(tx.store, event);
    return { drafts: [] };
  }

  /** Repeats each agent standing it received in the directory, and each project's visibility in its place, once the receipt is committed (D1 is outside it). */
  protected override async received(): Promise<void> {
    await this.runtime.runPromise(repairStandings);
    await this.runtime.runPromise(repairVisibility);
    await this.runtime.runPromise(repairInvitations);
  }

  async read(request: typeof ProjectorRead.Encoded) {
    const waiters = this.waiters;
    const program = Schema.decodeUnknownEffect(ProjectorRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ cursor, limit, waitMs, project }) => {
        // A read by project waits for that project's next event: another's arrival re-reads and finds none.
        const from = (after: string | undefined) =>
          waiters.until(
            waitMs ?? 0,
            readFeed(after, limit, project),
            (page) => page.events.length > 0,
          );
        // `end` is where the feed is now: found once, and a read that waits reads on from there.
        return cursor === FEED_END && (waitMs ?? 0) > 0
          ? readFeed(FEED_END, limit, project).pipe(Effect.flatMap((end) => from(end.cursor)))
          : from(cursor);
      }),
    );
    return this.answer(ProjectorCodecs.read, program);
  }

  async changes(request: typeof ChangesRead.Encoded) {
    const program = Schema.decodeUnknownEffect(ChangesRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(listChanges),
    );
    return this.answer(ProjectorCodecs.changes, program);
  }

  async snapshot(request: typeof SnapshotRead.Encoded) {
    const program = Schema.decodeUnknownEffect(SnapshotRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project }) => viewSnapshot(project)),
    );
    return this.answer(ProjectorCodecs.snapshot, program);
  }

  async change(request: typeof ChangeRead.Encoded) {
    const program = Schema.decodeUnknownEffect(ChangeRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, changeId }) => changeView(project, changeId)),
    );
    return this.answer(ProjectorCodecs.change, program);
  }

  async conflicts(request: typeof ConflictsRead.Encoded) {
    const program = Schema.decodeUnknownEffect(ConflictsRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(listConflicts),
    );
    return this.answer(ProjectorCodecs.conflicts, program);
  }

  async conflict(request: typeof ConflictRead.Encoded) {
    const program = Schema.decodeUnknownEffect(ConflictRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, conflictId }) => conflictRecord(project, conflictId)),
    );
    return this.answer(ProjectorCodecs.conflict, program);
  }

  async probeConflict(request: typeof ProbeConflictRead.Encoded) {
    const program = Schema.decodeUnknownEffect(ProbeConflictRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, probeId }) => probeConflict(project, probeId)),
    );
    return this.answer(ProjectorCodecs.probeConflict, program);
  }

  async escalations(request: typeof EscalationsRead.Encoded) {
    const program = Effect.gen(function* () {
      const read = yield* Effect.orDie(Schema.decodeUnknownEffect(EscalationsRead)(request));
      return listEscalations(yield* EntityStore, read);
    });
    return this.answer(ProjectorCodecs.escalations, program);
  }

  async escalation(request: typeof EscalationRead.Encoded) {
    const program = Effect.gen(function* () {
      const { escalationId } = yield* Effect.orDie(
        Schema.decodeUnknownEffect(EscalationRead)(request),
      );
      const record = escalationView(yield* EntityStore, escalationId);
      return record === undefined
        ? yield* new EscalationNotFound({ escalationId, nextActions: [] })
        : record;
    });
    return this.answer(ProjectorCodecs.escalation, program);
  }

  async decision(request: typeof DecisionRead.Encoded) {
    const program = Schema.decodeUnknownEffect(DecisionRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ decisionId }) => getDecision(decisionId)),
    );
    return this.answer(ProjectorCodecs.decision, program);
  }

  async decisions(request: typeof DecisionsRead.Encoded) {
    const program = Schema.decodeUnknownEffect(DecisionsRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(listDecisions),
    );
    return this.answer(ProjectorCodecs.decisions, program);
  }

  async guardDecisions(request: typeof GuardDecisionsRead.Encoded) {
    const program = Schema.decodeUnknownEffect(GuardDecisionsRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, guardIds }) => decisionsOfGuards(project, guardIds)),
    );
    return this.answer(ProjectorCodecs.guardDecisions, program);
  }

  async subjectDecisions(request: typeof SubjectDecisionsRead.Encoded) {
    const program = Schema.decodeUnknownEffect(SubjectDecisionsRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, subjects }) => decisionsOnSubjects(project, subjects)),
    );
    return this.answer(ProjectorCodecs.subjectDecisions, program);
  }

  async pathDecisions(request: typeof PathDecisionsRead.Encoded) {
    const program = Schema.decodeUnknownEffect(PathDecisionsRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ project, path }) => decisionsAtPath(project, path)),
    );
    return this.answer(ProjectorCodecs.pathDecisions, program);
  }
}
