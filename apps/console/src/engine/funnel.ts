// The review funnel, read off the folded world: how many comparisons each
// stage settled, how many it passed on, and what each cost.
//
// The four cheap stages are counters only Keel can keep, so they come from
// the latest funnel observation. Probes and questions are events, so the last
// two stages are counted from the conflicts and escalations in the world.

import type { FunnelStage } from "../contract/observations.ts";
import type { World } from "./world.ts";

export interface FunnelRow {
  stage: FunnelStage;
  /** False when the source keeps no count for this stage. Its numbers then mean nothing, and are not zero. */
  reported: boolean;
  /** Comparisons that reached this stage. */
  reached: number;
  /** Comparisons it settled, so they went no further. */
  settled: number;
  /** Comparisons it handed on. */
  passedOn: number;
  /** Reached, and neither settled nor passed on yet. */
  open: number;
  /** What the stage has cost. Absent where there is no price: a person's answer. */
  usd?: number;
  /** For the probe: how the settled ones went. */
  dismissed?: number;
  proven?: number;
}

export interface FunnelState {
  rows: FunnelRow[];
  /** Submitted changes compared so far. Absent with the counters. */
  changesCompared?: number;
  /** Per submitted change: every premise other changes hold, and how many the subject index passed on. */
  perChange?: { everything: number; compared: number };
  /** Of everything that could have been compared, the share settled before any model was asked. */
  settledBeforeModels?: number;
  /** Every reported stage's cost, added up. */
  usd: number;
  changesLanded: number;
  peopleAsked: number;
  /** Questions open right now. */
  peopleWaiting: number;
  /** Half the questions were answered within this long, in ms. Absent until one has been. */
  medianAnswerMs?: number;
}

const COUNTED: readonly FunnelStage[] = [0, 1, 2, 3];

export function funnelOf(world: World): FunnelState {
  const frame = world.funnel;
  const rows: FunnelRow[] = COUNTED.map((stage) => {
    const counted = frame?.stages.find((candidate) => candidate.stage === stage);
    if (counted === undefined)
      return { stage, reported: false, reached: 0, settled: 0, passedOn: 0, open: 0 };
    return {
      stage,
      reported: true,
      reached: counted.considered,
      settled: counted.settled,
      passedOn: counted.passedOn,
      open: counted.considered - counted.settled - counted.passedOn,
      usd: counted.usd,
    };
  });

  // A conflict is at the probe once one is drafted, or once anything has proven or dismissed it.
  const conflicts = [...world.conflicts.values()].filter(
    (conflict) => conflict.probeId !== undefined || conflict.state !== "suspected",
  );
  const dismissed = conflicts.filter((conflict) => conflict.state === "dismissed").length;
  const proven = conflicts.filter(
    (conflict) => conflict.state === "resolved" && conflict.escalationId === undefined,
  ).length;
  const escalated = conflicts.filter((conflict) => conflict.escalationId !== undefined).length;
  // A probe's runs are priced one by one. A guard that settles a conflict without a new probe is priced on the conflict.
  const probeUsd =
    [...world.probes.values()].reduce((sum, probe) => sum + probe.costUsd, 0) +
    conflicts.reduce(
      (sum, conflict) => sum + (conflict.probeId === undefined ? (conflict.costUsd ?? 0) : 0),
      0,
    );
  rows.push({
    stage: 4,
    reported: true,
    reached: conflicts.length,
    settled: dismissed + proven,
    passedOn: escalated,
    open: conflicts.length - dismissed - proven - escalated,
    usd: Math.round(probeUsd * 1e9) / 1e9,
    dismissed,
    proven,
  });

  const escalations = [...world.escalations.values()];
  const waiting = escalations.filter((escalation) => escalation.state === "open").length;
  rows.push({
    stage: 5,
    reported: true,
    reached: escalations.length,
    settled: escalations.length - waiting,
    passedOn: 0,
    open: waiting,
  });

  // By the events' own timestamps: history replayed at once still took the time it took.
  const answered = escalations
    .flatMap((escalation) =>
      escalation.ruling === undefined
        ? []
        : [Date.parse(escalation.ruling.at) - Date.parse(escalation.raisedAt)],
    )
    .toSorted((a, b) => a - b);
  const median = answered[Math.floor((answered.length - 1) / 2)];
  const index = frame?.stages.find((candidate) => candidate.stage === 0);
  const lattice = frame?.stages.find((candidate) => candidate.stage === 1);
  const compared = frame?.changesCompared ?? 0;
  return {
    rows,
    ...(frame === undefined ? {} : { changesCompared: compared }),
    ...(index === undefined || compared === 0
      ? {}
      : {
          perChange: {
            everything: index.considered / compared,
            compared: index.passedOn / compared,
          },
        }),
    ...(index === undefined || lattice === undefined || index.considered === 0
      ? {}
      : { settledBeforeModels: (index.settled + lattice.settled) / index.considered }),
    usd: Math.round(rows.reduce((sum, row) => sum + (row.usd ?? 0), 0) * 1e9) / 1e9,
    changesLanded: world.trunk.changesLanded,
    peopleAsked: escalations.length,
    peopleWaiting: waiting,
    ...(median === undefined ? {} : { medianAnswerMs: median }),
  };
}
