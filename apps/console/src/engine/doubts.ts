// A change's premises Keel put in doubt, as a page says them. Keel tells a premise's holder when another change
// edits code the premise rests on, or makes an effect that may contradict it, and opens no conflict for either.

import type { Doubt } from "../domain/state.ts";
import { type ChangeEntry, type World, claimOf } from "./world.ts";

/**
 * The change's doubts Keel has not reaffirmed, on premises it still holds, in the order Keel raised them. With
 * `subjectId`, only those on that subject.
 */
export function doubtsOf(world: World, change: ChangeEntry, subjectId?: string): Doubt[] {
  const held = new Set(change.premises.map(claimOf));
  return change.doubts.flatMap((doubt): Doubt[] => {
    if (subjectId !== undefined && doubt.subjectId !== subjectId) return [];
    if (!held.has(claimOf(doubt.premise))) return [];
    const { changeId, effect, anchor } = doubt.cause;
    const by = { id: changeId, label: world.changes.get(changeId)?.label ?? changeId };
    if (effect !== undefined) return [{ premise: doubt.premise, by, cause: { effect } }];
    if (anchor === undefined) return [];
    const edit = {
      path: anchor.path,
      ...(anchor.symbol === undefined ? {} : { symbol: anchor.symbol }),
    };
    return [{ premise: doubt.premise, by, cause: { edit } }];
  });
}
