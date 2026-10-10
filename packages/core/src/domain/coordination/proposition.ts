import { Schema } from "effect";
import { Anchor, Citation, Glob } from "../kernel/index.ts";

/** The dimension a proposition talks about. Each predicate orders its values on a lattice. */
export const Predicate = Schema.Literals([
  "freshness",
  "cardinality",
  "ordering",
  "consistency",
  "shape",
  "presence",
  "authority",
  "purity",
  "idempotent",
  "bound",
  "invariant",
]);
export type Predicate = typeof Predicate.Type;

export const Relation = Schema.Literals(["is", "at-most", "at-least", "not", "before", "after"]);
export type Relation = typeof Relation.Type;

/**
 * The holder's declared kind of reliance, not a confidence. A contradiction of
 * a `should` premise is reported as suspect rather than as a conflict.
 */
export const Strength = Schema.Literals(["must", "should"]);
export type Strength = typeof Strength.Type;

/** A named concept in the codebase, e.g. `authz.permission-evaluation`. */
export const SubjectKey = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)).pipe(
  Schema.brand("SubjectKey"),
);
export type SubjectKey = typeof SubjectKey.Type;

/**
 * The shared shape of premises and effects. Two propositions with the same key
 * `(subject, predicate)` can be compared once both are normalised.
 */
export const Proposition = Schema.Struct({
  subject: SubjectKey,
  predicate: Predicate,
  relation: Relation,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  scope: Schema.optional(Schema.String),
  anchors: Schema.optional(Schema.Array(Anchor)),
  gloss: Schema.optional(Schema.String),
  strength: Schema.optional(Strength),
  cites: Schema.optional(Schema.Array(Citation)),
});
export type Proposition = typeof Proposition.Type;

/** A proposition's comparison key. */
export function keyOf(proposition: Proposition): string {
  return `${proposition.subject}/${proposition.predicate}`;
}

/** A path or symbol a change edits, creates or deletes. */
export const FootprintEntry = Schema.Struct({
  path: Glob,
  symbol: Schema.optional(Schema.String),
  op: Schema.Literals(["edit", "create", "delete"]),
});
export type FootprintEntry = typeof FootprintEntry.Type;
