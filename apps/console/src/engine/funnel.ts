// The review funnel, read off the folded world.
//
// First the changes: how many Keel's own events took as far as each stage,
// declared, precheck, verified and landed, and what became of the ones that
// got no further. Then the conflicts: probes and questions are events, so
// those two stages are counted from the conflicts and escalations in the
// world. Last the comparisons: the four cheap stages are counters only Keel
// can keep, so they come from the latest funnel observation, where a source
// sends one.

import type { FunnelStage } from "../contract/observations.ts";
import type { BounceCounts, ChangeEntry, World } from "./world.ts";

/** The stages a change goes through, in order. Each is reached by an event of Keel's and by nothing else. */
export const CHANGE_STAGES = ["declared", "precheck", "verified", "landed"] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];

export interface ChangeRow {
  stage: ChangeStage;
  /** Changes Keel's events took this far, each counted once however often it came round again. */
  reached: number;
  /** Of those, the ones that got to a later stage. */
  wentOn: number;
  /** Got this far and no further, and still on its way: with its agent, or with Keel. */
  here: number;
  /** Of `here`, the ones Keel has parked. */
  parked: number;
  /**
   * Got this far and no further, and out of the flow as it stands now, by what Keel said of it: bounced, under
   * the one cause its latest bounce named; drifted from what it declared; withdrawn; superseded.
   */
  out: BounceCounts & { drifted: number; withdrawn: number; superseded: number };
}

export interface ChangeFunnel {
  rows: ChangeRow[];
  declared: number;
  landed: number;
  /** Landed with no verified verdict: the project's verification was off. */
  landedUnverified: number;
  /** Every bounce in the log, by the cause Keel named. A change that bounced twice is two. */
  bounces: BounceCounts;
  /** Changes that bounced at least once, and how many of those have landed since. */
  bounced: number;
  bouncedThenLanded: number;
}

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
  /** What the stage has cost. Absent where there is no price (a person's answer) and where Keel has recorded none. */
  usd?: number;
  /** For the probe: how the settled ones went. */
  dismissed?: number;
  proven?: number;
}

export interface FunnelState {
  changes: ChangeFunnel;
  rows: FunnelRow[];
  /** Every conflict Keel has suspected, whatever came of it. */
  suspected: number;
  /**
   * What Keel reckoned the plans it compiled would cost to run, added up. Keel's estimate, made before
   * anything ran: never a spend, and never added to one. Absent while it has compiled no plan.
   */
  estimate?: { plans: number; usd: number };
  /** Submitted changes compared so far. Absent with the counters. */
  changesCompared?: number;
  /** Per submitted change: every premise other changes hold, and how many the subject index passed on. */
  perChange?: { everything: number; compared: number };
  /** Of everything that could have been compared, the share settled before any model was asked. */
  settledBeforeModels?: number;
  /** Every cost Keel has recorded for a stage, added up. Absent while it has recorded none: that is not zero. */
  usd?: number;
  changesLanded: number;
  peopleAsked: number;
  /** Questions open right now. */
  peopleWaiting: number;
  /** Half the questions were answered within this long, in ms. Absent until one has been. */
  medianAnswerMs?: number;
}

const COUNTED: readonly FunnelStage[] = [0, 1, 2, 3];

/** Dollars added up, to the billionth: the sums are of fractions of a cent. */
const total = (costs: readonly number[]): number =>
  Math.round(costs.reduce((sum, usd) => sum + usd, 0) * 1e9) / 1e9;

/** How far a change got: the last of the stages Keel's events took it to. */
function furthest(change: ChangeEntry): ChangeStage {
  if (change.state === "landed") return "landed";
  if (change.reached.verified) return "verified";
  return change.reached.precheck ? "precheck" : "declared";
}

const got = (change: ChangeEntry, stage: ChangeStage): boolean =>
  stage === "declared" ||
  (stage === "precheck" && (change.reached.precheck || furthest(change) !== "declared")) ||
  (stage === "verified" && change.reached.verified) ||
  (stage === "landed" && change.state === "landed");

/**
 * The funnel of changes. A stage counts the changes Keel's events took that far, and of the ones that got no
 * further says where each stands now. Nothing here is worked out: a stage is an event, a bounce's cause is the
 * one Keel named, and a change that landed unverified is not counted as verified.
 */
export function changeFunnelOf(world: World): ChangeFunnel {
  const changes = [...world.changes.values()];
  const rows = CHANGE_STAGES.map((stage, index): ChangeRow => {
    const row: ChangeRow = {
      stage,
      reached: 0,
      wentOn: 0,
      here: 0,
      parked: 0,
      out: { verdict: 0, conflict: 0, declined: 0, drifted: 0, withdrawn: 0, superseded: 0 },
    };
    for (const change of changes) {
      if (!got(change, stage)) continue;
      row.reached += 1;
      if (stage === "landed") continue;
      if (CHANGE_STAGES.indexOf(furthest(change)) > index) {
        row.wentOn += 1;
        continue;
      }
      switch (change.state) {
        case "bounced":
          if (change.bounce?.declined !== undefined) row.out.declined += 1;
          else if (change.bounce?.conflictId !== undefined) row.out.conflict += 1;
          else row.out.verdict += 1;
          break;
        case "drifted":
        case "withdrawn":
        case "superseded":
          row.out[change.state] += 1;
          break;
        case "parked":
          row.parked += 1;
          row.here += 1;
          break;
        default:
          row.here += 1;
      }
    }
    return row;
  });
  const landed = changes.filter((change) => change.state === "landed");
  const bounced = changes.filter(
    ({ bounces }) => bounces.verdict + bounces.conflict + bounces.declined > 0,
  );
  const sum = (cause: keyof BounceCounts): number =>
    changes.reduce((count, change) => count + change.bounces[cause], 0);
  return {
    rows,
    declared: changes.length,
    landed: landed.length,
    landedUnverified: landed.filter((change) => !change.reached.verified).length,
    bounces: { verdict: sum("verdict"), conflict: sum("conflict"), declined: sum("declined") },
    bounced: bounced.length,
    bouncedThenLanded: bounced.filter((change) => change.state === "landed").length,
  };
}

/**
 * `people` is whether this reader is shown the questions put to a person. Where they are not, the last stage
 * is not counted: nought would say nobody was asked.
 */
export function funnelOf(world: World, people = true): FunnelState {
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
  const probeCosts = [
    ...[...world.probes.values()].map((probe) => probe.costUsd),
    ...conflicts.map((conflict) => (conflict.probeId === undefined ? conflict.costUsd : undefined)),
  ].filter((usd) => usd !== undefined);
  rows.push({
    stage: 4,
    reported: true,
    reached: conflicts.length,
    settled: dismissed + proven,
    passedOn: escalated,
    open: conflicts.length - dismissed - proven - escalated,
    ...(probeCosts.length === 0 ? {} : { usd: total(probeCosts) }),
    dismissed,
    proven,
  });

  const escalations = [...world.escalations.values()];
  const waiting = escalations.filter((escalation) => escalation.state === "open").length;
  rows.push({
    stage: 5,
    reported: people,
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
  const costs = rows.flatMap((row) => (row.usd === undefined ? [] : [row.usd]));
  return {
    changes: changeFunnelOf(world),
    rows,
    suspected: world.conflicts.size,
    ...(world.planned.plans === 0
      ? {}
      : { estimate: { plans: world.planned.plans, usd: total([world.planned.usd]) } }),
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
    ...(costs.length === 0 ? {} : { usd: total(costs) }),
    changesLanded: world.trunk.changesLanded,
    peopleAsked: escalations.length,
    peopleWaiting: waiting,
    ...(median === undefined ? {} : { medianAnswerMs: median }),
  };
}
