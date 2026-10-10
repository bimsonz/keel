import { Schema } from "effect";

/**
 * What an agent can do next, attached to every refusal and every bounce so an
 * agent is never left without a way forward. Mirrors the API's `NextAction`
 * model; each one can be fed straight into the matching tool.
 */
export const NextAction = Schema.Struct({
  /** `call` an operation, `wait` and retry, `read` something first, or `escalate` to a person. */
  kind: Schema.Literals(["call", "wait", "read", "escalate"]),
  title: Schema.NonEmptyString,
  /** The operation to call, for `call` and `read`. */
  operationId: Schema.optional(Schema.String),
  /** Arguments to pass to it, pre-filled. */
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type NextAction = typeof NextAction.Type;
