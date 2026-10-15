/**
 * A premise as an agent writes one, read into MFP 0.2's form before it is
 * decoded: an agent names a function as `checkColor()` and a predicate as
 * "pure", and declare would otherwise refuse it on the key's pattern and the
 * predicate's list. What reads one way only is read that way; what does not
 * is left as sent, so the decode refuses it and says what to write.
 */

const PREDICATES = new Set([
  "freshness",
  "consistency",
  "cardinality",
  "bound",
  "presence",
  "purity",
  "idempotent",
  "authority",
  "shape",
  "ordering",
  "invariant",
]);

/** Words an agent uses for a predicate, as MFP names it. */
const SYNONYMS: Readonly<Record<string, string>> = {
  pure: "purity",
  "side-effect-free": "purity",
  "no-side-effects": "purity",
  "side-effects": "purity",
  idempotence: "idempotent",
  idempotency: "idempotent",
  fresh: "freshness",
  staleness: "freshness",
  cached: "freshness",
  consistent: "consistency",
  count: "cardinality",
  times: "cardinality",
  limit: "bound",
  maximum: "bound",
  max: "bound",
  minimum: "bound",
  min: "bound",
  exists: "presence",
  present: "presence",
  defined: "presence",
  owner: "authority",
  owned: "authority",
  writer: "authority",
  type: "shape",
  schema: "shape",
  signature: "shape",
  order: "ordering",
  ordered: "ordering",
  always: "invariant",
  holds: "invariant",
  rule: "invariant",
  contract: "invariant",
  behaviour: "invariant",
  behavior: "invariant",
};

/** Predicates whose value says yes or no. */
const YES_NO = new Set(["presence", "purity", "idempotent"]);

const RELATIONS: Readonly<Record<string, string>> = {
  ordering: "before",
  bound: "at-most",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A word as MFP spells its enums: lower case, words joined by hyphens. */
const spelled = (word: string): string =>
  word
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

/**
 * A subject as Keel keys one: lower case, a path's or a member's separators
 * as dots, every other run of punctuation as one hyphen. `src/color.ts#checkColor()`
 * reads as `src.color.ts.check-color`.
 */
export const subjectKeyOf = (subject: string): string =>
  subject
    .trim()
    .replace(/\([^)]*\)/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/::|[/#\\]/g, ".")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-*\.+-*/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");

const predicateOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const word = spelled(raw);
  return PREDICATES.has(word) ? word : SYNONYMS[word];
};

/** A yes-or-no value as an agent writes one. */
const yesNo = (value: unknown): unknown => {
  if (value === undefined) return true;
  if (typeof value !== "string") return value;
  const word = spelled(value);
  if (["true", "yes", "pure", "present", "idempotent"].includes(word)) return true;
  if (["false", "no", "impure", "absent", "not-idempotent"].includes(word)) return false;
  return value;
};

/** A bound written with its unit, `200ms` or `"5 requests/s"`. */
const boundOf = (value: unknown, unit: unknown) => {
  if (typeof value !== "string") return { value, ...(unit === undefined ? {} : { unit }) };
  const named = /^\s*(-?[0-9]+(?:\.[0-9]+)?)\s*(\S*)\s*$/.exec(value);
  if (named === null) return { value, ...(unit === undefined ? {} : { unit }) };
  const written = named[2] === "" ? unit : named[2];
  return { value: Number(named[1]), ...(written === undefined ? {} : { unit: written }) };
};

/**
 * One premise as declare, revise and rely take it, in MFP 0.2's form where it
 * reads only one way. Anything that is not an object is left as sent.
 */
export function premiseOfAgent(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw["subject"] === "string") out["subject"] = subjectKeyOf(raw["subject"]);
  // A premise that names no predicate is a claim in words: an invariant.
  const predicate =
    raw["predicate"] === undefined
      ? "invariant"
      : (predicateOf(raw["predicate"]) ?? raw["predicate"]);
  out["predicate"] = predicate;
  if (typeof predicate !== "string" || !PREDICATES.has(predicate)) return out;
  out["relation"] =
    typeof raw["relation"] === "string" ? spelled(raw["relation"]) : (RELATIONS[predicate] ?? "is");
  const value = raw["value"];
  if (YES_NO.has(predicate)) out["value"] = yesNo(value);
  else if (predicate === "invariant")
    out["value"] =
      typeof value === "string" ? value : value === undefined ? "holds" : JSON.stringify(value);
  else if (predicate === "ordering" && typeof value === "string")
    out["value"] = subjectKeyOf(value);
  else if (predicate === "authority" && typeof value === "string") out["value"] = [value];
  else if (predicate === "bound") Object.assign(out, boundOf(value, raw["unit"]));
  else if (
    (predicate === "cardinality" || predicate === "freshness" || predicate === "consistency") &&
    typeof value === "string"
  )
    out["value"] = spelled(value) === "once" ? "exactly-once" : spelled(value);
  if (typeof raw["strength"] === "string") out["strength"] = spelled(raw["strength"]);
  return out;
}

/** The premise every refusal shows, as declare takes it. */
export const PREMISE_EXAMPLE = {
  subject: "color.check-color",
  predicate: "purity",
  relation: "is",
  value: true,
} as const;

/** What a refusal of a premise says to write, with the predicates MFP takes. */
export const PREMISE_HELP = `Write each premise as {"subject": "<a name, e.g. color.check-color>", "predicate": "<one of ${[...PREDICATES].join(", ")}>", "relation": "is", "value": <its value>}; for example ${JSON.stringify(PREMISE_EXAMPLE)}. A claim in words is {"subject": "...", "predicate": "invariant", "value": "<the claim>"}.`;
