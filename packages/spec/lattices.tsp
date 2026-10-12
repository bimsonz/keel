import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";

using Http;
using OpenAPI;

namespace Keel;

/** A parametric family drawn as one value, e.g. `ttl:<n>`, its members ordered by the parameter. */
model LatticeFamily {
  name: "ttl" | "bounded";

  /** `larger`: a larger parameter sits higher (`ttl:10` ≤ `ttl:20`). */
  higher: "larger" | "smaller";
}

/** A value as a proposition writes it, or a family's placeholder. */
model LatticeValue {
  id: string;
  family?: LatticeFamily;
}

/** One edge of the Hasse diagram: `lower` is immediately below `upper`. */
model LatticeCover {
  lower: string;
  upper: string;
}

/**
 * A predicate's lattice, on the order claims are read on (`at-most v` is
 * everything at or below v). Without `shape` it is the finite order its values
 * and covers draw; values with no covers are unordered. With `shape` its values
 * are not enumerable: writer sets under ⊆ (`set`), numbers per unit
 * (`numeric`), structural types under subtyping (`structural`), before/after
 * pairs (`sequence`), or free text a model compares (`free-form`).
 */
model Lattice {
  predicate: MFP.Predicate;
  shape?: "set" | "numeric" | "structural" | "sequence" | "free-form";
  values: LatticeValue[];
  covers: LatticeCover[];
}

model LatticeSet {
  /** One per predicate. */
  items: Lattice[];
}

@tag("Lattices")
@route("/lattices")
interface Lattices {
  /** Each predicate's lattice, as data: what a premise or an effect can say, and how values order. */
  @summary("List the lattices")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @get
  listLattices(): LatticeSet | StandardErrors;
}
