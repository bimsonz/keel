// Who is on which side of a conflict. Keel says: its suspicion names the
// premise at stake with the change that holds it, and the effect against it
// with the change that makes it. The console works neither out. A conflict
// Keel suspected without naming them has no sides here either.

import type { SuspectPremise } from "../contract/keel/index.ts";
import type { ConflictEntry, World } from "./world.ts";

const SETTLED: ReadonlySet<string> = new Set(["resolved", "dismissed"]);

/** The open conflicts in which `changeId` is the side that alters, each with the premise Keel set its effect against. */
export function contradictionsOf(
  world: World,
  changeId: string,
): { conflict: ConflictEntry; premise: SuspectPremise }[] {
  const change = world.changes.get(changeId);
  return (change?.conflictIds ?? []).flatMap((id) => {
    const conflict = world.conflicts.get(id);
    if (conflict === undefined || SETTLED.has(conflict.state)) return [];
    const { premise, effect } = conflict;
    return premise === undefined || effect === undefined || effect.changeId !== changeId
      ? []
      : [{ conflict, premise }];
  });
}
