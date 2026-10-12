import {
  destroyLane,
  laneHeard,
  laneProject,
  laneStep,
  recordVerdict,
  reofferDue,
  reofferVerified,
} from "@keeltown/core/application/integration";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { REDELIVERY_CAP_MS, redeliveryDelay, type Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { type LaneServices, laneServices } from "../../../composition/do.ts";
import { LaneCodecs, type LaneRpc, RecordVerdictCommand } from "../../../rpc/lane.ts";
import { type AlarmRequest, cancelAlarm, scheduleAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The lane's own deadline: one debounced step, after every delivery and verdict. */
export const LANE_STEP = "lane step";
/** While its green batch waits on trunk, the lane re-offers the batch's BatchVerified. */
export const LANE_REOFFER = "lane reoffer";

const decodeVerdict = Schema.decodeUnknownEffect(RecordVerdictCommand);

/** A Lane DO is addressed as `lane:<projectId>:<name>`. */
const laneIdOf = (name: string | undefined): string => {
  if (name === undefined) throw new Error("a Lane DO is addressed as lane:<projectId>:<name>");
  laneProject(name);
  return name;
};

/**
 * The Lane DO (`lane:<projectId>:<name>`; L1's is `lane:<projectId>:main`):
 * the queue, and at L1 one batch of one in flight, decided by the domain's
 * Candidate machine. It hears ChangeQueued and ChangeRequeued from its
 * changes and TrunkAdvanced and PromotionDeclined from the Trunk; each
 * delivery only records state, and the debounced `lane step` commits what
 * follows. A step that fails (a defect: a binding or a member's DO was
 * unreachable) is retried 1 s·2ⁿ up to 60 s, as deliveries are (ADR 0009).
 * While a green batch has no answer from trunk, `lane reoffer` hands trunk
 * its BatchVerified again (30 s after it, then every 60 s). Once destroyed
 * it holds nothing and no deadline of its own, hears nothing and takes no
 * verdict.
 * Repo-touching: callers place it with the deployment's `locationHint`.
 */
export class LaneDO extends KeelObjectWith<LaneServices> implements Partial<LaneRpc> {
  /** Consecutive failed steps, for the backoff; an evicted object starts again at 1 s. */
  private failures = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(
      ctx,
      env,
      laneServices(env, () => laneProject(laneIdOf(ctx.id.name))),
    );
  }

  private get laneId(): string {
    return laneIdOf(this.ctx.id.name);
  }

  async recordVerdict(command: unknown) {
    const laneId = this.laneId;
    const program = decodeVerdict(command).pipe(
      Effect.orDie,
      Effect.flatMap((verdict) => recordVerdict(laneId, verdict)),
    );
    const answer = await this.answer(LaneCodecs.recordVerdict, program);
    await this.step(Date.now());
    return answer;
  }

  async destroy(by: string) {
    const answer = await this.answer(LaneCodecs.destroy, destroyLane(this.laneId, by));
    await cancelAlarm(this.ctx.storage, LANE_STEP);
    await cancelAlarm(this.ctx.storage, LANE_REOFFER);
    return answer;
  }

  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    return laneHeard(tx, this.laneId, event) ? { drafts: [] } : undefined;
  }

  override async receive(envelopes: unknown) {
    const answer = await super.receive(envelopes);
    await this.step(Date.now());
    return answer;
  }

  protected override async onDeadline(request: AlarmRequest): Promise<void> {
    if (request.reason === LANE_REOFFER) return this.reoffer();
    if (request.reason !== LANE_STEP) return super.onDeadline(request);
    const exit = await this.runtime.runPromiseExit(laneStep(this.laneId));
    if (Exit.isSuccess(exit)) {
      this.failures = 0;
      await this.armReoffer();
      return;
    }
    this.failures += 1;
    const delay = redeliveryDelay(this.failures);
    const line = `lane ${this.laneId} step failed ${this.failures}x, next in ${delay} ms`;
    // Below the cap a failure is expected to clear (a binding mid-deploy); at the cap a person should look.
    if (delay >= REDELIVERY_CAP_MS) console.error(line, Cause.pretty(exit.cause));
    else console.warn(line, Cause.pretty(exit.cause));
    await this.step(Date.now() + delay);
  }

  /** Hands trunk the green batch's BatchVerified again, logged; a failed delivery waits for the next re-offer. */
  private async reoffer(): Promise<void> {
    const offered = await this.runtime.runPromiseExit(
      Effect.flatMap(reofferVerified(this.laneId), (offer) =>
        offer === undefined
          ? Effect.succeed(undefined)
          : this.fanOut.deliver(offer.subscriber, [offer.envelope]).pipe(
              Effect.exit,
              Effect.map((delivered) => ({ offer, delivered })),
            ),
      ),
    );
    if (Exit.isFailure(offered))
      console.error(`lane ${this.laneId} could not re-offer`, Cause.pretty(offered.cause));
    else if (offered.value !== undefined) {
      const { offer, delivered } = offered.value;
      const outcome = Exit.isSuccess(delivered) ? "taken" : Cause.pretty(delivered.cause);
      console.warn(
        `lane ${this.laneId} re-offered ${offer.envelope.entity.id} to ${offer.subscriber} (#${offer.count}): ${outcome}`,
      );
    }
    await this.armReoffer();
  }

  /** Arms `lane reoffer` while a green batch waits on trunk, at the time its state gives, and clears it otherwise. */
  private async armReoffer(): Promise<void> {
    const due = await this.runtime.runPromise(reofferDue(this.laneId));
    if (due === undefined) await cancelAlarm(this.ctx.storage, LANE_REOFFER);
    else await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason: LANE_REOFFER, at: due });
  }

  /** Arms the step: a debounce, so a burst of deliveries runs it once. */
  private step(at: number): Promise<void> {
    return scheduleAlarm(this.ctx.storage, { kind: "debounce", reason: LANE_STEP, at });
  }
}
