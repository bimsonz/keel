import { openApiDocument } from "@keeltown/contracts";
import { CoordinationEvent } from "@keeltown/core/domain/coordination";
import { DeliveryEvent } from "@keeltown/core/domain/delivery";
import { IdentityEvent } from "@keeltown/core/domain/identity";
import { IntegrationEvent } from "@keeltown/core/domain/integration";
import { Actor } from "@keeltown/core/domain/kernel";
import { MemoryEvent } from "@keeltown/core/domain/memory";
import { VerificationEvent } from "@keeltown/core/domain/verification";
import { Schema, SchemaRepresentation } from "effect";
import { describe, expect, it } from "vitest";

/**
 * The event catalogue exists twice: as Effect Schemas in core, and as TypeSpec
 * models in `packages/spec/events.tsp`, which public consumers read through
 * `@keeltown/contracts` (rule R9 keeps them out of core). This test keeps the
 * two equal: the same events, and for each the same JSON form, compared as JSON
 * Schema after the normalisations below. Each normalisation unifies two
 * spellings of one meaning; none may hide a difference a consumer could see.
 */

type Representation = SchemaRepresentation.Representation;
type Check = SchemaRepresentation.Check;
type JsonObject = { readonly [key: string]: unknown };

interface TaggedMember extends Schema.Top {
  readonly fields: { readonly _tag: { readonly schema: { readonly literal: unknown } } };
}

/** Each member of core's context unions, with the name its `_tag` gives it. */
function byTag(
  ...unions: readonly { readonly members: readonly TaggedMember[] }[]
): (readonly [string, Schema.Top])[] {
  return unions.flatMap((union) =>
    union.members.map((member) => [String(member.fields._tag.schema.literal), member] as const),
  );
}

const catalogue = byTag(
  IdentityEvent,
  CoordinationEvent,
  VerificationEvent,
  IntegrationEvent,
  MemoryEvent,
  DeliveryEvent,
);
const events = new Map(catalogue);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `object.key.key…`, or undefined where the path runs out. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return current;
}

// ─── Core's side ────────────────────────────────────────────────────────────

/** ASCII only, and a valid pattern in both modes. */
function readsAlikeInUnicodeMode(source: string): boolean {
  if (!/^[\x20-\x7e]*$/.test(source)) return false;
  try {
    return new RegExp(source, "u").source === new RegExp(source).source;
  } catch {
    return false;
  }
}

/**
 * Effect leaves out a pattern whose RegExp has no `u` flag, because JSON Schema
 * reads every pattern in Unicode mode and the two modes can disagree. Core's
 * patterns have no flags and only ASCII, where the modes agree, so the pattern
 * is put back. Anything else fails here rather than being guessed at.
 */
function exportPattern(check: Check): Check {
  if (check._tag === "FilterGroup") {
    const [first, ...rest] = check.checks;
    return { ...check, checks: [exportPattern(first), ...rest.map(exportPattern)] };
  }
  if (check.representation?.id !== "effect/schema/isPattern") return check;
  const payload = check.representation.payload;
  const source = at(payload, "source");
  const flags = at(payload, "flags");
  if (typeof flags === "string" && flags.includes("u")) return check;
  if (typeof source !== "string" || flags !== "" || !readsAlikeInUnicodeMode(source))
    throw new Error(`cannot vouch for the pattern ${JSON.stringify(payload)} in Unicode mode`);
  return {
    ...check,
    annotations: { ...check.annotations, toJsonSchema: () => ({ pattern: source }) },
  };
}

/**
 * `Schema.optional(X)` is an optional key holding `X | undefined`. JSON has no
 * undefined, so on the wire such a key is simply absent: the outbox
 * JSON-stringifies payloads, which drops it, and core's decoders refuse a null
 * there. That is what TypeSpec's `?` says. Effect's compiler writes the
 * undefined as null instead (its JSON codec reads null back as undefined), so
 * the undefined member of an optional key's union is dropped before compiling.
 * A null core actually declares, with `NullOr`, is kept.
 */
function optionalKeyIsAbsence(type: Representation): Representation {
  if (type._tag !== "Union") return type;
  const defined = type.types.filter((member) => member._tag !== "Undefined");
  const [only] = defined;
  if (defined.length === type.types.length) return type;
  return defined.length === 1 && only !== undefined && type.checks.length === 0
    ? only
    : { ...type, types: defined };
}

/** Applies the two rewrites through a representation. */
function rewrite(node: Representation): Representation {
  if (node._tag === "Reference") return node;
  if (node._tag === "Suspend") return { ...node, thunk: rewrite(node.thunk) };
  const checks = node.checks.map(exportPattern);
  switch (node._tag) {
    case "Declaration":
      return { ...node, checks, typeParameters: node.typeParameters.map(rewrite) };
    case "TemplateLiteral":
      return { ...node, checks, parts: node.parts.map(rewrite) };
    case "Arrays":
      return {
        ...node,
        checks,
        elements: node.elements.map((element) => ({ ...element, type: rewrite(element.type) })),
        rest: node.rest.map(rewrite),
      };
    case "Objects":
      return {
        ...node,
        checks,
        propertySignatures: node.propertySignatures.map((property) => ({
          ...property,
          type: rewrite(property.isOptional ? optionalKeyIsAbsence(property.type) : property.type),
        })),
        indexSignatures: node.indexSignatures.map((index) => ({
          parameter: rewrite(index.parameter),
          type: rewrite(index.type),
        })),
      };
    case "Union":
      return { ...node, checks, types: node.types.map(rewrite) };
    default:
      return { ...node, checks };
  }
}

/**
 * Excess properties are a decoding option in Effect, not part of a schema. The
 * API seals every object (`seal-object-schemas`), so core is compiled under the
 * same reading and sealing is then compared like any other keyword.
 */
const SEALED = { onExcessProperty: "error" } as const;

/**
 * What `Schema.toJsonSchemaDocument` does (lower the schema to its
 * representation, then compile that), with the two rewrites in between.
 */
function coreDocument(event: Schema.Top) {
  const lowered = SchemaRepresentation.toRepresentation(event.ast);
  return SchemaRepresentation.toJsonSchemaDocument(
    {
      representation: rewrite(lowered.representation),
      references: Object.fromEntries(
        Object.entries(lowered.references).map(([name, node]) => [name, rewrite(node)]),
      ),
    },
    SEALED,
  );
}

/** Resolves a document's `$ref`s against its own definitions. */
type Resolver = (ref: string) => unknown;

function effectResolver(definitions: JsonObject): Resolver {
  return (ref) => {
    const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
    if (name === undefined || !(name in definitions)) throw new Error(`unresolved $ref ${ref}`);
    return definitions[name];
  };
}

// ─── The spec's side ────────────────────────────────────────────────────────

const document: unknown = openApiDocument;
const components = at(document, "components", "schemas");
const schemas: JsonObject = isRecord(components) ? components : {};

const specResolver: Resolver = (ref) => {
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  if (name === undefined || !(name in schemas)) throw new Error(`unresolved $ref ${ref}`);
  return schemas[name];
};

/** The component names a union lists, by `$ref`. */
function membersOf(union: unknown): string[] {
  const members = at(union, "anyOf");
  return (Array.isArray(members) ? members : []).map((member: unknown) =>
    String(at(member, "$ref")).replace("#/components/schemas/", ""),
  );
}

// ─── Normalising both sides ─────────────────────────────────────────────────

/** Keywords that annotate without constraining: JSON Schema's meta-data vocabulary, and OpenAPI's `example`. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "example",
]);

/** Annotations say nothing about the wire. */
function dropAnnotations(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !ANNOTATIONS.has(key)));
}

/**
 * A documented reference: OpenAPI 3.0 ignores a `$ref`'s siblings, so TypeSpec
 * wraps the reference in a one-member `allOf` to give its description a place.
 * Only an `allOf` with nothing beside it is unwrapped.
 */
function singleAllOf(schema: JsonObject): JsonObject {
  const allOf = schema["allOf"];
  if (!Array.isArray(allOf) || allOf.length !== 1 || Object.keys(schema).length !== 1)
    return schema;
  const [only]: unknown[] = allOf;
  return isRecord(only) ? only : schema;
}

/** `{not: {}}` admits nothing, as `false` does: both seal an object. */
function sealed(schema: JsonObject): JsonObject {
  const extra = schema["additionalProperties"];
  return isRecord(extra) && isRecord(extra["not"]) && Object.keys(extra["not"]).length === 0
    ? { ...schema, additionalProperties: false }
    : schema;
}

/** `additionalProperties: {}` admits anything, as leaving it out does. */
function openObject(schema: JsonObject): JsonObject {
  const extra = schema["additionalProperties"];
  if (!isRecord(extra) || Object.keys(extra).length > 0) return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "additionalProperties"),
  );
}

const NON_FINITE = ["-Infinity", "Infinity", "NaN"];

/**
 * `Schema.Number` admits ±Infinity and NaN, which Effect's JSON codec writes as
 * strings, so its JSON Schema is `number` or one of those three strings. No
 * such string can reach Keel's wire: payloads are JSON-stringified, and core's
 * decoders take numbers only. The wire carries a JSON number, as the spec says.
 */
function finiteNumber(schema: JsonObject): JsonObject {
  const anyOf = schema["anyOf"];
  if (!Array.isArray(anyOf) || anyOf.length !== 2 || Object.keys(schema).length !== 1)
    return schema;
  const [number, strings]: unknown[] = anyOf;
  const isNumber =
    isRecord(number) && number["type"] === "number" && Object.keys(number).length === 1;
  const values = at(strings, "enum");
  const isNonFinite =
    isRecord(strings) &&
    strings["type"] === "string" &&
    Object.keys(strings).length === 2 &&
    Array.isArray(values) &&
    JSON.stringify(values.map(String).toSorted()) === JSON.stringify(NON_FINITE);
  return isNumber && isNonFinite ? { type: "number" } : schema;
}

/** A JavaScript number is an IEEE 754 double: `format: double` restates `type: number`. */
function doubleFormat(schema: JsonObject): JsonObject {
  if (schema["type"] !== "number" || schema["format"] !== "double") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "format"));
}

/** `required` and `enum` are sets: their order means nothing. */
function sets(schema: JsonObject): JsonObject {
  const out: Record<string, unknown> = { ...schema };
  const required = schema["required"];
  if (Array.isArray(required)) out["required"] = required.map(String).toSorted();
  const values = schema["enum"];
  if (Array.isArray(values))
    out["enum"] = values.toSorted((a: unknown, b: unknown) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  return out;
}

/** Applied in order, at every schema, on both sides. */
const RULES: readonly ((schema: JsonObject) => JsonObject)[] = [
  dropAnnotations,
  singleAllOf,
  sealed,
  openObject,
  finiteNumber,
  doubleFormat,
  sets,
];

/** Keywords whose value maps names to schemas, rather than being a schema. */
const NAMED = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * Normalises a schema, inlining each `$ref` through `resolve` (`through` holds
 * the refs being inlined, against recursion). A `$ref` with a constraint beside
 * it fails: inlining would drop the constraint.
 */
function normalise(node: unknown, resolve: Resolver, through: readonly string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item: unknown) => normalise(item, resolve, through));
  if (!isRecord(node)) return node;
  const schema = RULES.reduce((current, rule) => rule(current), node);
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (Object.keys(schema).length > 1) throw new Error(`a constraint beside $ref ${ref}`);
    if (through.includes(ref)) throw new Error(`recursive $ref ${ref}: inline it by hand`);
    return normalise(resolve(ref), resolve, [...through, ref]);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      NAMED.has(key) && isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              normalise(child, resolve, through),
            ]),
          )
        : normalise(value, resolve, through),
    ]),
  );
}

// ─── Comparing ──────────────────────────────────────────────────────────────

interface Difference {
  readonly path: string;
  readonly core: unknown;
  readonly spec: unknown;
}

function step(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** The first place two JSON values differ, as a JSON path, or undefined when they are equal. */
function firstDifference(core: unknown, spec: unknown, path = "$"): Difference | undefined {
  if (Array.isArray(core) && Array.isArray(spec)) {
    for (let i = 0; i < Math.max(core.length, spec.length); i++) {
      const found = firstDifference(core[i], spec[i], step(path, i));
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(core) && isRecord(spec)) {
    const keys = [...new Set([...Object.keys(core), ...Object.keys(spec)])].toSorted();
    for (const key of keys) {
      const found = firstDifference(core[key], spec[key], step(path, key));
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return Object.is(core, spec) ? undefined : { path, core, spec };
}

function show(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

function describeDifference(event: string, difference: Difference): string {
  return `${event} differs at ${difference.path}: core has ${show(difference.core)}, the spec ${show(difference.spec)}`;
}

/** Core's JSON Schema for an event and the spec's component, both normalised. */
function sides(name: string, event: Schema.Top): { core: unknown; spec: unknown } {
  const compiled = coreDocument(event);
  return {
    core: normalise(compiled.schema, effectResolver(compiled.definitions)),
    spec: normalise(schemas[name], specResolver),
  };
}

/** Core's compiled JSON Schema for a struct's one field. */
function fieldOf(field: Schema.Top): unknown {
  return at(coreDocument(Schema.Struct({ field })).schema, "properties", "field");
}

describe("the event catalogue: core's Effect Schemas and the spec's KeelEvent", () => {
  it("[events.conform] publishes every core event, and only those, each in its core JSON form", () => {
    const names = [...events.keys()].toSorted();
    expect(events.size, "core's unions repeat an event name").toBe(catalogue.length);
    expect(
      names.filter((name) => !(name in schemas)),
      "core events with no component schema",
    ).toEqual([]);
    expect(membersOf(schemas["KeelEvent"]).toSorted(), "KeelEvent's members").toEqual(names);
    const payload = at(schemas, "EventRecord", "properties", "payload");
    expect(
      isRecord(payload) && singleAllOf(dropAnnotations(payload)),
      "EventRecord.payload",
    ).toEqual({
      $ref: "#/components/schemas/KeelEvent",
    });

    const differences = [...events].flatMap(([name, event]) => {
      const { core, spec } = sides(name, event);
      const difference = firstDifference(core, spec);
      return difference === undefined ? [] : [describeDifference(name, difference)];
    });
    expect(differences).toEqual([]);
  });

  it("[events.envelope] publishes EventRecord's optional actor, project and label; a label is D-n, G-n, C-n, E-n, P-n or a change's #n", () => {
    const record = at(schemas, "EventRecord");
    const field = (name: string) => {
      const property = at(record, "properties", name);
      return isRecord(property) ? singleAllOf(dropAnnotations(property)) : property;
    };
    expect(field("actor")).toEqual({ $ref: "#/components/schemas/EventActor" });
    expect(field("project")).toEqual({ $ref: "#/components/schemas/ProjectId" });
    expect(field("label")).toEqual({ $ref: "#/components/schemas/EventLabel" });
    const required = at(record, "required");
    expect(Array.isArray(required) ? required : []).not.toEqual(expect.arrayContaining(["actor"]));
    const pattern = (name: string) => new RegExp(String(at(schemas, name, "pattern")), "u");
    const label = pattern("EventLabel");
    expect(
      ["D-1", "G-12", "C-3", "E-4", "P-50", "#1", "#27"].filter((l) => !label.test(l)),
    ).toEqual([]);
    expect(["#0", "D-0", "X-1", "#", "d-1", "#1a", "D-1 "].filter((l) => label.test(l))).toEqual(
      [],
    );
    const actor = pattern("EventActor");
    expect(actor.test("agent:agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0")).toBe(true);
    expect(actor.test("user:usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0")).toBe(true);
    expect(actor.test("operator:agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0")).toBe(true);
    expect(actor.test("agent:someone")).toBe(false);
    // Core's Actor is `operator:${NonEmptyString}`: an operator always has a name.
    expect(actor.test("operator:")).toBe(false);
    // The spec's pattern and core's Actor take the same strings: an agent or a user by its own
    // kind of id, an operator by any name, and nothing else.
    const isActor = Schema.is(Actor);
    const candidates = [
      "agent:agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "user:usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "operator:zach",
      "operator:usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "user:",
      "user:someone",
      "user:agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "user:usr_01jz8pt2c4e6g8j0m2n4q6s8v0",
      "user:usr_01JZ8PT2C4E6G8J0M2N4Q6S8V00",
      "agent:usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "org:org_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "",
    ];
    expect(candidates.filter((candidate) => actor.test(candidate))).toEqual(candidates.slice(0, 4));
    expect(candidates.filter((candidate) => isActor(candidate))).toEqual(candidates.slice(0, 4));
  });

  it("compiles core's events as Schema.toJsonSchemaDocument does, before the rewrites", () => {
    for (const [name, event] of events) {
      const lowered = SchemaRepresentation.toRepresentation(event.ast);
      const compiled = SchemaRepresentation.toJsonSchemaDocument(lowered, SEALED);
      const reference = Schema.toJsonSchemaDocument(event, SEALED);
      const difference = firstDifference(
        normalise(compiled.schema, effectResolver(compiled.definitions)),
        normalise(reference.schema, effectResolver(reference.definitions)),
      );
      expect(
        difference === undefined ? undefined : describeDifference(name, difference),
      ).toBeUndefined();
    }
  });

  it("normalises only spellings that mean the same", () => {
    // A null core declares survives the optional-key rewrite.
    expect(fieldOf(Schema.optional(Schema.NullOr(Schema.String)))).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(fieldOf(Schema.optionalKey(Schema.NullOr(Schema.String)))).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    // A pattern the rewrite cannot vouch for fails rather than vanishing.
    expect(() => coreDocument(Schema.String.check(Schema.isPattern(/^é+$/)))).toThrow(
      /cannot vouch/,
    );
    // Strings beside a number are kept unless they are exactly the non-finite three.
    const loose = {
      anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "NaN", "x"] }],
    };
    expect(normalise(loose, specResolver)).toEqual(loose);
    // A one-member allOf with a constraint beside it is not unwrapped.
    const constrained = { allOf: [{ type: "string" }], minLength: 1 };
    expect(normalise(constrained, specResolver)).toEqual(constrained);
  });
});
