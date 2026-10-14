import { Result, Schema } from "effect";
import {
  type Anchor,
  type Citation,
  CommitSha,
  canonicalJson,
  type Json,
  SessionId,
} from "../kernel/index.ts";
import { readClaim } from "./claim.ts";
import { Untellable, type UntellableReason } from "./errors.ts";
import { type Proposition, Strength, SubjectKey } from "./proposition.ts";
import { readScope, writeScope } from "./scope.ts";
import type { Field, Shape } from "./shape.ts";

/*
 * Keel's propositions and citations as MFP 0.2 tells them, and back. Keel
 * stores what it always stored; these convert at the edge. A proposition
 * crosses only where it reads on its lattice: Keel stores one that does not
 * (and compares it as needs-probe), but 0.2 has no form for it, and 0.2's
 * forms that pass its schema but do not read are refused on the way in, never
 * repaired.
 */

const ATOM = "[a-z0-9][a-z0-9._-]*";
const SCOPE_PART = `${ATOM}:${ATOM}(?:\\|${ATOM})*`;
const KEY = "[a-z0-9]+(?:[.-][a-z0-9]+)*";
const FRESHNESS = "(?:per-call|per-request|per-session|static|ttl:[0-9]+(?:\\.[0-9]+)?)";

const pattern = (source: string) => Schema.String.check(Schema.isPattern(new RegExp(source)));

const MfpScope = pattern(`^${SCOPE_PART}(?:;${SCOPE_PART})*$`);
const FreshnessValue = pattern(`^${FRESHNESS}$`);
const InvalidationValue = pattern(`^${FRESHNESS} invalidated-on ${KEY}(?:,${KEY})*$`);
const ConsistencyValue = pattern(
  "^(?:eventual|read-your-writes|linearizable|bounded:[0-9]+(?:\\.[0-9]+)?)$",
);
const CardinalityValue = Schema.Literals(["exactly-once", "at-most-once", "at-least-once", "any"]);
const Writer = pattern("^[^\\s,]+$");
const Unit = pattern("^\\S+$");
const Text = pattern("\\S");

const OrderRelation = Schema.Literals(["is", "at-most", "at-least", "not"]);
const PointRelation = Schema.Literals(["is", "not"]);
const RangeRelation = Schema.Literals(["is", "at-most", "at-least"]);

/** A structural type as 0.2 writes it: `type`, an array's `items`, an object's fields as a list. */
export type MfpShape =
  | { readonly type: "unknown" | "never" | "string" | "number" | "boolean" | "null" }
  | { readonly type: "literal"; readonly value: string | number | boolean }
  | { readonly type: "array"; readonly items: MfpShape }
  | { readonly type: "object"; readonly fields: readonly MfpShapeField[] }
  | { readonly type: "union"; readonly of: readonly MfpShape[] }
  | { readonly type: "opaque"; readonly name: string };
export interface MfpShapeField {
  readonly name: string;
  readonly shape: MfpShape;
  readonly optional: boolean;
}

const SubShape = Schema.suspend((): Schema.Codec<MfpShape> => MfpShape);

export const MfpShape: Schema.Codec<MfpShape> = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["unknown", "never", "string", "number", "boolean", "null"]),
  }),
  Schema.Struct({
    type: Schema.Literal("literal"),
    value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  }),
  Schema.Struct({ type: Schema.Literal("array"), items: SubShape }),
  Schema.Struct({
    type: Schema.Literal("object"),
    fields: Schema.Array(
      Schema.Struct({ name: Schema.NonEmptyString, shape: SubShape, optional: Schema.Boolean }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("union"), of: Schema.Array(SubShape) }),
  Schema.Struct({ type: Schema.Literal("opaque"), name: Schema.NonEmptyString }),
]);

/** A code anchor. With no commit it means the driver's working commit. */
export const MfpAnchor = Schema.Struct({
  path: Schema.NonEmptyString,
  symbol: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(CommitSha),
});
export type MfpAnchor = typeof MfpAnchor.Type;

/** What a claim rests on, as 0.2 cites it: an anchor, or a ref the driver gave. */
export const MfpCitation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("anchor"), ...MfpAnchor.fields }),
  Schema.Struct({ kind: Schema.Literal("message"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("tool-result"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("record"), ref: Schema.NonEmptyString }),
]);
export type MfpCitation = typeof MfpCitation.Type;

const propositionFields = {
  scope: Schema.optionalKey(MfpScope),
  gloss: Schema.optionalKey(Schema.String),
  anchors: Schema.optionalKey(Schema.Array(MfpAnchor)),
  cites: Schema.optionalKey(Schema.Array(MfpCitation)),
};
const premiseFields = { strength: Schema.optionalKey(Strength), ...propositionFields };

const at = <P extends string>(predicate: P) => ({
  subject: SubjectKey,
  predicate: Schema.Literal(predicate),
});
const freshness = { ...at("freshness"), relation: OrderRelation, value: FreshnessValue };
const invalidation = {
  ...at("freshness"),
  relation: Schema.Literals(["is", "at-most"]),
  value: InvalidationValue,
};
const consistency = { ...at("consistency"), relation: OrderRelation, value: ConsistencyValue };
const cardinality = { ...at("cardinality"), relation: OrderRelation, value: CardinalityValue };
const bound = { ...at("bound"), relation: OrderRelation, value: Schema.Finite, unit: Unit };
const presence = { ...at("presence"), relation: PointRelation, value: Schema.Boolean };
const purity = { ...at("purity"), relation: PointRelation, value: Schema.Boolean };
const idempotent = { ...at("idempotent"), relation: PointRelation, value: Schema.Boolean };
const authority = { ...at("authority"), relation: RangeRelation, value: Schema.Array(Writer) };
const shape = { ...at("shape"), relation: RangeRelation, value: MfpShape };
const ordering = {
  ...at("ordering"),
  relation: Schema.Literals(["before", "after"]),
  value: SubjectKey,
};
const invariant = { ...at("invariant"), relation: Schema.Literal("is"), value: Text };

/** A premise as 0.2 states it: one form per predicate, never the invalidation form. */
export const MfpPremiseProposition = Schema.Union([
  Schema.Struct({ ...freshness, ...premiseFields }),
  Schema.Struct({ ...consistency, ...premiseFields }),
  Schema.Struct({ ...cardinality, ...premiseFields }),
  Schema.Struct({ ...bound, ...premiseFields }),
  Schema.Struct({ ...presence, ...premiseFields }),
  Schema.Struct({ ...purity, ...premiseFields }),
  Schema.Struct({ ...idempotent, ...premiseFields }),
  Schema.Struct({ ...authority, ...premiseFields }),
  Schema.Struct({ ...shape, ...premiseFields }),
  Schema.Struct({ ...ordering, ...premiseFields }),
  Schema.Struct({ ...invariant, ...premiseFields }),
]);
export type MfpPremiseProposition = typeof MfpPremiseProposition.Type;

/**
 * An effect as 0.2 states it: the premise forms with no strength, and the
 * invalidation form, a freshness effect told apart by its value.
 */
export const MfpEffectProposition = Schema.Union([
  Schema.Struct({ ...freshness, ...propositionFields }),
  Schema.Struct({ ...invalidation, ...propositionFields }),
  Schema.Struct({ ...consistency, ...propositionFields }),
  Schema.Struct({ ...cardinality, ...propositionFields }),
  Schema.Struct({ ...bound, ...propositionFields }),
  Schema.Struct({ ...presence, ...propositionFields }),
  Schema.Struct({ ...purity, ...propositionFields }),
  Schema.Struct({ ...idempotent, ...propositionFields }),
  Schema.Struct({ ...authority, ...propositionFields }),
  Schema.Struct({ ...shape, ...propositionFields }),
  Schema.Struct({ ...ordering, ...propositionFields }),
  Schema.Struct({ ...invariant, ...propositionFields }),
]);
export type MfpEffectProposition = typeof MfpEffectProposition.Type;

/** What the edge knows that a 0.2 message may leave out. */
export interface WireContext {
  /** The commit an anchor with none stands for: the driver's working commit. */
  readonly working?: CommitSha;
}

/** A bound with no unit of its own, as 0.2 writes it: 0.2 requires one. */
const UNITLESS = "1";

const MESSAGE_REF = /^(ses_[0-9A-HJKMNP-TV-Z]{26})\/(0|[1-9][0-9]*)$/;

const untellable = (
  what: "proposition" | "citation",
  reason: UntellableReason,
  detail: string,
): Result.Result<never, Untellable> => Result.fail(new Untellable({ what, reason, detail }));

const anchorToMfp = (a: Anchor): MfpAnchor => ({
  path: a.path,
  ...(a.symbol === undefined ? {} : { symbol: a.symbol }),
  commit: a.commit,
});

const anchorOfMfp = (a: MfpAnchor, ctx: WireContext): Result.Result<Anchor, Untellable> => {
  const commit = a.commit ?? ctx.working;
  return commit === undefined
    ? untellable("citation", "anchor-commit", `anchor ${a.path} names no commit`)
    : Result.succeed({
        path: a.path,
        ...(a.symbol === undefined ? {} : { symbol: a.symbol }),
        commit,
      });
};

/** A citation as 0.2 tells it: a message as `<session>/<seq>`, an anchor flattened, a record by its id. */
export const citationToMfp = (c: Citation): MfpCitation => {
  switch (c._tag) {
    case "message":
      return { kind: "message", ref: `${c.session}/${c.seq}` };
    case "anchor":
      return { kind: "anchor", ...anchorToMfp(c.anchor) };
    case "record":
      return { kind: "record", ref: c.id };
    default: {
      const unreachable: never = c;
      return unreachable;
    }
  }
};

/**
 * A 0.2 citation as Keel holds it. A tool result, a message ref that is not
 * `<session>/<seq>`, and an anchor with no commit (with none given for the
 * working one) have no Keel form. Whether the session is the caller's is the
 * edge's to check: a ref is one the driver gave.
 */
export const citationOfMfp = (
  c: MfpCitation,
  ctx: WireContext = {},
): Result.Result<Citation, Untellable> => {
  switch (c.kind) {
    case "message": {
      const [, session, seq] = MESSAGE_REF.exec(c.ref) ?? [];
      const n = Number(seq);
      return session === undefined || !Number.isSafeInteger(n)
        ? untellable("citation", "message-ref", `message ref "${c.ref}" is not <session>/<seq>`)
        : Result.succeed({ _tag: "message", session: SessionId.make(session), seq: n });
    }
    case "anchor":
      return Result.map(anchorOfMfp(c, ctx), (anchor) => ({ _tag: "anchor", anchor }));
    case "record":
      return Result.succeed({ _tag: "record", id: c.ref });
    case "tool-result":
      return untellable("citation", "tool-result", `tool result ${c.ref} has no Keel citation`);
    default: {
      const unreachable: never = c;
      return unreachable;
    }
  }
};

const shapeToMfp = (s: Shape): MfpShape | string => {
  switch (s._tag) {
    case "literal":
      return { type: "literal", value: s.value };
    case "array": {
      const items = shapeToMfp(s.of);
      return typeof items === "string" ? items : { type: "array", items };
    }
    case "union": {
      const of: MfpShape[] = [];
      for (const member of s.of) {
        const told = shapeToMfp(member);
        if (typeof told === "string") return told;
        of.push(told);
      }
      return { type: "union", of };
    }
    case "object": {
      const fields: MfpShapeField[] = [];
      for (const [name, field] of Object.entries(s.fields)) {
        if (name === "") return "a shape field has an empty name";
        const told = shapeToMfp(field.shape);
        if (typeof told === "string") return told;
        fields.push({ name, shape: told, optional: field.optional });
      }
      return { type: "object", fields };
    }
    case "opaque":
      return s.name === "" ? "an opaque shape has an empty name" : { type: "opaque", name: s.name };
    default:
      return { type: s._tag };
  }
};

/** A 0.2 shape as Keel writes it: `_tag`, then what the tag holds, an object's fields by name. */
const shapeOfMfp = (m: MfpShape): Shape | string => {
  switch (m.type) {
    case "literal":
      return { _tag: "literal", value: m.value };
    case "array": {
      const of = shapeOfMfp(m.items);
      return typeof of === "string" ? of : { _tag: "array", of };
    }
    case "union": {
      const of: Shape[] = [];
      for (const member of m.of) {
        const held = shapeOfMfp(member);
        if (typeof held === "string") return held;
        of.push(held);
      }
      return { _tag: "union", of };
    }
    case "object": {
      const fields: Record<string, Field> = {};
      for (const field of m.fields) {
        // A field Keel would read onto an object's prototype is one it cannot hold.
        if (field.name === "__proto__" || Object.hasOwn(fields, field.name))
          return `shape field "${field.name}" is repeated or reserved`;
        const held = shapeOfMfp(field.shape);
        if (typeof held === "string") return held;
        fields[field.name] = { shape: held, optional: field.optional };
      }
      return { _tag: "object", fields };
    }
    case "opaque":
      return { _tag: "opaque", name: m.name };
    default:
      return { _tag: m.type };
  }
};

/**
 * Tells a stored proposition in 0.2's form, where it reads in its role. Its
 * value goes as stored (a freshness, its authority writers in their written
 * order), its scope in canonical form, a bound with no unit as `1`. A premise
 * keeps the strength it was given and gains none; an effect has none, and a
 * unit on any predicate but a bound is dropped.
 */
const tell = (
  p: Proposition,
  role: "premise" | "effect",
): Result.Result<Record<string, unknown>, Untellable> => {
  const read = readClaim(p, role);
  if (Result.isFailure(read)) return untellable("proposition", "unreadable", read.failure.reason);
  const { claim } = read.success;
  let value: unknown = p.value;
  let unit: string | undefined;
  if (claim.predicate === "bound") {
    unit = p.unit === undefined || p.unit === "" ? UNITLESS : p.unit;
    if (!/^\S+$/.test(unit))
      return untellable("proposition", "unit", `bound unit "${unit}" has whitespace in it`);
  } else if (claim.predicate === "authority") {
    const writers = String(p.value)
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w !== "");
    const spaced = writers.find((w) => /\s/.test(w));
    if (spaced !== undefined)
      return untellable("proposition", "writer", `writer "${spaced}" has whitespace in it`);
    value = writers;
  } else if (claim.predicate === "shape") {
    const told = shapeToMfp(claim.value);
    if (typeof told === "string") return untellable("proposition", "shape-name", told);
    value = told;
  }
  const scope = writeScope(read.success.scope);
  return Result.succeed({
    subject: p.subject,
    predicate: p.predicate,
    relation: p.relation,
    value,
    ...(unit === undefined ? {} : { unit }),
    ...(role === "premise" && p.strength !== undefined ? { strength: p.strength } : {}),
    ...(scope === undefined ? {} : { scope }),
    ...(p.gloss === undefined ? {} : { gloss: p.gloss }),
    ...(p.anchors === undefined ? {} : { anchors: p.anchors.map(anchorToMfp) }),
    ...(p.cites === undefined ? {} : { cites: p.cites.map(citationToMfp) }),
  });
};

/** A stored premise in 0.2's form; one that does not read as a premise is untellable. */
export const premiseToMfp = (p: Proposition): Result.Result<MfpPremiseProposition, Untellable> =>
  Result.flatMap(tell(p, "premise"), (told) =>
    Result.mapError(
      Schema.decodeUnknownResult(MfpPremiseProposition)(told),
      (e) => new Untellable({ what: "proposition", reason: "unreadable", detail: e.message }),
    ),
  );

/** A stored effect in 0.2's form; one that does not read is untellable. */
export const effectToMfp = (p: Proposition): Result.Result<MfpEffectProposition, Untellable> =>
  Result.flatMap(tell(p, "effect"), (told) =>
    Result.mapError(
      Schema.decodeUnknownResult(MfpEffectProposition)(told),
      (e) => new Untellable({ what: "proposition", reason: "unreadable", detail: e.message }),
    ),
  );

/**
 * A 0.2 proposition as Keel stores it: an authority's writers joined in their
 * order, a shape as Keel's JSON, a bound's `1` as no unit, the scope in
 * canonical form. It must read in its role: 0.2's forms that pass its schema
 * and do not read (an invalidation's events out of order or repeated, an
 * ordering of an event to itself, a scope that repeats a dimension) are
 * refused, never repaired.
 */
const hold = (
  m: MfpPremiseProposition | MfpEffectProposition,
  role: "premise" | "effect",
  ctx: WireContext,
): Result.Result<Proposition, Untellable> => {
  let value: string | number | boolean;
  let unit: string | undefined;
  switch (m.predicate) {
    case "bound":
      value = m.value;
      unit = m.unit === UNITLESS ? undefined : m.unit;
      break;
    case "authority":
      value = m.value.join(",");
      break;
    case "shape": {
      const held = shapeOfMfp(m.value);
      if (typeof held === "string") return untellable("proposition", "shape-name", held);
      value = JSON.stringify(held);
      break;
    }
    default:
      value = m.value;
  }
  const anchors: Anchor[] = [];
  for (const a of m.anchors ?? []) {
    const anchor = anchorOfMfp(a, ctx);
    if (Result.isFailure(anchor)) return Result.fail(anchor.failure);
    anchors.push(anchor.success);
  }
  const cites: Citation[] = [];
  for (const c of m.cites ?? []) {
    const cite = citationOfMfp(c, ctx);
    if (Result.isFailure(cite)) return Result.fail(cite.failure);
    cites.push(cite.success);
  }
  const scope = readScope(m.scope);
  if (Result.isFailure(scope)) return untellable("proposition", "unreadable", scope.failure);
  const canonical = writeScope(scope.success);
  const strength = "strength" in m ? m.strength : undefined;
  const p: Proposition = {
    subject: m.subject,
    predicate: m.predicate,
    relation: m.relation,
    value,
    ...(unit === undefined ? {} : { unit }),
    ...(canonical === undefined ? {} : { scope: canonical }),
    ...(m.anchors === undefined ? {} : { anchors }),
    ...(m.gloss === undefined ? {} : { gloss: m.gloss }),
    ...(strength === undefined ? {} : { strength }),
    ...(m.cites === undefined ? {} : { cites }),
  };
  const read = readClaim(p, role);
  return Result.isFailure(read)
    ? untellable("proposition", "unreadable", read.failure.reason)
    : Result.succeed(p);
};

/** A 0.2 premise as Keel stores it, or why it cannot be. */
export const premiseOfMfp = (
  m: MfpPremiseProposition,
  ctx: WireContext = {},
): Result.Result<Proposition, Untellable> => hold(m, "premise", ctx);

/** A 0.2 effect as Keel stores it, or why it cannot be. */
export const effectOfMfp = (
  m: MfpEffectProposition,
  ctx: WireContext = {},
): Result.Result<Proposition, Untellable> => hold(m, "effect", ctx);

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** A premise's 0.2 form as compared for retraction: an absent strength is `must`. */
const imageKey = (m: MfpPremiseProposition): string =>
  canonicalJson(asJson({ ...m, strength: m.strength ?? "must" }));

/**
 * The stored premise a 0.2 premise retracts: the one whose 0.2 form is the
 * same, the retracted one taken through Keel and back where it can be. Keel
 * compares stored premises byte for byte; this lets an agent retract a premise
 * by echoing what Keel told it, one stored in an older spelling included.
 */
export const retractedBy = (
  stored: readonly Proposition[],
  m: MfpPremiseProposition,
  ctx: WireContext = {},
): Proposition | undefined => {
  const told = Result.flatMap(premiseOfMfp(m, ctx), premiseToMfp);
  const wanted = imageKey(Result.isSuccess(told) ? told.success : m);
  return stored.find((p) => {
    const image = premiseToMfp(p);
    return Result.isSuccess(image) && imageKey(image.success) === wanted;
  });
};
