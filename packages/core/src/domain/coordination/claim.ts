import { Result } from "effect";
import type { Anchor, NextAction } from "../kernel/index.ts";
import { UnreadableProposition } from "./errors.ts";
import type {
  Authority,
  Bound,
  Cardinality,
  ClaimRelation,
  Consistency,
  Freshness,
  FreshnessValue,
  Ordering,
} from "./lattice.ts";
import { isInvalidated } from "./lattice.ts";
import { type Predicate, type Proposition, type Strength, SubjectKey } from "./proposition.ts";
import { readScope, type Scope, writeScope } from "./scope.ts";
import { readShape, type Shape } from "./shape.ts";

/** A predicate paired with the value domain it compares over. */
export type Claim =
  | {
      readonly predicate: "freshness";
      readonly relation: ClaimRelation;
      readonly value: FreshnessValue;
    }
  | {
      readonly predicate: "cardinality";
      readonly relation: ClaimRelation;
      readonly value: Cardinality;
    }
  | {
      readonly predicate: "consistency";
      readonly relation: ClaimRelation;
      readonly value: Consistency;
    }
  | { readonly predicate: "bound"; readonly relation: ClaimRelation; readonly value: Bound }
  | { readonly predicate: "presence"; readonly relation: "is" | "not"; readonly value: boolean }
  | { readonly predicate: "purity"; readonly relation: "is" | "not"; readonly value: boolean }
  | { readonly predicate: "idempotent"; readonly relation: "is" | "not"; readonly value: boolean }
  | {
      readonly predicate: "authority";
      readonly relation: "is" | "at-most" | "at-least";
      readonly value: Authority;
    }
  | {
      readonly predicate: "shape";
      readonly relation: "is" | "at-most" | "at-least";
      readonly value: Shape;
    }
  | { readonly predicate: "ordering"; readonly relation: "is"; readonly value: Ordering }
  | { readonly predicate: "invariant"; readonly relation: "is"; readonly value: string };

/** A proposition read onto its lattice, ready to compare. */
export type ReadProposition = {
  readonly subject: SubjectKey;
  readonly scope: Scope;
  readonly claim: Claim;
  readonly strength: Strength;
  readonly anchors: readonly Anchor[];
};

const freshnessNames = ["per-call", "per-request", "per-session", "static"] as const;
const consistencyNames = ["eventual", "read-your-writes", "linearizable"] as const;
const cardinalityNames = ["exactly-once", "at-most-once", "at-least-once", "any"] as const;
const lattice = ["is", "at-most", "at-least", "not"] as const;
const parameter = (prefix: string, value: string): number | undefined => {
  const match = new RegExp(`^${prefix}:(\\d+(?:\\.\\d+)?)$`).exec(value);
  return match === null ? undefined : Number(match[1]);
};

const pick = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.find((o) => o === value);

/** `<freshness> invalidated-on <key>,<key>`: the effect form "cached, invalidated on E". */
const INVALIDATION = /^(\S+) invalidated-on (\S+)$/;
const EVENT_KEY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const readFreshness = (v: string): Freshness | undefined => {
  const named = pick(freshnessNames, v);
  if (named !== undefined) return named;
  const ttl = parameter("ttl", v);
  return ttl === undefined ? undefined : { ttl };
};

const writeFreshness = (v: Freshness): string => (typeof v === "object" ? `ttl:${v.ttl}` : v);

const readValue = (p: Proposition): Claim | string => {
  const v = p.value;
  const rel = p.relation;
  const latticeRel = pick(lattice, rel);
  switch (p.predicate) {
    case "freshness": {
      if (latticeRel === undefined || typeof v !== "string")
        return "freshness takes is/at-most/at-least/not and a string";
      const invalidation = INVALIDATION.exec(v);
      if (invalidation === null) {
        const base = readFreshness(v);
        return base === undefined
          ? `"${v}" is not a freshness`
          : { predicate: "freshness", relation: latticeRel, value: base };
      }
      const cached = readFreshness(invalidation[1] ?? "");
      const keys = (invalidation[2] ?? "").split(",");
      if (cached === undefined) return `"${invalidation[1]}" is not a freshness`;
      if (latticeRel !== "is" && latticeRel !== "at-most")
        return "an invalidation form takes is or at-most";
      if (!keys.every((k) => EVENT_KEY.test(k)))
        return "invalidated-on takes dotted event keys, e.g. authz.revoke";
      if (!keys.every((k, i) => i === 0 || (keys[i - 1] ?? "") < k))
        return "invalidated-on lists its event keys sorted, each once";
      return {
        predicate: "freshness",
        relation: latticeRel,
        value: { cached, invalidatedOn: keys },
      };
    }
    case "consistency": {
      if (latticeRel === undefined || typeof v !== "string")
        return "consistency takes is/at-most/at-least/not and a string";
      const named = pick(consistencyNames, v);
      const bounded = parameter("bounded", v);
      if (named !== undefined)
        return { predicate: "consistency", relation: latticeRel, value: named };
      return bounded === undefined
        ? `"${v}" is not a consistency level`
        : { predicate: "consistency", relation: latticeRel, value: { bounded } };
    }
    case "cardinality": {
      const named = pick(cardinalityNames, v);
      return latticeRel === undefined || named === undefined
        ? "cardinality takes is/at-most/at-least/not and exactly-once, at-most-once, at-least-once or any"
        : { predicate: "cardinality", relation: latticeRel, value: named };
    }
    case "bound":
      return latticeRel === undefined || typeof v !== "number" || !Number.isFinite(v)
        ? "bound takes is/at-most/at-least/not and a finite number"
        : { predicate: "bound", relation: latticeRel, value: { n: v, unit: p.unit ?? "" } };
    case "presence":
    case "purity":
    case "idempotent":
      return (rel === "is" || rel === "not") && typeof v === "boolean"
        ? { predicate: p.predicate, relation: rel, value: v }
        : `${p.predicate} takes is/not and a boolean`;
    case "authority": {
      if ((rel !== "is" && rel !== "at-most" && rel !== "at-least") || typeof v !== "string") {
        return "authority takes is/at-most/at-least and a comma-separated writer set";
      }
      const writers = v
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0);
      return new Set(writers).size === writers.length
        ? { predicate: "authority", relation: rel, value: { writers: writers.toSorted() } }
        : "authority names a writer twice";
    }
    case "shape": {
      if ((rel !== "is" && rel !== "at-most" && rel !== "at-least") || typeof v !== "string") {
        return "shape takes is/at-most/at-least and a JSON-encoded structural type";
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(v);
      } catch {
        return "shape is not valid JSON";
      }
      const shape = readShape(decoded);
      return shape === undefined
        ? "shape is not a structural type"
        : { predicate: "shape", relation: rel, value: shape };
    }
    case "ordering":
      if (
        (rel !== "before" && rel !== "after") ||
        typeof v !== "string" ||
        !EVENT_KEY.test(v) ||
        v === p.subject
      ) {
        return "ordering takes before/after and another event's key";
      }
      return {
        predicate: "ordering",
        relation: "is",
        value: rel === "before" ? { before: p.subject, after: v } : { before: v, after: p.subject },
      };
    default:
      return rel === "is" && typeof v === "string" && v.trim() !== ""
        ? { predicate: "invariant", relation: "is", value: v }
        : "an invariant takes is and its text";
  }
};

/** Premises state what they rely on; an eviction on an event is something code does, so only effects say it. */
const statePremiseFreshness: NextAction = {
  kind: "call",
  title:
    "State the freshness you rely on, e.g. at-most per-request; invalidation is an effect form",
  operationId: "revise",
};

/**
 * Reads a wire proposition onto its predicate's lattice, or says why it
 * cannot. A premise is read as one: the effect-only invalidation form is
 * refused, with the next action.
 */
export const readClaim = (
  p: Proposition,
  role: "premise" | "effect" = "effect",
): Result.Result<ReadProposition, UnreadableProposition> => {
  const unreadable = (reason: string, nextActions?: readonly NextAction[]) =>
    Result.fail(
      new UnreadableProposition({
        subject: p.subject,
        predicate: p.predicate,
        reason,
        ...(nextActions === undefined ? {} : { nextActions }),
      }),
    );
  const scope = readScope(p.scope);
  if (Result.isFailure(scope)) return unreadable(scope.failure);
  const claim = readValue(p);
  if (typeof claim === "string") return unreadable(claim);
  if (role === "premise" && claim.predicate === "freshness" && isInvalidated(claim.value))
    return unreadable("a premise cannot rely on an invalidation: it is an effect form", [
      statePremiseFreshness,
    ]);
  return Result.succeed({
    subject: p.subject,
    scope: scope.success,
    claim,
    strength: p.strength ?? "must",
    anchors: p.anchors ?? [],
  });
};

const writeValue = (
  subject: SubjectKey,
  claim: Claim,
): { relation: Proposition["relation"]; value: string | number | boolean; unit?: string } => {
  switch (claim.predicate) {
    case "freshness": {
      const v = claim.value;
      if (!isInvalidated(v)) return { relation: claim.relation, value: writeFreshness(v) };
      const keys = [...new Set(v.invalidatedOn)].toSorted();
      return {
        relation: claim.relation,
        value: `${writeFreshness(v.cached)} invalidated-on ${keys.join(",")}`,
      };
    }
    case "consistency":
      return {
        relation: claim.relation,
        value: typeof claim.value === "object" ? `bounded:${claim.value.bounded}` : claim.value,
      };
    case "bound":
      return claim.value.unit === ""
        ? { relation: claim.relation, value: claim.value.n }
        : { relation: claim.relation, value: claim.value.n, unit: claim.value.unit };
    case "authority":
      return { relation: claim.relation, value: claim.value.writers.join(",") };
    case "shape":
      return { relation: claim.relation, value: JSON.stringify(claim.value) };
    case "ordering":
      // The subject is the first event of the pair, whichever side of it the other falls.
      return claim.value.before === subject
        ? { relation: "before", value: claim.value.after }
        : { relation: "after", value: claim.value.before };
    default:
      return { relation: claim.relation, value: claim.value };
  }
};

const SWAPPED = { before: "after", after: "before" } as const;

/**
 * A proposition in its canonical form.
 * `a before b` and `b after a` are one proposition: an ordering is written
 * from the lesser of its two event keys by code point (keys are ASCII, so `<`
 * is code-point order), swapping before and after when it is rewritten, so
 * both holders route to one subject and are compared there. Every other field
 * is kept. Anything else, an unreadable ordering included, comes back as it
 * is. Applied where propositions enter Keel: at declare and at derive.
 */
export const canonicalProposition = (p: Proposition): Proposition => {
  if (p.predicate !== "ordering" || (p.relation !== "before" && p.relation !== "after")) return p;
  const other = p.value;
  if (typeof other !== "string" || !EVENT_KEY.test(other) || other >= p.subject) return p;
  return { ...p, subject: SubjectKey.make(other), relation: SWAPPED[p.relation], value: p.subject };
};

export type PropositionDetails = {
  readonly scope?: Scope;
  readonly anchors?: readonly Anchor[];
  readonly gloss?: string;
  readonly strength?: Strength;
};

/**
 * Writes a typed claim as a wire proposition. An ordering claim must name the
 * subject as one of its two events.
 */
export const writeProposition = (
  subject: SubjectKey,
  claim: Claim,
  details: PropositionDetails = {},
): Proposition => {
  const scope = details.scope === undefined ? undefined : writeScope(details.scope);
  const predicate: Predicate = claim.predicate;
  return {
    subject,
    predicate,
    ...writeValue(subject, claim),
    ...(scope === undefined ? {} : { scope }),
    ...(details.anchors === undefined ? {} : { anchors: details.anchors }),
    ...(details.gloss === undefined ? {} : { gloss: details.gloss }),
    ...(details.strength === undefined ? {} : { strength: details.strength }),
  };
};
