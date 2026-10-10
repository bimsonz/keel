// Fix 3 for the hand-written items (S17's 40 and forge-lite's 8): the
// premise's anchors, and how the anchor view is cut.
//
// An item not listed here is about its subject only: every symbol it lists is
// one of the subject's anchors, and its anchor view is its whole diff.
//
//   sub-diff     dataset/anchored/<id>.diff is the item's diff with the lines of
//                foreign symbols removed. The build checks that it only
//                removes lines (it must be a subsequence of the original).
//   fixture      the anchor is untouched and outside the diff; the view is the
//                anchor's code at that commit, from fixtures/forge-lite, as
//                context lines. The build checks every line against the file.
//   symbol-only  the anchor is untouched, outside the diff, and no source
//                exists (S17's diffs were written by hand): the view has no
//                hunks, only the anchor's symbol entry.
import type { Sym } from "./s17/items.ts";

export type ViewKind = "sub-diff" | "fixture" | "symbol-only";

export interface HandAnchor {
  anchors: string[]; // the symbol entries kept in the state
  view: ViewKind;
  addSymbols?: Sym[]; // anchor entries the item's own symbol list lacks
  fixture?: string; // path under fixtures/forge-lite, for view "fixture"
  why: string;
}

export const HAND_ANCHORS: Record<string, HandAnchor> = {
  C05: { anchors: ["resolve_user"], view: "sub-diff", why: "drop_privileges is the caller, shown as an unchanged context section; not the lookup itself." },
  D04: { anchors: ["MAX_PAGE_SIZE", "pageParams", "listCommits"], view: "sub-diff", why: "MAX_EXPORT_ROWS and exportCommits belong to the export endpoint, a different subject." },
  D05: { anchors: ["aws_ecs_service.scheduler"], view: "sub-diff", why: "The new autoscaling target is for the api service." },
  D06: {
    anchors: ["canPerform"], view: "symbol-only",
    why: "The session cache holds UI preferences; canPerform is untouched and its code is not in the diff.",
  },
  D07: { anchors: ["is_token_revoked"], view: "sub-diff", why: "The TTLCache, avatar_url and the authenticate change are about avatars." },
  D08: {
    anchors: ["Writer.Start"], view: "symbol-only", addSymbols: [["Writer.Start", "method", "internal/audit/writer.go", "unchanged"]],
    why: "The worker pool is the thumbnailer's; the audit writer is untouched and not in the diff.",
  },
  D09: { anchors: ["UserEmail.__table_args__"], view: "sub-diff", why: "The migration and UserSecondaryEmail are about secondary emails." },
  D10: { anchors: ["Issue.ID"], view: "sub-diff", why: "Only Issue.NodeID changes; it is a different field." },
  F07: {
    anchors: ["requirePermission"], view: "fixture", fixture: "src/authz/require-permission.ts",
    why: "A's patch adds the revoke route, event and store method; requirePermission is untouched.",
  },
  F08: {
    anchors: ["requirePermission"], view: "fixture", fixture: "src/authz/require-permission.ts",
    why: "The cache holds the owner's user record for the repo view; requirePermission is untouched.",
  },
};
