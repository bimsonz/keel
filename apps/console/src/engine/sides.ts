// Who is on which side of a conflict. Keel says: its suspicion names the
// premise at stake with the change that holds it, and the effect against it
// with the change that makes it. The console works neither out. A conflict
// Keel suspected without naming them has no sides here either.

import type { SuspectPremise } from "../contract/keel/index.ts";
import type { ChangeEntry, ConflictEntry, World } from "./world.ts";

export interface Sides {
  /** The change that relies on the contested proposition: world A of the matrix. */
  holder: ChangeEntry;
  /** The change whose effect goes against it: world B. */
  other: ChangeEntry;
}

const SETTLED: ReadonlySet<string> = new Set(["resolved", "dismissed"]);

/** The two changes Keel named, where it named both and the log holds both. */
export function sidesOf(world: World, conflict: ConflictEntry): Sides | null {
  if (conflict.premise === undefined || conflict.effect === undefined) return null;
  const holder = world.changes.get(conflict.premise.holder);
  const other = world.changes.get(conflict.effect.changeId);
  return holder === undefined || other === undefined ? null : { holder, other };
}

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
