/**
 * A model-based harness for a state machine's `decide`/`evolve`: plays a
 * seeded plan the way its Durable Object would (decide, then fold each event
 * through evolve), and at every state it reaches also tries every command
 * kind without applying it, so an oracle can check the whole table there.
 */
import { Result } from "effect";
import { afterEach } from "vitest";
import { type Committed, IllegalTransition, Instant } from "../../src/domain/kernel/index.ts";
import { seedPinned } from "./fast-check.ts";

type Rejection = { readonly _tag: string };

export interface Machine<S, C, E, F> {
  readonly decide: (
    state: S | undefined,
    command: C,
    facts: F,
  ) => Result.Result<readonly E[], Rejection>;
  readonly evolve: (state: S | undefined, event: Committed<E>) => S;
}

/** A command tried on a state: what decide said, and where its events lead (or that evolve refused them). */
export interface Probe<S, C, E> {
  readonly command: C;
  readonly result: Result.Result<readonly E[], Rejection>;
  readonly after: S | undefined;
  readonly threw: boolean;
}

export const attempt = <S, C, E, F>(
  machine: Machine<S, C, E, F>,
  state: S | undefined,
  command: C,
  facts: F,
  now: Instant,
): Probe<S, C, E> => {
  const result = machine.decide(state, command, facts);
  if (Result.isFailure(result)) return { command, result, after: state, threw: false };
  try {
    const after = result.success.reduce<S | undefined>(
      (s, payload) => machine.evolve(s, { at: now, payload }),
      state,
    );
    return { command, result, after, threw: false };
  } catch (error) {
    if (!(error instanceof IllegalTransition)) throw error;
    return { command, result, after: state, threw: true };
  }
};

export interface Played<S, C, E> {
  readonly before: S | undefined;
  readonly now: Instant;
  readonly probes: readonly Probe<S, C, E>[];
  readonly taken: Probe<S, C, E>;
  /** The state after the step: the taken command's, or `before` if it was refused or evolve threw. */
  readonly after: S | undefined;
  /** Every event committed so far, in order. */
  readonly log: readonly Committed<E>[];
}

export interface Script<S, C, F, Step> {
  readonly start: Instant;
  readonly dt: (step: Step) => number;
  /** The facts every command at this step is decided with: the time, and anything the step looks up. */
  readonly facts: (now: Instant, step: Step) => F;
  /** One command of every kind, for this state and step. */
  readonly every: (state: S | undefined, step: Step) => readonly C[];
  /** The command this step takes. */
  readonly choose: (state: S | undefined, step: Step) => C;
}

export const play = <S, C, E, F, Step>(
  machine: Machine<S, C, E, F>,
  script: Script<S, C, F, Step>,
  steps: readonly Step[],
): readonly Played<S, C, E>[] => {
  const played: Played<S, C, E>[] = [];
  const log: Committed<E>[] = [];
  let state: S | undefined;
  let now = script.start;
  for (const step of steps) {
    now = Instant(now + script.dt(step));
    const before = state;
    const facts = script.facts(now, step);
    const probes = script.every(before, step).map((c) => attempt(machine, before, c, facts, now));
    const taken = attempt(machine, before, script.choose(before, step), facts, now);
    if (Result.isSuccess(taken.result) && !taken.threw) {
      for (const payload of taken.result.success) log.push({ at: now, payload });
      state = taken.after;
    }
    played.push({ before, now, probes, taken, after: state, log: [...log] });
    if (taken.threw) break;
  }
  return played;
};

/**
 * Under a pinned seed every property draws the same plans: play each one once
 * and keep it. A plain run draws fresh plans for every property and never meets
 * one again, so what a test played is dropped when the test ends; kept, a file
 * of thirty properties holds nine thousand traces. Call it as a test file
 * loads, while a hook can still be registered.
 */
export const memo = <A, R>(fn: (arg: A) => R): ((arg: A) => R) => {
  const known = new Map<string, R>();
  if (!seedPinned) afterEach(() => known.clear());
  return (arg) => {
    const key = JSON.stringify(arg);
    const hit = known.get(key);
    if (hit !== undefined) return hit;
    const value = fn(arg);
    known.set(key, value);
    return value;
  };
};

export const failureTag = (r: Result.Result<unknown, Rejection>): string | undefined =>
  Result.isFailure(r) ? r.failure._tag : undefined;
export const eventsOf = <E>(r: Result.Result<readonly E[], Rejection>): readonly E[] =>
  Result.isSuccess(r) ? r.success : [];

/** One committed event, with the state it left and the state it led to. */
export interface Fold<S, E> {
  readonly before: S | undefined;
  readonly event: E;
  readonly after: S;
}

/** Folds a decision's events one at a time, keeping each event's own before and after. */
export const stepsOf = <S, C, E, F>(
  machine: Machine<S, C, E, F>,
  before: S | undefined,
  events: readonly E[],
  at: Instant,
): readonly Fold<S, E>[] => {
  const steps: Fold<S, E>[] = [];
  let state = before;
  for (const event of events) {
    const after = machine.evolve(state, { at, payload: event });
    steps.push({ before: state, event, after });
    state = after;
  }
  return steps;
};

export interface Tour<S, C, F> {
  readonly start: Instant;
  readonly facts: (now: Instant) => F;
  /** Every command to try from a state, each after its own time step. */
  readonly moves: (state: S | undefined) => readonly { readonly command: C; readonly dt: number }[];
  /** States with the same signature are explored once. */
  readonly signature: (state: S | undefined) => string;
  readonly maxNodes?: number;
}

/**
 * Walks the real machine breadth-first from nothing: every move from every
 * distinct state, deterministically, with no seed. Returns each accepted
 * decision's events, step by step. Coverage of a chart comes from here, so it
 * cannot depend on a lucky seed.
 */
export const tour = <S, C, E, F>(
  machine: Machine<S, C, E, F>,
  plan: Tour<S, C, F>,
): readonly Fold<S, E>[] => {
  const seen = new Set<string>([plan.signature(undefined)]);
  const queue: { readonly state: S | undefined; readonly now: Instant }[] = [
    { state: undefined, now: plan.start },
  ];
  const steps: Fold<S, E>[] = [];
  for (let i = 0; i < queue.length && i < (plan.maxNodes ?? 2_000); i++) {
    const node = queue[i];
    if (node === undefined) break;
    for (const move of plan.moves(node.state)) {
      const at = Instant(node.now + move.dt);
      const result = machine.decide(node.state, move.command, plan.facts(at));
      if (Result.isFailure(result) || result.success.length === 0) continue;
      let walked: readonly Fold<S, E>[];
      try {
        walked = stepsOf(machine, node.state, result.success, at);
      } catch (error) {
        if (error instanceof IllegalTransition) continue;
        throw error;
      }
      steps.push(...walked);
      const after = walked.at(-1)?.after;
      const signature = plan.signature(after);
      if (!seen.has(signature)) {
        seen.add(signature);
        queue.push({ state: after, now: at });
      }
    }
  }
  return steps;
};
