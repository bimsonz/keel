import {
  DEBOUNCE_MS,
  flushTrunk,
  initializeTrunk,
  pushPromotion,
  type PushOutcome,
  resumeTrunk,
  syncMirror,
  syncTrunk,
  trunkHeard,
  trunkOf,
} from "@keeltown/core/application/integration";
import type { Trunk } from "@keeltown/core/domain/integration";
import { CommitSha, type EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import {
  EntityStore,
  REDELIVERY_CAP_MS,
  redeliveryDelay,
  type Transaction,
} from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { TrunkCodecs, type TrunkRpc } from "../../../rpc/trunk.ts";
import { type TrunkServices, trunkServices } from "../../../composition/do.ts";
import { type AlarmRequest, scheduleAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The trunk's own deadlines: the group-commit debounce, a push to retry, and the mirror to sync. */
export const TRUNK_DEBOUNCE = "trunk debounce";
export const TRUNK_PUSH = "trunk push";
export const MIRROR_SYNC = "mirror sync";

const decodeHead = Schema.decodeUnknownEffect(CommitSha);
const decodeProject = Schema.decodeUnknownSync(ProjectId);

/** A Trunk DO is addressed as `trunk:<projectId>`. */
const projectOfName = (name: string | undefined): ProjectId => {
  if (name?.startsWith("trunk:") !== true)
    throw new Error("a Trunk DO is addressed as trunk:<projectId>");
  return decodeProject(name.slice("trunk:".length));
};

/** What the RPC answers for a trunk. No Auditor runs before L4, so nothing is red yet. */
const statusOf = (trunk: Trunk) => ({ head: trunk.head, promotion: trunk.phase, redCount: 0 });

/**
 * The Trunk DO (`trunk:<projectId>`): the one writer of trunk (ADR 0003),
 * decided by the domain's Promotion machine. Its state is folded from its own
 * events and the `BatchVerified` it receives. A delivery only queues the
 * batch; the debounce deadline decides the group and writes the WAL, then the
 * push and read-back run, every I/O before the commit it informs. A push to
 * retry and the mirror's sync after an advance are deadlines of their own;
 * a failing deadline is retried 1 s·2ⁿ up to 60 s. Repo-touching: callers
 * place it with the deployment's `locationHint`.
 */
export class TrunkDO extends KeelObjectWith<TrunkServices> implements TrunkRpc {
  /** Consecutive failures per deadline, for its backoff; an evicted object starts again at 1 s. */
  private readonly failures = new Map<string, number>();

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

  async resume(by: string) {
    const answer = await this.answer(
      TrunkCodecs.resume,
      Effect.map(resumeTrunk(this.projectId, by), statusOf),
    );
    await this.debounceIfWaiting();
    return answer;
  }

  async initialize(head: string, by: string) {
    const projectId = this.projectId;
    const program = decodeHead(head).pipe(
      Effect.orDie,
      Effect.flatMap((sha) => initializeTrunk(projectId, sha, by)),
      Effect.map(statusOf),
    );
    return this.answer(TrunkCodecs.initialize, program);
  }

  async sync() {
    return this.answer(TrunkCodecs.sync, syncTrunk(this.projectId));
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

  protected override async onDeadline(request: AlarmRequest): Promise<void> {
    const projectId = this.projectId;
    const { reason } = request;
    if (reason === TRUNK_DEBOUNCE || reason === TRUNK_PUSH) {
      const program = Effect.gen(function* () {
        if (reason === TRUNK_DEBOUNCE) yield* flushTrunk(projectId);
        return yield* pushPromotion(projectId);
      });
      const exit = await this.runtime.runPromiseExit(program);
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      this.failures.delete(reason);
      await this.afterPush(exit.value);
      return;
    }
    if (reason === MIRROR_SYNC) {
      const exit = await this.runtime.runPromiseExit(syncMirror(projectId));
      if (Exit.isFailure(exit)) return this.retry(reason, Cause.pretty(exit.cause));
      this.failures.delete(reason);
      return;
    }
    await super.onDeadline(request);
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
        at: Date.now(),
      });
    if (outcome === "frozen")
      console.error(`trunk ${projectId} froze promotion: its head is not one the WAL explains`);
    if (outcome === "too-large")
      console.error(`trunk ${projectId} cannot push its open group: the pack is over the cap`);
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
