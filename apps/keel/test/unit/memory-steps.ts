import type { ProbeSteps } from "@keeltown/core/application/verification";
import { Effect } from "effect";

/**
 * The Workflow's steps in memory: each step's value kept as JSON by name, so
 * running the program again over the same `kept` replays it; a name used
 * twice in one run is a defect, since the Workflow would answer the first
 * value again. `onWait` decides each wait; `after` runs a hook once a named
 * step has run.
 */
export function memorySteps(
  options: {
    readonly onWait?: (type: string, timeoutMs: number) => Effect.Effect<boolean>;
    readonly after?: Readonly<Record<string, Effect.Effect<void>>>;
  } = {},
) {
  const kept = new Map<string, string>();
  const done: string[] = [];
  const waits: { readonly name: string; readonly type: string; readonly timeoutMs: number }[] = [];
  const steps = (): ProbeSteps => {
    const seen = new Set<string>();
    const once = (name: string) =>
      Effect.suspend(() => {
        if (seen.has(name)) return Effect.die(new Error(`step ${name} is named twice`));
        seen.add(name);
        return Effect.void;
      });
    return {
      step: <A, R>(name: string, effect: Effect.Effect<A, never, R>) =>
        Effect.gen(function* () {
          yield* once(name);
          const held = kept.get(name);
          if (held !== undefined) return JSON.parse(held);
          const value: A = yield* effect;
          done.push(name);
          kept.set(name, JSON.stringify(value));
          const hook = options.after?.[name];
          if (hook !== undefined) yield* hook;
          return value;
        }),
      waitFor: (name, type, timeoutMs) =>
        Effect.gen(function* () {
          yield* once(`wait ${name}`);
          const held = kept.get(`wait ${name}`);
          if (held !== undefined) return JSON.parse(held) === true;
          waits.push({ name, type, timeoutMs });
          const heard = yield* (options.onWait ?? (() => Effect.succeed(false)))(type, timeoutMs);
          kept.set(`wait ${name}`, JSON.stringify(heard));
          return heard;
        }),
    };
  };
  return { kept, ran: done, waits, steps };
}
