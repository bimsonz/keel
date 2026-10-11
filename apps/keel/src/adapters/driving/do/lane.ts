import {
  laneHeard,
  laneProject,
  laneStep,
  recordVerdict,
} from "@keeltown/core/application/integration";
import type { EventEnvelope } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { type LaneServices, laneServices } from "../../../composition/do.ts";
import { LaneCodecs, type LaneRpc, RecordVerdictCommand } from "../../../rpc/lane.ts";
import { type AlarmRequest, scheduleAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The lane's own deadline: one debounced step, after every delivery and verdict. */
export const LANE_STEP = "lane step";
/** How long a step that failed (a defect: a binding or a member's DO was unreachable) waits before the next. */
const RETRY_MS = 10_000;

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
 * changes and TrunkAdvanced from the Trunk; each delivery only records state,
 * and the debounced `lane step` commits what follows. Repo-touching: callers
 * place it with the deployment's `locationHint`.
 */
export class LaneDO extends KeelObjectWith<LaneServices> implements Partial<LaneRpc> {
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
    if (Exit.isFailure(exit)) {
      console.error(`lane ${this.laneId} step failed, retrying`, Cause.pretty(exit.cause));
      await this.step(Date.now() + RETRY_MS);
    }
  }

  /** Arms the step: a debounce, so a burst of deliveries runs it once. */
  private step(at: number): Promise<void> {
    return scheduleAlarm(this.ctx.storage, { kind: "debounce", reason: LANE_STEP, at });
  }
}
