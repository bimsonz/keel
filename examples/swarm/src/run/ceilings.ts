/**
 * The model's ceilings on the shared account: how many calls may be in flight
 * at once, and how many a run may make. A call holds a slot until it ends; a
 * slot whose holder never gave it back lapses after `holdMs`, so a worker that
 * died mid-call cannot hold the swarm's capacity for ever.
 */
export interface Ceilings {
  readonly inFlight: number;
  readonly perRun: number;
  readonly holdMs: number;
}

export const CEILINGS: Ceilings = { inFlight: 20, perRun: 2_500, holdMs: 180_000 };

export interface Slots {
  /** Each held slot's id, and when it lapses. */
  readonly held: Readonly<Record<string, number>>;
  /** Calls the run has been granted. */
  readonly used: number;
}

export const NO_SLOTS: Slots = { held: {}, used: 0 };

export type Taken =
  | { readonly granted: true; readonly slots: Slots }
  | {
      readonly granted: false;
      readonly slots: Slots;
      readonly reason: "busy" | "spent";
      readonly retryInMs: number;
    };

/** The slots with every lapsed hold dropped. */
function current(slots: Slots, now: number): Slots {
  const held = Object.fromEntries(Object.entries(slots.held).filter(([, until]) => until > now));
  return { ...slots, held };
}

/** Grants slot `id`, or says why not: the run's calls are spent, or every slot is held. */
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
  return {
    granted: true,
    slots: { held: { ...live.held, [id]: now + ceilings.holdMs }, used: live.used + 1 },
  };
}

/** Gives slot `id` back. */
export function give(slots: Slots, id: string): Slots {
  const { [id]: _given, ...held } = slots.held;
  return { ...slots, held };
}
