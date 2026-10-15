// The world the list of changes draws while a project's log is still being read: every change as Keel's snapshot
// of the log's head has it, and nothing else. Keel answers the snapshot in one read where the log is read page
// after page, so a page of changes draws at once. The log is folded into its own world as it is read, beside
// this one; once the log is read this one is put away, and nothing is ever folded into it.

import type { ChangeSummary, FeedSnapshot } from "../contract/keel/index.ts";
import type { Route } from "../route.ts";
import { World } from "./world.ts";

/**
 * The pages a snapshot's world draws: the list of changes in full, each by its number, goal, state and holder;
 * and Mission Control's project, with trunk's head, its live changes and its landings, and what of its header
 * the snapshot holds, with the rest waiting on the log (growth.ts). Every other page reads what only the log holds
 * (a change's footprint and verdicts, conflicts, decisions), so it waits for the log rather than show less than
 * there is.
 */
const DRAWN_FROM_SNAPSHOT: ReadonlySet<Route["at"]> = new Set(["changes", "mission-control"]);
/** The places drawn as the log is read: one change is drawn once its own entries are, not once the log's last is. */
const AS_READ: ReadonlySet<Route["at"]> = new Set(["change"]);

/**
 * Whether a page read from the log can be drawn yet: once the log is read, from a snapshot's world if it draws in
 * full, or at once if it is drawn as the log is read.
 */
export const drawable = (
  player: { readonly loaded: boolean; readonly provisional: boolean },
  at: Route["at"],
): boolean =>
  player.loaded || (player.provisional && DRAWN_FROM_SNAPSHOT.has(at)) || AS_READ.has(at);

/**
 * A world of the snapshot's changes: each by its number, its holder, goal, state and revision, and when it was
 * declared; and trunk's head and height, where Keel gives them.
 */
export function provisionalWorld(snapshot: FeedSnapshot): World {
  const world = new World();
  if (snapshot.trunk !== undefined) {
    world.trunk.head = snapshot.trunk.head;
    world.trunk.advances = snapshot.trunk.height;
  }
  // A change's place on the story's clock, from the first change declared: the log's own epoch is not read yet.
  const first = Math.min(...snapshot.changes.map((change) => Date.parse(change.declaredAt)));
  // In the order the log declares them, as a world folded from it holds them: Keel answers newest first.
  for (const change of snapshot.changes.toSorted((a, b) => a.number - b.number)) {
    world.changes.set(change.changeId, {
      id: change.changeId,
      label: `#${change.number}`,
      agentId: change.agentId,
      goal: change.goal,
      state: change.state,
      revision: change.revision,
      footprint: [],
      premises: [],
      declaredEffects: [],
      effects: [],
      derived: false,
      drift: [],
      declaredAt: change.declaredAt,
      declaredT: Date.parse(change.declaredAt) - first,
      verdictIds: [],
      unverified: false,
      conflictIds: [],
      bounces: { verdict: 0, conflict: 0, declined: 0, ruling: 0 },
      reached: { precheck: false, verified: false },
      noted: [],
      alternatives: [],
      precedents: [],
      doubts: [],
      ...(change.parkReason === undefined ? {} : { parkedOn: change.parkReason }),
    });
  }
  return world;
}

/**
 * How a change's page is drawn: from the log once it is read, and while it is read, from the log only once the
 * fold has reached the change's latest entry as Keel's read model knows it (`updatedAt`). Before then the
 * page is drawn early, from that read model, rather than as the log stood part way, which can say a landed
 * change is queued. It waits while Keel is asked, and draws from the log as read where Keel has no answer
 * (a fixture, or a read that failed).
 */
export function changeDrawn(
  player: {
    readonly loaded: boolean;
    readonly live: boolean;
    readThrough(at: string): boolean;
  },
  inWorld: boolean,
  summary: ChangeSummary | null | undefined,
):
  | { readonly by: "log" }
  | { readonly by: "early"; readonly summary: ChangeSummary }
  | { readonly by: "waiting" } {
  if (player.loaded || !player.live)
    return inWorld || player.loaded ? { by: "log" } : { by: "waiting" };
  if (summary === undefined) return { by: "waiting" };
  if (summary === null) return inWorld ? { by: "log" } : { by: "waiting" };
  return inWorld && player.readThrough(summary.updatedAt)
    ? { by: "log" }
    : { by: "early", summary };
}
