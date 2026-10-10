import type { ClaimRelation, RegionDecision, Tri } from "./lattice.ts";

/**
 * A small structural type language for the `shape` predicate. `opaque` is a
 * named shape Keel could not see into; anything involving one is undecidable.
 */
export type Shape =
  | { readonly _tag: "unknown" }
  | { readonly _tag: "never" }
  | { readonly _tag: "string" }
  | { readonly _tag: "number" }
  | { readonly _tag: "boolean" }
  | { readonly _tag: "null" }
  | { readonly _tag: "literal"; readonly value: string | number | boolean }
  | { readonly _tag: "array"; readonly of: Shape }
  | { readonly _tag: "object"; readonly fields: { readonly [name: string]: Field } }
  | { readonly _tag: "union"; readonly of: readonly Shape[] }
  | { readonly _tag: "opaque"; readonly name: string };

export type Field = { readonly shape: Shape; readonly optional: boolean };

const and = (xs: readonly Tri[]): Tri => (xs.includes(false) ? false : xs.includes("unknown") ? "unknown" : true);
const or = (xs: readonly Tri[]): Tri => (xs.includes(true) ? true : xs.includes("unknown") ? "unknown" : false);

/** Structural assignability, `s` to `t`, with width subtyping on objects. */
export const assignable = (s: Shape, t: Shape): Tri => {
  if (t._tag === "unknown" || s._tag === "never") return true;
  if (s._tag === "union") return and(s.of.map((m) => assignable(m, t)));
  if (t._tag === "union") return or(t.of.map((m) => assignable(s, m)));
  if (s._tag === "opaque" || t._tag === "opaque") {
    return s._tag === "opaque" && t._tag === "opaque" && s.name === t.name ? true : "unknown";
  }
  switch (s._tag) {
    case "unknown":
    case "string":
    case "number":
    case "boolean":
    case "null":
      return s._tag === t._tag;
    case "literal":
      return t._tag === "literal" ? t.value === s.value : t._tag === typeof s.value;
    case "array":
      return t._tag === "array" ? assignable(s.of, t.of) : false;
    default:
      if (t._tag !== "object") return false;
      return and(
        Object.entries(t.fields).map(([name, want]) => {
          const have = s.fields[name];
          if (have === undefined) return want.optional;
          if (have.optional && !want.optional) return false;
          return assignable(have.shape, want.shape);
        }),
      );
  }
};

const decide = (t: Tri): RegionDecision => (t === true ? "within" : t === false ? "disjoint" : "overlap");

/**
 * `at-most T`: the subject's shape is assignable to T (a reader relies on it);
 * `at-least T`: T is assignable to it (a writer relies on passing T);
 * `is T`: both. A point effect decides outright; a ranged effect can only
 * be shown to sit inside the premise.
 */
export const shapeDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Shape },
  e: { readonly relation: ClaimRelation; readonly value: Shape },
): RegionDecision => {
  if (e.relation === "is") {
    const x = e.value;
    return decide(
      p.relation === "at-most"
        ? assignable(x, p.value)
        : p.relation === "at-least"
          ? assignable(p.value, x)
          : and([assignable(x, p.value), assignable(p.value, x)]),
    );
  }
  if (e.relation === p.relation) {
    const inside = e.relation === "at-most" ? assignable(e.value, p.value) : assignable(p.value, e.value);
    if (inside === true) return "within";
  }
  return "overlap";
};

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a decoded JSON value as a Shape, or undefined if it is not one. */
export const readShape = (v: unknown): Shape | undefined => {
  if (!isRecord(v)) return undefined;
  switch (v["_tag"]) {
    case "unknown":
    case "never":
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { _tag: v["_tag"] };
    case "literal": {
      const value = v["value"];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? { _tag: "literal", value }
        : undefined;
    }
    case "opaque":
      return typeof v["name"] === "string" ? { _tag: "opaque", name: v["name"] } : undefined;
    case "array": {
      const of = readShape(v["of"]);
      return of === undefined ? undefined : { _tag: "array", of };
    }
    case "union": {
      const members = v["of"];
      if (!Array.isArray(members)) return undefined;
      const of = members.map(readShape);
      return of.every((m) => m !== undefined) ? { _tag: "union", of } : undefined;
    }
    case "object": {
      const fields = v["fields"];
      if (!isRecord(fields)) return undefined;
      const read: Record<string, Field> = {};
      for (const [name, field] of Object.entries(fields)) {
        if (!isRecord(field) || typeof field["optional"] !== "boolean") return undefined;
        const shape = readShape(field["shape"]);
        if (shape === undefined) return undefined;
        read[name] = { shape, optional: field["optional"] };
      }
      return { _tag: "object", fields: read };
    }
    default:
      return undefined;
  }
};
