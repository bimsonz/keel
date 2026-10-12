// One conflict as Keel's own read answers it (`GET /v1/conflicts/{id}`),
// folded here from the events Keel folds it from: the conflict's own, its
// probe's, its guard's, and what each side's change was told. The page is
// drawn from this one shape whichever of the two it came from, and a test
// sets the two beside each other, so the console and Keel cannot say different
// things of one conflict unseen. What Keel has no record of is absent.

import type { ConflictDetail, ConflictSide, MatrixWorld } from "../contract/keel/index.ts";
import { type ConflictEntry, MATRIX_WORLDS, type World } from "./world.ts";

/** A conflict is settled once it is dismissed or resolved; in every other state it is open. */
export const isOpenConflict = (state: ConflictEntry["state"]): boolean =>
  state !== "dismissed" && state !== "resolved";

const labelled = (label: string | undefined): { label?: string } =>
  label === undefined ? {} : { label };

/** The five worlds in Keel's order: the probe's runs in run order, and each suite's latest run, by its name. */
export function matrixOf(conflict: ConflictEntry): MatrixWorld[] {
  return MATRIX_WORLDS.map((world) => {
    const latest = new Map<string, ConflictEntry["checks"][number]>();
    for (const check of conflict.checks) {
      if (check.world !== world) continue;
      const standing = latest.get(check.check);
      if (standing === undefined || check.run > standing.run) latest.set(check.check, check);
    }
    return {
      world,
      probe: conflict.runs
        .filter((run) => run.world === world)
        .toSorted((a, b) => a.run - b.run)
        .map(({ run, outcome, resultRef, at }) => ({ run, outcome, resultRef, at })),
      checks: [...latest.values()]
        .toSorted((a, b) => a.check.localeCompare(b.check))
        .map(({ check, run, outcome, counts, reason, at }) => ({
          check,
          run,
          outcome,
          ...(counts === undefined ? {} : { counts }),
          ...(reason === undefined ? {} : { reason }),
          at,
        })),
    };
  });
}

/** The two sides, where the suspicion named both: the holder relies on the premise, the other makes the effect. */
function sidesOf(world: World, conflict: ConflictEntry): ConflictDetail["sides"] {
  const { premise, effect } = conflict;
  if (premise === undefined || effect === undefined) return undefined;
  const toldTo = (changeId: string): Pick<ConflictSide, "told"> => {
    const told = world.told.get(`${conflict.id}/${changeId}`);
    return told === undefined ? {} : { told };
  };
  return {
    holder: {
      changeId: premise.holder,
      role: "premise",
      proposition: premise.proposition,
      ...toldTo(premise.holder),
    },
    other: {
      changeId: effect.changeId,
      role: "effect",
      proposition: effect.proposition,
      ...(effect.evidence === undefined ? {} : { evidence: effect.evidence }),
      ...toldTo(effect.changeId),
    },
  };
}

/** What a conflict's list row and its own page both say of it. */
function headOf(
  conflict: ConflictEntry,
): Pick<
  ConflictDetail,
  "id" | "kind" | "state" | "parties" | "subject" | "openedAt" | "label" | "predicate"
> {
  return {
    id: conflict.id,
    kind: conflict.kind,
    state: conflict.state,
    parties: [...conflict.parties],
    ...(conflict.subjectKey === undefined ? {} : { subject: conflict.subjectKey }),
    openedAt: conflict.openedAt,
    label: conflict.label,
    ...(conflict.predicate === undefined ? {} : { predicate: conflict.predicate }),
  };
}

/** One conflict as the log has it so far, in the shape of Keel's own read of it. Null for one the log has not named. */
export function conflictDetailOf(world: World, conflictId: string): ConflictDetail | null {
  const conflict = world.conflicts.get(conflictId);
  if (conflict === undefined) return null;
  const probe = conflict.probeId === undefined ? undefined : world.probes.get(conflict.probeId);
  const guard = conflict.guardId === undefined ? undefined : world.guards.get(conflict.guardId);
  const sides = sidesOf(world, conflict);
  return {
    ...headOf(conflict),
    ...(conflict.origin === undefined ? {} : { origin: conflict.origin }),
    ...(conflict.settledAt === undefined ? {} : { settledAt: conflict.settledAt }),
    ...(conflict.proven === undefined ? {} : { proven: conflict.proven }),
    ...(conflict.dismissed === undefined ? {} : { dismissed: conflict.dismissed }),
    ...(sides === undefined ? {} : { sides }),
    matrix: matrixOf(conflict),
    ...(probe === undefined
      ? {}
      : {
          probe: {
            id: probe.id,
            label: probe.label,
            state: probe.state,
            ...(probe.attempts === undefined ? {} : { attempts: probe.attempts }),
            ...(probe.bundleHash === undefined ? {} : { bundleHash: probe.bundleHash }),
            ...(probe.discarded === undefined ? {} : { discarded: probe.discarded }),
          },
        }),
    ...(guard === undefined
      ? {}
      : {
          guard: {
            id: guard.id,
            label: guard.label,
            state: guard.state,
            admittedAt: guard.admittedAt,
            probeId: guard.probeId,
            runs: guard.runs,
          },
        }),
    ...(conflict.escalationId === undefined
      ? {}
      : {
          escalation: {
            id: conflict.escalationId,
            // The question itself is its project's members' to read; its name is not there for anyone else.
            ...labelled(world.escalations.get(conflict.escalationId)?.label),
            open: isOpenConflict(conflict.state),
            ...(conflict.escalated === undefined ? {} : { reason: conflict.escalated }),
          },
        }),
    ...(conflict.decisionId === undefined
      ? {}
      : {
          decision: {
            id: conflict.decisionId,
            ...labelled(world.decisions.get(conflict.decisionId)?.label),
          },
        }),
    ...(conflict.move === undefined ? {} : { move: conflict.move }),
  };
}
