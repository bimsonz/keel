import { type Exit, Schema } from "effect";

/**
 * The Exit envelope. Errors do not survive structured clone across Durable
 * Object RPC, so every DO method answers with its Exit encoded as JSON, and
 * the caller decodes it back into the same success value or tagged error
 * (docs/effect.md). A defect crosses as `{ name, message }`.
 */
export type ExitJson = Schema.Json;

/**
 * A method's Exit codec, built the first time it is used and kept. The RPC
 * maps name over a hundred, and building every one as the module loaded
 * spent about a fifth of the Worker's startup CPU.
 */
export type ExitCodec<A, E> = () => Schema.Codec<Exit.Exit<A, E>, Schema.Json>;

export function exitCodec<A, AI, E, EI>(
  success: Schema.Codec<A, AI>,
  failure: Schema.Codec<E, EI>,
): ExitCodec<A, E> {
  let built: Schema.Codec<Exit.Exit<A, E>, Schema.Json> | undefined;
  return () => (built ??= Schema.toCodecJson(Schema.Exit(success, failure, Schema.Defect())));
}

export function encodeExit<A, E>(codec: ExitCodec<A, E>, exit: Exit.Exit<A, E>): ExitJson {
  return Schema.encodeSync(codec())(exit);
}

export function decodeExit<A, E>(codec: ExitCodec<A, E>, json: unknown): Exit.Exit<A, E> {
  return Schema.decodeUnknownSync(codec())(json);
}
