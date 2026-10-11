// Who is on which side of a conflict. An effect does not say what it
// contradicts: Keel's fallout does, by opening a conflict that names both
// changes. The side that holds a premise on the contested proposition is the
// holder; the other is the change whose effect steps outside it.

import type { ChangeEntry, ConflictEntry, World } from "./world.ts";

export interface Sides {
  /** The change that relies on the contested proposition. */
  holder: ChangeEntry;
  /** The change that alters it. */
  other: ChangeEntry;
}

const SETTLED: ReadonlySet<string> = new Set(["resolved", "dismissed"]);

export function sidesOf(world: World, conflict: ConflictEntry): Sides | null {
  const subjectKey =
    conflict.subjectId === undefined ? undefined : world.subjects.get(conflict.subjectId)?.key;
  const parties = conflict.parties.flatMap((id) => world.changes.get(id) ?? []);
  const holder = parties.find((change) =>
    change.premises.some(
      (premise) => premise.subject === subjectKey && premise.predicate === conflict.predicate,
    ),
  );
  const other = parties.find((change) => change !== holder);
  return holder === undefined || other === undefined ? null : { holder, other };
}

/** The open conflicts in which `changeId` is the side that alters, each with the premise it steps outside. */
export function contradictionsOf(
  world: World,
  changeId: string,
): { conflict: ConflictEntry; sides: Sides; subjectKey: string }[] {
  const change = world.changes.get(changeId);
  return (change?.conflictIds ?? []).flatMap((id) => {
    const conflict = world.conflicts.get(id);
    if (conflict === undefined || SETTLED.has(conflict.state)) return [];
    const sides = sidesOf(world, conflict);
    const subjectKey = world.subjects.get(conflict.subjectId ?? "")?.key;
    return sides === null || sides.other.id !== changeId || subjectKey === undefined
      ? []
      : [{ conflict, sides, subjectKey }];
  });
}
