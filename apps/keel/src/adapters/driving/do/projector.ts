import {
  conflictRecord,
  escalationView,
  foldViews,
  listChanges,
  listEscalations,
  listConflicts,
  probeConflict,
  readFeed,
  recordFeed,
  viewSnapshot,
} from "@keeltown/core/application/memory";
import { noteStanding, repairStandings } from "@keeltown/core/application/identity";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, type Stored, type Transaction } from "@keeltown/core/ports";
import { EscalationNotFound } from "@keeltown/core/domain/verification";
import { Effect, Schema } from "effect";
import { type ProjectorServices, projectorServices } from "../../../composition/do.ts";
import {
  ChangesRead,
  ConflictRead,
  ConflictsRead,
  EscalationRead,
  EscalationsRead,
  ProbeConflictRead,
  ProjectorCodecs,
  ProjectorRead,
  type ProjectorRpc,
  SnapshotRead,
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
    // The directory is for the standing repair: the AgentSession DO writes it inline, and this repeats it.
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
    return { drafts: [] };
  }

  /** Repeats each agent standing it received in the directory, once the receipt is committed (D1 is outside it). */
  protected override async received(): Promise<void> {
    await this.runtime.runPromise(repairStandings);
  }

  async read(request: typeof ProjectorRead.Encoded) {
    const waiters = this.waiters;
    const program = Schema.decodeUnknownEffect(ProjectorRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ cursor, limit, waitMs, project }) =>
        // A read by project waits for that project's next event: another's arrival re-reads and finds none.
        waiters.until(
          waitMs ?? 0,
          readFeed(cursor, limit, project),
          (page) => page.events.length > 0,
        ),
      ),
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
}
