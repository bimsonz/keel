import type { WorkflowPoolRpc } from "../../../rpc/workflow-pool.ts";
import { cancelAlarm, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObject } from "./keel-object.ts";
import {
  added,
  claim,
  current,
  EMPTY_POOL,
  nextDeadline,
  type PoolState,
  toStart,
  warmTarget,
} from "./workflow-pool-rules.ts";

/** Where the pool keeps its warm instances. */
const STATE = "pool";

/** Where the pool keeps its claims, one row each, by event id. */
const CLAIMS = "workflow_pool_claims";

/** The alarm reason of the pool's deadline: its first warm instance stops being handed out. */
const TOP_UP = "the pool's first warm instance nears its end";

/** The alarm reason that forgets claims: the oldest kept claim's memory ends. */
const FORGET = "the pool's oldest kept claim is forgotten";

/** The params a warm instance is created with: it waits for its claim's event for its input. */
export const POOLED = { pooled: true } as const;

/** The Workflow a pool keeps warm, by the name its object is under (`pool:<Name>`), and how many it keeps. */
function pooledWorkflow(
  env: Env,
  name: string | undefined,
): { readonly workflow: Workflow; readonly target: number } | undefined {
  return name === "pool:Precheck"
    ? { workflow: env.PRECHECK, target: warmTarget(env.PRECHECK_WARM_TARGET) }
    : undefined;
}

/**
 * WorkflowPool: a Workflow's warm instances, one object per Workflow
 * (`pool:Precheck`). Each warm instance was created waiting for its claim's
 * event, so a claim spares the event's start the instance's creation and
 * start. A claim is decided and kept, one row by its event id, with no await
 * between, so two claims never get the same instance and a redelivery gets
 * its first answer; an alarm deletes each row once its memory ends.
 * The pool refills in the background once a claim leaves it low, and tops up
 * at its deadline; a failed refill is logged, and the next claim or deadline
 * tries again. The rules are `workflow-pool-rules.ts`'.
 */
export class WorkflowPoolDO extends KeelObject implements WorkflowPoolRpc {
  /** Instances being created and not yet in the pool, so overlapping refills start no more than the target. */
  private starting = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${CLAIMS} (event_id TEXT PRIMARY KEY, answer TEXT NOT NULL, forget_at INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${CLAIMS}_forget_at ON ${CLAIMS} (forget_at)`);
  }

  /** How many warm instances this pool keeps: none for a name that keeps no Workflow warm. */
  private get target(): number {
    return pooledWorkflow(this.env, this.ctx.id.name)?.target ?? 0;
  }

  private get state(): PoolState {
    return this.ctx.storage.kv.get<PoolState>(STATE) ?? EMPTY_POOL;
  }

  /** One event's claim: a warm instance's id, or COLD for the caller to start one itself. */
  async claim(eventId: string): Promise<string> {
    const now = Date.now();
    const prior = this.ctx.storage.sql
      .exec<{ answer: string }>(
        `SELECT answer FROM ${CLAIMS} WHERE event_id = ? AND forget_at > ?`,
        eventId,
        now,
      )
      .toArray()[0]?.answer;
    const decided = claim(this.state, eventId, prior, now);
    this.ctx.storage.kv.put(STATE, decided.state);
    const kept = decided.kept;
    if (kept !== undefined) {
      this.ctx.storage.sql.exec(
        `INSERT INTO ${CLAIMS} (event_id, answer, forget_at) VALUES (?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET answer = excluded.answer, forget_at = excluded.forget_at`,
        kept.eventId,
        kept.answer,
        kept.forgetAt,
      );
      await this.armForget();
    }
    const short = toStart(decided.state, now, "claim", this.target) - this.starting;
    if (short > 0) this.ctx.waitUntil(this.refill(short));
    return decided.answer;
  }

  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason === FORGET) {
      this.ctx.storage.sql.exec(`DELETE FROM ${CLAIMS} WHERE forget_at <= ?`, Date.now());
      return this.armForget();
    }
    if (request.reason !== TOP_UP) return super.onDeadline(request);
    const now = Date.now();
    const state = current(this.state, now);
    this.ctx.storage.kv.put(STATE, state);
    const short = toStart(state, now, "deadline", this.target) - this.starting;
    if (short > 0) await this.refill(short);
    else await this.arm(state);
  }

  /**
   * Creates `n` warm instances, then adds those created to the pool as it
   * stands after the awaits, never as it stood before them. Each one's end is
   * counted from before its creation, so it is never later than its wait's.
   */
  private async refill(n: number): Promise<void> {
    const name = this.ctx.id.name;
    const workflow = pooledWorkflow(this.env, name)?.workflow;
    if (workflow === undefined) {
      console.error(`WorkflowPool ${name ?? "unnamed"} keeps no Workflow warm`);
      return;
    }
    const prefix = `${(name ?? "").replace(/^pool:/, "").toLowerCase()}-pool`;
    const at = Date.now();
    this.starting += n;
    let created: string[];
    try {
      const started = await Promise.allSettled(
        Array.from({ length: n }, async () => {
          const id = `${prefix}-${crypto.randomUUID()}`;
          await workflow.create({ id, params: POOLED });
          return id;
        }),
      );
      created = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      for (const s of started)
        if (s.status === "rejected")
          console.error(
            `WorkflowPool ${name} could not start a warm instance: ${String(s.reason)}`,
          );
    } finally {
      this.starting -= n;
    }
    const state = added(current(this.state, Date.now()), created, at);
    this.ctx.storage.kv.put(STATE, state);
    await this.arm(state);
  }

  /** Arms the forgetting of the oldest kept claim, or withdraws it when none is kept. */
  private async armForget(): Promise<void> {
    const oldest = this.ctx.storage.sql
      .exec<{ at: number | null }>(`SELECT MIN(forget_at) AS at FROM ${CLAIMS}`)
      .one().at;
    if (oldest === null) await cancelAlarm(this.ctx.storage, FORGET);
    else await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason: FORGET, at: oldest });
  }

  private async arm(state: PoolState): Promise<void> {
    const due = nextDeadline(state);
    if (due === undefined) await cancelAlarm(this.ctx.storage, TOP_UP);
    else await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason: TOP_UP, at: due });
  }
}
