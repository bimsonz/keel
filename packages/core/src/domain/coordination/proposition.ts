import { Schema } from "effect";
import { Anchor, Citation, Glob, PredicatePolicy } from "../kernel/index.ts";

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

const policyOf = Schema.optional(PredicatePolicy);
/**
 * A project's predicate policy as composed for one change (ADR 0005, decided
 * 11 Oct): per predicate, what a proven conflict or a failing guard does. A
 * predicate it leaves out is `advise`. Every predicate has its key: a new
 * predicate fails to compile here until it does.
 */
export const PredicatePolicies = Schema.Struct({
  freshness: policyOf,
  cardinality: policyOf,
  ordering: policyOf,
  consistency: policyOf,
  shape: policyOf,
  presence: policyOf,
  authority: policyOf,
  purity: policyOf,
  idempotent: policyOf,
  bound: policyOf,
  invariant: policyOf,
} satisfies Record<Predicate, typeof policyOf>);
export type PredicatePolicies = typeof PredicatePolicies.Type;

export const Relation = Schema.Literals(["is", "at-most", "at-least", "not", "before", "after"]);
export type Relation = typeof Relation.Type;

/**
 * The holder's declared kind of reliance, not a confidence. A contradiction of
 * a `should` premise is reported as suspect rather than as a conflict.
 */
export const Strength = Schema.Literals(["must", "should"]);
export type Strength = typeof Strength.Type;

/** A named concept in the codebase, e.g. `authz.permission-evaluation`. */
export const SubjectKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
).pipe(Schema.brand("SubjectKey"));
export type SubjectKey = typeof SubjectKey.Type;

/**
 * The shared shape of premises and effects. Two propositions with the same key
 * `(subject, predicate)` can be compared once both are normalised.
 */
export const Proposition = Schema.Struct({
  subject: SubjectKey,
  predicate: Predicate,
  relation: Relation,
  /**
   * Read on the predicate's lattice: freshness `per-call|per-request|per-session|static|ttl:<s>`,
   * and for an effect only, with `is` or `at-most`, `<freshness> invalidated-on <key>,<key>` (dotted
   * event keys, sorted, each once);
   * consistency `eventual|read-your-writes|linearizable|bounded:<s>`; authority a comma-separated
   * writer set; shape a JSON-encoded structural type; ordering with before/after, the subject being
   * the first event and the value the second; bound a number in `unit`; purity, idempotent and
   * presence a boolean. `is` means exactly the value, `not` its complement.
   */
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  /** The unit of a `bound` value, e.g. `ms`. */
  unit: Schema.optional(Schema.String),
  /** `;`-separated `key:value` pairs, e.g. `env:prod|staging;tenant:t1`. Absent means everywhere. */
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
