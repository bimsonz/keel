import { Schema } from "effect";

/** A repository path pattern, e.g. `src/authz/**` or `*.tf`, used by footprints, protected paths and step selection. */
export const Glob = Schema.NonEmptyString.pipe(Schema.brand("Glob"));
export type Glob = typeof Glob.Type;
