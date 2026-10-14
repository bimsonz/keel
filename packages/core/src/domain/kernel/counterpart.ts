import { Schema } from "effect";
import { CommitSha } from "./hash.ts";
import { ChangeId } from "./ids.ts";

/**
 * What a change that bounced on a textual conflict conflicts with: a trunk
 * commit landed since the change's base that changed one of the conflicting
 * paths. `changeId` is the change Keel landed as that commit, from its
 * `Change-Id` trailer; a commit Keel did not land (an import, a seed) names
 * none. `paths` are the conflicting paths the commit changed.
 */
export const Counterpart = Schema.Struct({
  changeId: Schema.optional(ChangeId),
  commitSha: CommitSha,
  paths: Schema.Array(Schema.String),
});
export type Counterpart = typeof Counterpart.Type;
