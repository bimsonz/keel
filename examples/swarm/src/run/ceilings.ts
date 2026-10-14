/**
 * The model's ceilings on the account: how many calls may be in flight
 * at once, how many may start in any minute, and how many a run may make. A
 * call holds a slot until it ends; a slot whose holder never gave it back
 * lapses after `holdMs`, so a worker that died mid-call cannot hold the
 * swarm's capacity for ever.
 */
export interface Ceilings {
  readonly inFlight: number;
  /** Calls started in any 60 s: under the model's own limit on the account, so Workers AI's 429 stays rare. */
  readonly perMinute: number;
  readonly perRun: number;
  readonly holdMs: number;
}

/** Workers AI takes 300 text-generation calls a minute on an account; 240 leaves the rest to everything else on it. */
export const CEILINGS: Ceilings = { inFlight: 20, perMinute: 240, perRun: 2_500, holdMs: 180_000 };

const MINUTE_MS = 60_000;

export interface Slots {
  /** Each held slot's id, and when it lapses. */
  readonly held: Readonly<Record<string, number>>;
  /** When each call of the last minute was granted, oldest first. */
  readonly started: readonly number[];
  /** Calls the run has been granted. */
  readonly used: number;
  /** Calls the model refused with its rate limit's 429. */
  readonly limited: number;
}

export const NO_SLOTS: Slots = { held: {}, started: [], used: 0, limited: 0 };

export type Taken =
  | { readonly granted: true; readonly slots: Slots }
  | {
      readonly granted: false;
      readonly slots: Slots;
      readonly reason: "busy" | "paced" | "spent";
      readonly retryInMs: number;
    };

/** The slots with every lapsed hold, and every start over a minute old, dropped. */
function current(slots: Slots, now: number): Slots {
  const held = Object.fromEntries(Object.entries(slots.held).filter(([, until]) => until > now));
  const started = slots.started.filter((at) => at > now - MINUTE_MS);
  return { ...slots, held, started };
}

/** Grants slot `id`, or says why not: the run's calls are spent, every slot is held, or the minute's calls have started. */
export function take(slots: Slots, id: string, now: number, ceilings: Ceilings = CEILINGS): Taken {
  const live = current(slots, now);
  if (live.used >= ceilings.perRun)
    return { granted: false, slots: live, reason: "spent", retryInMs: 0 };
  const holds = Object.values(live.held);
  if (holds.length >= ceilings.inFlight) {
    const soonest = Math.min(...holds) - now;
    return {
      granted: false,
      slots: live,
      reason: "busy",
      retryInMs: Math.max(250, Math.min(soonest, 2_000)),
    };
  }
  const oldest = live.started[0];
  if (oldest !== undefined && live.started.length >= ceilings.perMinute)
    return {
      granted: false,
      slots: live,
      reason: "paced",
      retryInMs: Math.max(250, oldest + MINUTE_MS - now),
    };
  return {
    granted: true,
    slots: {
      ...live,
      held: { ...live.held, [id]: now + ceilings.holdMs },
      started: [...live.started, now],
      used: live.used + 1,
    },
  };
}

/** Gives slot `id` back; `limited` when the model refused the call with its rate limit. */
export function give(slots: Slots, id: string, limited = false): Slots {
  const { [id]: _given, ...held } = slots.held;
  return { ...slots, held, limited: slots.limited + (limited ? 1 : 0) };
}
