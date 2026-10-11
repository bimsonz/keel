import {
  laneHeard,
  laneProject,
  laneStep,
  recordVerdict,
} from "@keeltown/core/application/integration";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { REDELIVERY_CAP_MS, redeliveryDelay, type Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { type LaneServices, laneServices } from "../../../composition/do.ts";
import { LaneCodecs, type LaneRpc, RecordVerdictCommand } from "../../../rpc/lane.ts";
import { type AlarmRequest, scheduleAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The lane's own deadline: one debounced step, after every delivery and verdict. */
export const LANE_STEP = "lane step";

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

  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    return laneHeard(tx, this.laneId, event) ? { drafts: [] } : undefined;
  }

  override async receive(envelopes: unknown) {
    const answer = await super.receive(envelopes);
    await this.step(Date.now());
    return answer;
  }

  protected override async onDeadline(request: AlarmRequest): Promise<void> {
    if (request.reason !== LANE_STEP) return super.onDeadline(request);
    const exit = await this.runtime.runPromiseExit(laneStep(this.laneId));
    if (Exit.isSuccess(exit)) {
      this.failures = 0;
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

  /** Arms the step: a debounce, so a burst of deliveries runs it once. */
  private step(at: number): Promise<void> {
    return scheduleAlarm(this.ctx.storage, { kind: "debounce", reason: LANE_STEP, at });
  }
}
