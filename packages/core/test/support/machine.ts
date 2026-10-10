/**
 * A model-based harness for a state machine's `decide`/`evolve`: plays a
 * seeded plan the way its Durable Object would (decide, then fold each event
 * through evolve), and at every state it reaches also tries every command
 * kind without applying it, so an oracle can check the whole table there.
 */
import { Result } from "effect";
import { type Committed, IllegalTransition, Instant } from "../../src/domain/kernel/index.ts";

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
  readonly facts: (now: Instant) => F;
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
    const facts = script.facts(now);
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

/** Every property draws the same plans from the same seed: play each one once. */
export const memo = <A, R>(fn: (arg: A) => R): ((arg: A) => R) => {
  const known = new Map<string, R>();
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
