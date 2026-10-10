import { Context, type Effect } from "effect";
import type { ModelAbstained } from "../../domain/verification/index.ts";

/** A single-shot, schema-constrained model call, identified by name and pinned model. */
export interface PlatformFunctionCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** JSON Schema the output must satisfy; anything else abstains. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

/** **The only way Keel calls a model** (ADR 0001): one call, no loop, no tools. */
export class PlatformFunction extends Context.Service<
  PlatformFunction,
  {
    readonly call: (call: PlatformFunctionCall) => Effect.Effect<unknown, ModelAbstained>;
  }
>()("keel/PlatformFunction") {}
