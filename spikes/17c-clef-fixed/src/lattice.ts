// Per-predicate lattices and the deterministic premise/effect comparison.
// Chains run from the strongest guarantee to the weakest. A premise with
// relation "le" holds while the effect is no weaker than the premise value.
// "shape" is a flat lattice compared with "eq".

export type Predicate =
  | "freshness"
  | "cardinality"
  | "ordering"
  | "consistency"
  | "presence"
  | "authority"
  | "purity"
  | "bound"
  | "shape";

export type Relation = "le" | "eq";

export interface Lattice {
  relation: Relation;
  values: readonly string[];
  describe: Record<string, string>;
}

export const UNCLEAR = "unclear";

export const LATTICES: Record<Predicate, Lattice> = {
  freshness: {
    relation: "le",
    values: ["per-call", "per-request", "per-session", "ttl", "static"],
    describe: {
      "per-call": "Recomputed on every call or evaluation; nothing is cached or memoised.",
      "per-request":
        "Computed at most once per incoming request and reused only within that same request.",
      "per-session":
        "Computed once and reused for the lifetime of a user, client or connection session, across requests.",
      ttl: "Cached across requests and sessions, and reused until a time-to-live expires.",
      static:
        "Computed once (at import, startup, build or deploy) and never refreshed while the process runs.",
    },
  },
  cardinality: {
    relation: "le",
    values: ["exactly-one", "at-most-one", "many"],
    describe: {
      "exactly-one": "Exactly one instance exists at any time; existence and uniqueness are both enforced.",
      "at-most-one": "Zero or one instance; uniqueness is enforced but existence is not.",
      many: "Any number may exist at once; nothing enforces uniqueness.",
    },
  },
  ordering: {
    relation: "le",
    values: ["fifo", "per-key-fifo", "unordered"],
    describe: {
      fifo: "Every item is processed in the exact order it was produced: one total order.",
      "per-key-fifo":
        "Order is preserved only among items that share a key or partition; there is no order across keys.",
      unordered:
        "No ordering guarantee; items may be processed in any order, for example by concurrent workers.",
    },
  },
  consistency: {
    relation: "le",
    values: ["strong", "read-your-writes", "eventual"],
    describe: {
      strong: "Every read observes the latest committed write, for every reader.",
      "read-your-writes":
        "A writer always observes its own writes, but other readers may briefly see stale data.",
      eventual: "Any reader, including the writer, may see stale data until replication or a cache catches up.",
    },
  },
  presence: {
    relation: "le",
    values: ["required", "optional", "absent"],
    describe: {
      required: "Always present; a value without it is rejected or never produced.",
      optional: "May be missing or null; consumers must handle its absence.",
      absent: "Never present; it has been removed.",
    },
  },
  authority: {
    relation: "le",
    values: ["owner", "admin", "maintainer", "member", "authenticated", "anyone"],
    describe: {
      owner: "Only the owner of the resource may perform the action.",
      admin: "Owners and admins may perform the action.",
      maintainer: "Owners, admins and maintainers may perform the action.",
      member: "Any member of the organisation, team or repository may perform the action, whatever their role.",
      authenticated: "Any authenticated principal may perform the action, including non-members.",
      anyone: "Anyone may perform the action, including unauthenticated callers.",
    },
  },
  purity: {
    relation: "le",
    values: ["pure", "idempotent", "non-idempotent"],
    describe: {
      pure: "No side effects; the result depends only on the inputs.",
      idempotent:
        "Has side effects, but repeating the call with the same inputs leaves the same end state.",
      "non-idempotent":
        "Repeating the call changes the end state again, for example duplicate rows, double charges or increments.",
    },
  },
  bound: {
    relation: "le",
    values: ["le-1", "le-10", "le-100", "le-1k", "le-10k", "le-100k", "le-1m", "unbounded"],
    describe: {
      "le-1": "The enforced limit is at most 1.",
      "le-10": "The enforced limit is between 2 and 10.",
      "le-100": "The enforced limit is between 11 and 100.",
      "le-1k": "The enforced limit is between 101 and 1,000.",
      "le-10k": "The enforced limit is between 1,001 and 10,000.",
      "le-100k": "The enforced limit is between 10,001 and 100,000.",
      "le-1m": "The enforced limit is between 100,001 and 1,000,000.",
      unbounded: "No limit is enforced, or the limit is above 1,000,000.",
    },
  },
  shape: {
    relation: "eq",
    values: ["integer", "number", "string", "boolean", "array", "object"],
    describe: {
      integer: "A whole number on the wire (int, int64, bigint).",
      number: "A number that may be fractional (float, double, decimal as a JSON number).",
      string: "A string on the wire, including encoded numbers, dates and identifiers.",
      boolean: "true or false.",
      array: "A list.",
      object: "A nested object or map.",
    },
  },
};

export interface Premise {
  subject: string;
  predicate: Predicate;
  relation: Relation;
  value: string;
  scope: string;
}

export type Verdict = "contradiction" | "compatible" | "abstain";

/** Deterministic comparison of an effect value with a premise on its predicate's lattice. */
export function compare(premise: Premise, effectValue: string): Verdict {
  const lattice = LATTICES[premise.predicate];
  if (effectValue === UNCLEAR) return "abstain";
  if (!lattice.values.includes(effectValue)) throw new Error(`unknown ${premise.predicate} value ${effectValue}`);
  if (!lattice.values.includes(premise.value)) throw new Error(`unknown premise value ${premise.value}`);
  if (premise.relation !== lattice.relation) throw new Error(`${premise.predicate} uses ${lattice.relation}`);
  if (lattice.relation === "eq") return effectValue === premise.value ? "compatible" : "contradiction";
  return lattice.values.indexOf(effectValue) > lattice.values.indexOf(premise.value) ? "contradiction" : "compatible";
}

/** Lattice values that would contradict the premise; used to sum a contradiction probability. */
export function violating(premise: Premise): string[] {
  return LATTICES[premise.predicate].values.filter((v) => compare(premise, v) === "contradiction");
}

export function optionsFor(predicate: Predicate): string[] {
  return [...LATTICES[predicate].values, UNCLEAR];
}
