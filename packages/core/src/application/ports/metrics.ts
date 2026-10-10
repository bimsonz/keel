import { Context, type Effect } from "effect";

export class Metrics extends Context.Service<
  Metrics,
  {
    readonly count: (
      name: string,
      value: number,
      tags?: Readonly<Record<string, string>>,
    ) => Effect.Effect<void>;
    readonly observe: (
      name: string,
      value: number,
      tags?: Readonly<Record<string, string>>,
    ) => Effect.Effect<void>;
  }
>()("keel/Metrics") {}
