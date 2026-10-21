import type { RequeueReason } from "../coordination/index.ts";
import type { ChangeId } from "../kernel/index.ts";
import type { BatchAttribution } from "./events.ts";

/** What one member of a batch that went Red does next. */
export type RedExit =
  | { readonly _tag: "Bounce" }
  | { readonly _tag: "Requeue"; readonly reason: RequeueReason }
  | { readonly _tag: "Bisection" };

const requeue = (reason: RequeueReason): RedExit => ({ _tag: "Requeue", reason });

/**
 * What a member of a Red batch does, read from the failure's attribution: the
 * change it blames bounces, and every other member goes back to its lane with
 * the failure's cause as its reason (the Lane counts `infra-failure`s, so a
 * reason never names another cause). A failure nobody could be blamed for
 * waits for bisection, whose CandidateBisected requeues it. A batch failed
 * because its namespace is halted bounces every member: none is at fault,
 * and none can be verified until the namespace is resumed. A batch of one that
 * dropped tests (`shrink`) requeues its member, which then waits for a
 * maintainer's ruling on the drop. No member stays
 * Integrating. The Candidate machine makes a batch of one's failure its
 * member's, so no member list is needed.
 */
export const redExit = (attribution: BatchAttribution, member: ChangeId): RedExit => {
  switch (attribution) {
    case "infra":
      return requeue("infra-failure");
    case "textual":
      return requeue("textual");
    case "interaction":
      return requeue("interaction");
    case "unattributed":
      return { _tag: "Bisection" };
    case "halted":
      return { _tag: "Bounce" };
    case "shrink":
      return requeue("shrink");
    default:
      return attribution === member ? { _tag: "Bounce" } : requeue("co-member-failed");
  }
};

/**
 * Whether a change requeued for `reason` runs alone in its next batch: its
 * members clashed, so the clash resolves one change at a time, as one landing
 * and one sole-member failure.
 */
export const runsAlone = (reason: RequeueReason): boolean =>
  reason === "textual" || reason === "interaction";
