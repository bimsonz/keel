import {
  adoptTrunk,
  DEBOUNCE_MS,
  deleteProjectRepos,
  destroyTrunk,
  finishUpstreamSync,
  flushTrunk,
  initializeTrunk,
  pushPromotion,
  type PushOutcome,
  resumeTrunk,
  seedTrunk,
  syncFromUpstream,
  cancelBatch,
  syncMirror,
  syncTrunk,
  takeTrunk,
  trunkHeard,
  trunkOf,
  trunkStanding,
} from "@keeltown/core/application/integration";
import { type Trunk, TrunkOrigin } from "@keeltown/core/domain/integration";
import {
  type CommandActor,
  CommitSha,
  type EventEnvelope,
  InstantSchema,
  ProjectId,
} from "@keeltown/core/kernel";
import {
  EntityStore,
  REDELIVERY_CAP_MS,
  redeliveryDelay,
  type Transaction,
} from "@keeltown/core/ports";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { BatchCancel, TrunkCodecs, type TrunkRpc } from "../../../rpc/trunk.ts";
import {
  type DurableObjectServices,
  type TrunkServices,
  trunkServices,
} from "../../../composition/do.ts";
import { armedAlarms, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

const decodeCancel = Schema.decodeSync(BatchCancel);

/** The trunk's own deadlines: the group-commit debounce, a push to retry, and the mirror to sync. */
export const TRUNK_DEBOUNCE = "trunk debounce";
export const TRUNK_PUSH = "trunk push";
export const MIRROR_SYNC = "mirror sync";
/** A destroyed project's repos to delete. */
export const TRUNK_DESTROY = "trunk destroy";
/** An open sync from upstream whose move has still to land. */
export const TRUNK_SYNC = "trunk sync";

/**
 * How long one of trunk's deadlines may run before it fails and is retried,
 * logged, like any other failure. A git or Artifacts call that never answers
 * ends here: on 15 Oct a mirror sync hung 408 s on Artifacts' git, and the
 * promotion due behind it in the same alarm waited 20 minutes.
 */
export const TRUNK_DEADLINE_MS = 120_000;

/** How long the mirror's sync steps aside for a promotion armed with it. */
export const MIRROR_AFTER_PROMOTION_MS = 1_000;

/**
 * How long after an advance the mirror's sync waits. The Lane offers the
 * next batch the moment it hears the advance, a few hundred milliseconds
 * later, so that batch's debounce is armed before the sync is due, and goes
 * first.
 */
export const MIRROR_AFTER_ADVANCE_MS = 5_000;

const decodeHead = Schema.decodeUnknownEffect(CommitSha);
const decodeInstant = Schema.decodeUnknownEffect(InstantSchema);
const decodeOrigin = Schema.decodeUnknownEffect(TrunkOrigin);
const decodeProject = Schema.decodeUnknownSync(ProjectId);

/** A Trunk DO is addressed as `trunk:<projectId>`. */
const projectOfName = (name: string | undefined): ProjectId => {
  if (name?.startsWith("trunk:") !== true)
    throw new Error("a Trunk DO is addressed as trunk:<projectId>");
  return decodeProject(name.slice("trunk:".length));
};

/** Where a trunk started, as it is answered: nothing for one with no head yet, or one that kept no origin. */
const startOf = (trunk: Trunk | undefined) =>
  trunk?.origin === undefined ? {} : { origin: trunk.origin };

/** What the RPC answers for a trunk. */
const statusOf = (trunk: Trunk) => ({
  head: trunk.head,
  promotion: trunk.phase,
  ...startOf(trunk),
});

/**
 * The Trunk DO (`trunk:<projectId>`): the one writer of trunk (ADR 0003),
 * decided by the domain's Promotion machine. Its state is folded from its own
 * events and the `BatchVerified` it receives. A delivery only queues the
 * batch; the debounce deadline decides the group and writes the WAL, then the
 * push and read-back run, every I/O before the commit it informs. A push to
 * retry and the mirror's sync after an advance are deadlines of their own;
 * a failing deadline is retried 1 s·2ⁿ up to 60 s. Once destroyed it takes
 * no batch, its promotion and sync deadlines do nothing, and it deletes its
 * project's repos on a deadline retried the same way until none is left.
 * Repo-touching: callers place it with the deployment's `locationHint`.
 */
export class TrunkDO extends KeelObjectWith<TrunkServices> implements TrunkRpc {
  /** Consecutive failures per deadline, for its backoff; an evicted object starts again at 1 s. */
  private readonly failures = new Map<string, number>();

  /** `TRUNK_DEADLINE_MS`; a pool test shortens it. */
  private deadlineMs = TRUNK_DEADLINE_MS;

  /** `MIRROR_AFTER_ADVANCE_MS`; a pool test shortens it. */
  private mirrorAfterAdvanceMs = MIRROR_AFTER_ADVANCE_MS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(
      ctx,
      env,
      trunkServices(env, () => projectOfName(ctx.id.name)),
    );
  }

  /** The project whose trunk this is, from the object's name. */
  private get projectId(): ProjectId {
    return projectOfName(this.ctx.id.name);
  }

  async status() {
    const projectId = this.projectId;
    const program = Effect.flatMap(EntityStore, (store) => {
      const trunk = trunkOf(store, projectId);
      return trunk === undefined
        ? Effect.die(new Error(`trunk ${projectId} is not initialized`))
        : Effect.succeed(statusOf(trunk));
    });
    return this.answer(TrunkCodecs.status, program);
  }

  async origin() {
    const projectId = this.projectId;
    return this.answer(
      TrunkCodecs.origin,
      Effect.map(EntityStore, (store) => startOf(trunkOf(store, projectId))),
    );
  }

  async view() {
    const program = Effect.map(
      trunkStanding(this.projectId),
      Option.match({ onNone: () => ({}), onSome: (trunk) => ({ trunk }) }),
    );
    return this.answer(TrunkCodecs.view, program);
  }

  async resume(by: CommandActor) {
    const answer = await this.answer(
      TrunkCodecs.resume,
      Effect.map(resumeTrunk(this.projectId, by), statusOf),
    );
    await this.debounceIfWaiting();
    return answer;
  }

  async initialize(head: string, by: string, origin: unknown) {
    const projectId = this.projectId;
    const program = Effect.all([decodeHead(head), decodeOrigin(origin)]).pipe(
      Effect.orDie,
      Effect.flatMap(([sha, from]) => initializeTrunk(projectId, sha, by, from)),
      Effect.map(statusOf),
    );
    return this.answer(TrunkCodecs.initialize, program);
  }

  async adopt(commit: string) {
    const projectId = this.projectId;
    const program = decodeHead(commit).pipe(
      Effect.orDie,
      Effect.flatMap((sha) => adoptTrunk(projectId, sha)),
    );
    return this.answer(TrunkCodecs.adopt, program);
  }

  async seed(name: string, at: number) {
    const projectId = this.projectId;
    const program = decodeInstant(at).pipe(
      Effect.orDie,
      Effect.flatMap((when) => seedTrunk(projectId, name, when)),
    );
    return this.answer(TrunkCodecs.seed, program);
  }

  async take(source: string) {
    const projectId = this.projectId;
    const program = Effect.sync(() => decodeProject(source)).pipe(
      Effect.flatMap((from) => takeTrunk(projectId, from)),
    );
    return this.answer(TrunkCodecs.take, program);
  }

  async sync() {
    return this.answer(TrunkCodecs.sync, syncTrunk(this.projectId));
  }

  async syncUpstream(by: CommandActor) {
    const answer = await this.answer(
      TrunkCodecs.syncUpstream,
      syncFromUpstream(this.projectId, by),
    );
    await this.afterSync();
    return answer;
  }

  async cancel(cancel: typeof BatchCancel.Encoded) {
    return this.answer(TrunkCodecs.cancel, cancelBatch(this.projectId, decodeCancel(cancel)));
  }

  async destroy(by: string) {
    const answer = await this.answer(TrunkCodecs.destroy, destroyTrunk(this.projectId, by));
    await scheduleAlarm(this.ctx.storage, {
      kind: "deadline",
      reason: TRUNK_DESTROY,
      at: Date.now(),
    });
    return answer;
  }

  /** A delivered BatchVerified joins the queue; redelivery is a no-op. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    return trunkHeard(tx, this.projectId, event) ? { drafts: [] } : undefined;
  }

  override async receive(envelopes: unknown) {
    const answer = await super.receive(envelopes);
    await this.debounceIfWaiting();
    return answer;
  }

  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    const projectId = this.projectId;
    const { reason } = request;
    if (reason === TRUNK_DESTROY) {
      const exit = await this.bounded(deleteProjectRepos(projectId));
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      if (exit.value.pending > 0)
        return this.retry(reason, `${exit.value.pending} repos still to delete`);
      this.failures.delete(reason);
      return;
    }
    if (reason === TRUNK_DEBOUNCE || reason === TRUNK_PUSH) {
      const program = Effect.gen(function* () {
        if (reason === TRUNK_DEBOUNCE) yield* flushTrunk(projectId);
        return yield* pushPromotion(projectId);
      });
      const exit = await this.bounded(program);
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      this.failures.delete(reason);
      await this.afterPush(exit.value);
      return;
    }
    if (reason === TRUNK_SYNC) {
      const exit = await this.bounded(finishUpstreamSync(projectId));
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      return this.afterSync();
    }
    if (reason === MIRROR_SYNC) {
      // A promotion armed goes first: a mirror that does not answer never holds trunk up.
      if (this.promotionArmed())
        return scheduleAlarm(this.ctx.storage, {
          kind: "deadline",
          reason,
          at: Date.now() + MIRROR_AFTER_PROMOTION_MS,
        });
      const exit = await this.bounded(syncMirror(projectId));
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      this.failures.delete(reason);
      return;
    }
    await super.onDeadline(request);
  }

  /** Runs one deadline's work, failing it once it has run `deadlineMs`. */
  private bounded<A, E, R extends DurableObjectServices | TrunkServices>(
    program: Effect.Effect<A, E, R>,
  ) {
    return this.runtime.runPromiseExit(program.pipe(Effect.timeout(this.deadlineMs)));
  }

  /** Whether trunk's debounce or a push to retry is armed, to run before the mirror's sync. */
  private promotionArmed(): boolean {
    return armedAlarms(this.ctx.storage).some(
      (armed) => armed.reason === TRUNK_DEBOUNCE || armed.reason === TRUNK_PUSH,
    );
  }

  /** What follows a push: the mirror after an advance, the same SHA again later, or a person told. */
  private async afterPush(outcome: PushOutcome): Promise<void> {
    const projectId = this.projectId;
    if (outcome === "retry") return this.retry(TRUNK_PUSH, "trunk still holds the WAL's old head");
    this.failures.delete(TRUNK_PUSH);
    if (outcome === "advanced")
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: MIRROR_SYNC,
        at: Date.now() + this.mirrorAfterAdvanceMs,
      });
    if (outcome === "frozen")
      console.error(`trunk ${projectId} froze promotion: its head is not one the WAL explains`);
    if (outcome === "declined")
      console.warn(`trunk ${projectId} declined its group: the pack is over the receive-pack cap`);
    await this.debounceIfWaiting();
  }

  /**
   * What follows a sync from upstream: its move again later while it is
   * open, and otherwise the mirror brought to trunk's head (a no-op when
   * nothing moved) and the debounce for batches that queued meanwhile.
   * Staging is the Lane's to move: it hears TrunkSynced.
   */
  private async afterSync(): Promise<void> {
    const projectId = this.projectId;
    const trunk = await this.runtime.runPromise(
      Effect.map(EntityStore, (store) => trunkOf(store, projectId)),
    );
    if (trunk?.phase === "syncing")
      return this.retry(TRUNK_SYNC, "trunk's main is still at the sync's start");
    this.failures.delete(TRUNK_SYNC);
    if (trunk?.phase === "frozen")
      console.error(
        `trunk ${projectId} froze promotion: its head is not the one its sync moved to`,
      );
    else
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: MIRROR_SYNC,
        at: Date.now(),
      });
    await this.debounceIfWaiting();
  }

  /** Re-arms a deadline after 1 s·2ⁿ, up to 60 s; once at the cap every failure is logged as an error. */
  private async retry(reason: string, why: string): Promise<void> {
    const failures = (this.failures.get(reason) ?? 0) + 1;
    this.failures.set(reason, failures);
    const delay = redeliveryDelay(failures);
    const line = `trunk ${this.projectId}: ${reason} failed ${failures}x, next in ${delay} ms: ${why}`;
    if (delay >= REDELIVERY_CAP_MS) console.error(line);
    else console.warn(line);
    await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason, at: Date.now() + delay });
  }

  /** Arms the group-commit debounce while batches wait for one. */
  private async debounceIfWaiting(): Promise<void> {
    const projectId = this.projectId;
    const trunk = await this.runtime.runPromise(
      Effect.map(EntityStore, (store) => trunkOf(store, projectId)),
    );
    if (trunk?.phase === "debouncing")
      await scheduleAlarm(this.ctx.storage, {
        kind: "debounce",
        reason: TRUNK_DEBOUNCE,
        at: Date.now() + DEBOUNCE_MS,
      });
  }
}
