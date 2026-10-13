// What each view shows, read off the folded world. These are pure: the same
// world and the same instant always give the same picture.

import { shownAgent } from "./audience.ts";
import { type Cards, heldUnder } from "./holder.ts";
import type { ConflictDetail, ConflictSide, Lattice, ProbeSource } from "../contract/keel/index.ts";
import type { Predicate } from "../contract/mfp.ts";
import type { FlowNode, StepSpec } from "../contract/provisional.ts";
import type {
  AlternativeRow,
  ChangePageState,
  IntentRow,
  DiffAnnotation,
  EvidenceItem,
  MatrixRow,
  Party,
  RulingBounce,
  PlanStep,
  StepOutcome,
  ConflictPageState,
  TimelineItem,
  World as WorldId,
} from "../domain/state.ts";
import type { ChangeDiff, VerdictReasons } from "../source/types.ts";
import { readable } from "./evidence.ts";
import { verdictSaid } from "./judged.ts";
import { chainThrough, valueIdOf } from "./lattice.ts";
import { conflictDetailOf } from "./conflict.ts";
import { contradictionsOf } from "./sides.ts";
import {
  type ChangeEntry,
  type ConflictEntry,
  type EscalationEntry,
  outcomesIn,
  type World,
} from "./world.ts";

/** What the console has fetched from Keel's read models, on demand, beside the log. */
export interface Resources {
  probes: ReadonlyMap<string, ProbeSource>;
  diffs: ReadonlyMap<string, ChangeDiff>;
  /** A verdict's evidence, by verdict id: the event that issued it carries only references. */
  verdicts: ReadonlyMap<string, VerdictReasons>;
  /** Keel's lattices, by predicate. */
  lattices: ReadonlyMap<string, Lattice>;
  /** What Keel was asked for and would not give, by the id of the thing it was asked about. */
  refused: ReadonlySet<string>;
  /** Keel's card of each agent asked for. Absent where none has been. */
  cards?: Cards;
}

export interface TrunkStats {
  redCount: number;
  advances: number;
  changesLanded: number;
  landedPerMinute: number;
  p50TimeToLandMs?: number;
  humansAsked: number;
  /** Advances made with verification switched off. Zero on any project that verifies. */
  unverifiedAdvances: number;
  head?: string;
}

/** Simulated seconds as m:ss. */
export function timecode(t: number): string {
  const seconds = Math.max(0, Math.floor(t / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function trunkStatsOf(world: World, now: number): TrunkStats {
  const { trunk } = world;
  const took = trunk.landings.map((landing) => landing.tookMs).toSorted((a, b) => a - b);
  const p50 = took[Math.floor((took.length - 1) / 2)];
  return {
    redCount: trunk.redCount,
    advances: trunk.advances,
    changesLanded: trunk.changesLanded,
    landedPerMinute: trunk.landings.filter((landing) => landing.t > now - 60_000).length,
    humansAsked: trunk.humansAsked,
    unverifiedAdvances: trunk.unverifiedAdvances,
    ...(p50 === undefined ? {} : { p50TimeToLandMs: p50 }),
    ...(trunk.head === "" ? {} : { head: trunk.head.slice(0, 7) }),
  };
}

export function openEscalations(world: World): EscalationEntry[] {
  return [...world.escalations.values()].filter((escalation) => escalation.state === "open");
}

/**
 * An open question's options, apart: the ones a person can choose, and the one that stands until someone
 * does. Keel names that one as the question's default. It is what is already happening, so it is said,
 * not offered.
 */
export function choicesOf(escalation: EscalationEntry): {
  choices: EscalationEntry["options"];
  standing: string;
} {
  const held = escalation.options.find((option) => option.id === escalation.default);
  return {
    choices: escalation.options.filter((option) => option !== held),
    standing: held === undefined ? escalation.default : `${held.label}. ${held.consequence}`,
  };
}

/** A change's name where the log holds it, and the end of its id where it does not. */
const nameOf = (world: World, changeId: string): string =>
  world.changes.get(changeId)?.label ?? changeId.slice(-4);

/** One side of a conflict, as Keel named it, with what the log says of its change. */
function party(
  world: World,
  cards: Cards,
  side: ConflictSide,
  letter: "A" | "B",
  conflict: ConflictEntry | undefined,
): Party {
  const change = world.changes.get(side.changeId);
  const { proposition, told } = side;
  // The resolution says who its ruling went against; the bounce by the same decision, what its agent was told.
  const ruledAgainst = conflict?.against?.includes(side.changeId) === true;
  const decision = world.decisions.get(conflict?.decisionId ?? "");
  return {
    world: letter,
    changeId: side.changeId,
    label: nameOf(world, side.changeId),
    goal: change?.goal ?? "",
    agent:
      change === undefined
        ? shownAgent(undefined)
        : shownAgent(world.agents.get(change.agentId), cards.get(change.agentId)),
    proposition: {
      role: side.role,
      relation: proposition.relation,
      value: String(proposition.value),
      gloss: proposition.gloss ?? "",
      ...(side.evidence === undefined ? {} : { evidence: side.evidence }),
    },
    // An annotation tells no one, so a telling with no way forward in it gives nothing here.
    ...(told === undefined || told.nextActions.length === 0
      ? {}
      : { told: { how: told.how, next: told.nextActions.map((action) => action.title) } }),
    ...(ruledAgainst
      ? {
          ruledAgainst: {
            ...(decision === undefined ? {} : { decision: decision.label }),
            next: world.ruled.get(`${conflict?.decisionId}/${side.changeId}`) ?? [],
          },
        }
      : {}),
  };
}

/** The ruling a change bounced on: its decision as the log has it, and the conflict whose resolution names that decision. */
function rulingOf(world: World, decisionId: string, reasons: string[]): RulingBounce {
  const decision = world.decisions.get(decisionId);
  const settled = [...world.conflicts.values()].find(
    (conflict) => conflict.decisionId === decisionId,
  );
  return {
    ...(decision === undefined
      ? {}
      : { decision: { label: decision.label, chosen: decision.chosen } }),
    ...(settled === undefined ? {} : { conflict: { id: settled.id, label: settled.label } }),
    reasons,
  };
}

/** Whose suite a check of the matrix is, in a few words. Keel names it `suite:trunk` or `suite:<changeId>`. */
function suiteLabel(world: World, check: string, sides: ConflictDetail["sides"]): string {
  const of = check.replace(/^suite:/, "");
  if (of === "trunk") return "Trunk's suite";
  if (of === sides?.holder.changeId) return `A's suite · ${nameOf(world, of)}`;
  if (of === sides?.other.changeId) return `B's suite · ${nameOf(world, of)}`;
  return `${nameOf(world, of)}'s suite`;
}

/** Keel runs a probe three times in a world, and a mark stands for each run while they are still coming in. */
const PROBE_RUNS = 3;

function matrixOf(world: World, detail: ConflictDetail): ConflictPageState["matrix"] {
  const { sides, probe } = detail;
  // The worlds are Keel's own names for the two sides of a conflict: A holds the premise, B alters what it
  // relies on. Which change each is, by its number, is said beside every world.
  const [a, b] = [
    sides === undefined ? "the premise's side" : nameOf(world, sides.holder.changeId),
    sides === undefined ? "the effect's side" : nameOf(world, sides.other.changeId),
  ];
  const gloss: Record<WorldId, string> = {
    trunk: "Neither change",
    "A-noop": `${a}, with what it relies on removed`,
    A: `${a} alone`,
    B: `${b} alone`,
    AB: `${a} and ${b}, composed`,
  };
  const reasons = world.conflicts.get(detail.id)?.runs ?? [];
  return {
    ...(probe?.label === undefined ? {} : { probe: probe.label }),
    calibrating: probe?.state === "calibrating",
    rows: detail.matrix.map((row): MatrixRow => {
      // A run Keel recorded twice, for a probe it drafted again, stands as its latest.
      const ran = new Map(row.probe.map((run) => [run.run, run.outcome]));
      const most = Math.max(probe === undefined ? 0 : PROBE_RUNS, ...ran.keys());
      const reason = reasons.findLast((run) => run.world === row.world && run.reason !== undefined);
      return {
        id: row.world,
        label: row.world === "AB" ? "A+B" : row.world,
        gloss: gloss[row.world],
        suites: row.checks.map((check) => ({
          check: check.check,
          label: suiteLabel(world, check.check, sides),
          outcome: check.outcome,
          ...(check.counts === undefined
            ? {}
            : {
                passed: check.counts.passed,
                total: check.counts.passed + check.counts.failed + check.counts.skipped,
              }),
          ...(check.reason === undefined ? {} : { reason: check.reason }),
        })),
        // What is not in yet is not said to be running: Keel records a run when it has ended, and nothing before.
        runs: Array.from({ length: most }, (_, index) => ran.get(index + 1) ?? "pending"),
        ...(reason?.reason === undefined ? {} : { reason: reason.reason }),
        ...(row.world === "A-noop" ? { control: true } : {}),
      };
    }),
  };
}

/** Where a conflict's two sides sit on Keel's lattice for its predicate. */
function latticeOf(
  resources: Resources,
  predicate: Predicate | undefined,
  parties: ConflictPageState["parties"],
): ConflictPageState["lattice"] {
  const named = predicate ?? "invariant";
  const lattice = resources.lattices.get(named);
  if (parties === undefined || lattice === undefined || lattice.covers.length === 0)
    return { predicate: named, values: [], standing: "unknown" };
  const [premise, effect] = [parties.A.proposition.value, parties.B.proposition.value];
  const chain = chainThrough(lattice, [premise, effect]);
  if (chain !== null) return { predicate: named, values: chain, standing: "ranked" };
  // Both are values of this lattice, and it puts neither above the other.
  const known =
    valueIdOf(lattice, premise) !== undefined && valueIdOf(lattice, effect) !== undefined;
  return { predicate: named, values: [], standing: known ? "unranked" : "unknown" };
}

const said = (proposition: Party["proposition"], predicate: string): string =>
  `${predicate} ${proposition.relation.replace("-", " ")} ${proposition.value}`;

const HOW_KNOWN: Record<string, string> = {
  extractor: "Derived by Keel · extractor",
  clef: "Derived by Keel · Clef",
  "code-model": "Derived by Keel · code model",
};

/**
 * What bears on a conflict before anyone is asked: Keel's records of it, each restated as the record has it
 * and none reasoned from. What each side holds, how the effect is known, and what ran where both changes are
 * composed. Once a person is asked, the question's own evidence stands in its place.
 */
function recordsOf(
  world: World,
  detail: ConflictDetail,
  parties: ConflictPageState["parties"],
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const predicate = detail.predicate ?? "";
  if (parties !== undefined) {
    items.push({
      class: "testimony",
      summary: `${parties.A.label} relies on: ${said(parties.A.proposition, predicate)}`,
      by: "Declared by its agent",
      ref: `chg:${parties.A.changeId}`,
      at: detail.openedAt,
    });
    const { evidence } = parties.B.proposition;
    if (evidence !== undefined)
      items.push({
        class: evidence.evidenceClass,
        summary: `${parties.B.label} makes: ${said(parties.B.proposition, predicate)}`,
        by: evidence.declared
          ? "Declared by its agent"
          : (HOW_KNOWN[evidence.method ?? ""] ?? "Derived by Keel"),
        ref: `chg:${parties.B.changeId}`,
        at: detail.openedAt,
      });
  }
  const composed = detail.matrix.find((row) => row.world === "AB");
  const last = composed?.probe.at(-1);
  if (composed !== undefined && last !== undefined)
    items.push({
      class: "proof",
      summary: `Probe ${detail.probe?.label ?? ""} in A+B: ${composed.probe.map((run) => run.outcome).join(", ")}`,
      by: "World matrix",
      ref: last.resultRef,
      at: last.at,
    });
  for (const check of composed?.checks ?? [])
    items.push({
      class: "proof",
      summary: `${suiteLabel(world, check.check, detail.sides)} in A+B: ${check.outcome}${
        check.counts === undefined
          ? ""
          : `, ${check.counts.passed} of ${check.counts.passed + check.counts.failed + check.counts.skipped} tests`
      }`,
      by: "World matrix",
      ref: `cfl:${detail.id}/AB/${check.check}`,
      at: check.at,
    });
  return items;
}

const PROVEN_BY: Record<string, string> = {
  probe: "its probe",
  guard: "a guard",
  "merge-refused": "a refused merge",
  interaction: "an interaction in a batch",
};

/**
 * A conflict's page, drawn from Keel's own shape for one: the console's fold of the log, or Keel's read of
 * it. The log read so far adds what that shape has no place for: each change's name and goal, the question
 * a person was asked, and what came of each side afterwards. Every conflict Keel names has a page.
 */
export function conflictPageFrom(
  detail: ConflictDetail,
  world: World,
  resources: Resources,
): ConflictPageState {
  const conflict = world.conflicts.get(detail.id);
  const subject =
    detail.subject === undefined
      ? undefined
      : [...world.subjects.values()].find((minted) => minted.key === detail.subject);
  const cards: Cards = resources.cards ?? new Map();
  // The question is in Keel's shape where Keel reads it to this reader: to the project's members, and nobody else.
  const asked = detail.escalation;
  const { decision } = detail;
  const parties =
    detail.sides === undefined
      ? undefined
      : {
          A: party(world, cards, detail.sides.holder, "A", conflict),
          B: party(world, cards, detail.sides.other, "B", conflict),
        };
  const timeline: TimelineItem[] = (conflict?.timeline ?? []).map((entry, index, all) => ({
    at: entry.at,
    type: entry.type,
    title: entry.title,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(index === all.length - 1 ? { now: true } : {}),
  }));
  const settledT = conflict?.settledT;
  const { probe, guard } = detail;
  const source = probe === undefined ? undefined : resources.probes.get(probe.id);
  return {
    conflict: {
      id: detail.id,
      label: detail.label,
      kind: detail.kind,
      state: detail.state,
      silentRetraction: conflict?.silentRetraction ?? false,
      openedAt: detail.openedAt,
      title:
        detail.subject === undefined
          ? `Conflict ${detail.label}`
          : detail.predicate === undefined
            ? detail.subject
            : `${detail.subject} · ${detail.predicate}`,
      ...(detail.predicate === undefined ? {} : { predicate: detail.predicate }),
      ...(detail.origin === undefined ? {} : { origin: detail.origin }),
      ...(detail.proven === undefined
        ? {}
        : { proven: PROVEN_BY[detail.proven._tag] ?? detail.proven._tag }),
      ...(detail.dismissed === undefined ? {} : { dismissed: detail.dismissed }),
      ...(detail.move === undefined ? {} : { move: detail.move }),
      ...(conflict?.costUsd === undefined ? {} : { costUsd: conflict.costUsd }),
    },
    ...(asked?.question === undefined || asked.state === undefined
      ? {}
      : {
          escalation: {
            id: asked.id,
            label: asked.label ?? asked.id.slice(-4),
            question: asked.question,
            state: asked.state,
          },
        }),
    ...(asked?.reason === undefined ? {} : { escalated: asked.reason }),
    ...(guard === undefined
      ? {}
      : {
          guard: { label: guard.label ?? guard.id.slice(-4), state: guard.state, runs: guard.runs },
        }),
    ...(decision?.chosen === undefined
      ? {}
      : {
          decision: {
            label: decision.label ?? decision.id.slice(-4),
            chosen: decision.chosen.label,
          },
        }),
    ...(detail.subject === undefined
      ? {}
      : { subject: { key: detail.subject, gloss: subject?.gloss ?? "" } }),
    lattice: latticeOf(resources, detail.predicate, parties),
    ...(parties === undefined ? {} : { parties }),
    // A party is a change, or a tenet trunk already holds: a change can conflict with what is settled.
    named: detail.parties.map((id) =>
      id.startsWith("chg_")
        ? { changeId: id, label: nameOf(world, id) }
        : { label: "a tenet on trunk" },
    ),
    matrix: matrixOf(world, detail),
    after: (detail.sides === undefined ? [] : [detail.sides.holder, detail.sides.other]).flatMap(
      ({ changeId }) => {
        const side = world.changes.get(changeId);
        const judged = world.verdicts.get(side?.verdictIds.at(-1) ?? "");
        if (side === undefined || settledT === undefined || judged === undefined) return [];
        if (judged.issuedT < settledT) return [];
        return [
          {
            changeId: side.id,
            label: side.label,
            revision: side.verdictRevision ?? side.revision,
            outcome: judged.outcome,
            summary: judged.summary,
          },
        ];
      },
    ),
    ...(probe === undefined
      ? {}
      : {
          probe: {
            id: probe.id,
            label: probe.label ?? probe.id.slice(-4),
            state: probe.state,
            ...(probe.attempts === undefined ? {} : { attempts: probe.attempts }),
            ...(probe.bundleHash === undefined ? {} : { bundleHash: probe.bundleHash }),
            ...(probe.discarded === undefined ? {} : { discarded: probe.discarded }),
            source:
              source === undefined
                ? resources.refused.has(probe.id)
                  ? "refused"
                  : "unread"
                : source.files,
          },
        }),
    evidence:
      asked?.evidence === undefined
        ? recordsOf(world, detail, parties)
        : asked.evidence.map((line) => ({
            class: line.class,
            summary: line.summary,
            by: "",
            ref: line.ref ?? "",
          })),
    timeline,
  };
}

/** The page of a conflict the log has named, from the console's own fold of it. */
export function conflictPageOf(
  world: World,
  conflictId: string,
  resources: Resources,
): ConflictPageState | null {
  const detail = conflictDetailOf(world, conflictId);
  return detail === null ? null : conflictPageFrom(detail, world, resources);
}

function leaves(node: FlowNode, worlds?: WorldId[]): { step: StepSpec; worlds?: WorldId[] }[] {
  if (node.op === "step") return [{ step: node.step, ...(worlds === undefined ? {} : { worlds }) }];
  if (node.op === "worlds") return leaves(node.of, node.over);
  if (node.op === "when" || node.op === "budget") return leaves(node.of, worlds);
  return node.of.flatMap((child) => leaves(child, worlds));
}

const STEP_OUTCOME: Record<string, StepOutcome> = {
  running: "running",
  passed: "pass",
  failed: "fail",
  annotated: "annotate",
  abstained: "abstain",
  skipped: "n/a",
  waiting: "waiting",
};

function planSteps(world: World, change: ChangeEntry): PlanStep[] {
  if (change.plan?.spec === undefined) return [];
  const conflict = world.conflicts.get(change.conflictIds.at(-1) ?? "");
  const probe = conflict?.probeId === undefined ? undefined : world.probes.get(conflict.probeId);
  const escalation =
    change.escalationId === undefined ? undefined : world.escalations.get(change.escalationId);
  return leaves(change.plan.spec).map(({ step, worlds }) => {
    const seen = world.steps.get(`${change.id}/${step.id}`);
    let outcome: StepOutcome =
      seen === undefined ? "pending" : (STEP_OUTCOME[seen.status] ?? "pending");
    // The probe and the ruling are told by events, not by step observations.
    if (step.kind === "probe" && step.id === "probe" && probe !== undefined) {
      const composed = outcomesIn(conflict, "AB");
      outcome =
        composed.length < 3 ? "running" : composed.every((run) => run === "fail") ? "fail" : "pass";
    } else if (step.kind === "probe" && step.id === "guard") {
      // Keel's own fact comes first: a guard that failed in this revision's plan has failed, whatever else is
      // known. Keel says nothing of a guard that held, so otherwise the step's own observation stands.
      if (change.guardFailures.some((failure) => failure.revision === change.revision))
        outcome = "fail";
    } else if (step.kind === "human") {
      outcome =
        escalation === undefined ? "pending" : escalation.state === "open" ? "waiting" : "pass";
    }
    return {
      id: step.id,
      title: step.title,
      kind: step.kind,
      tier: step.tier,
      because: step.because.text,
      outcome,
      evidenceClass: step.evidenceCeiling,
      ...(seen?.cost?.ms === undefined ? {} : { ms: seen.cost.ms }),
      ...(seen?.cost?.usd === undefined ? {} : { usd: seen.cost.usd }),
      ...(worlds === undefined ? {} : { worlds }),
    };
  });
}

function changedLines(
  before: string | null,
  after: string | null,
): { additions: number; deletions: number } {
  const old = new Set((before ?? "").split("\n"));
  const now = new Set((after ?? "").split("\n"));
  return {
    additions: [...now].filter((line) => !old.has(line) && line.trim() !== "").length,
    deletions: [...old].filter((line) => !now.has(line) && line.trim() !== "").length,
  };
}

function annotationsOf(world: World, change: ChangeEntry, diff: ChangeDiff): DiffAnnotation[] {
  const notes: DiffAnnotation[] = [];
  for (const anchor of diff.anchors) {
    const subject = world.subjectByKey(anchor.subjectKey);
    const effect = change.effects.find(
      (e) =>
        e.method === "extractor" &&
        e.anchors.some((a) => a.path === anchor.path && a.symbol === anchor.symbol),
    );
    if (effect !== undefined) {
      notes.push({
        path: anchor.path,
        side: anchor.side,
        line: anchor.line,
        kind: "effect",
        subjectKey: anchor.subjectKey,
        title: `Derived effect: ${effect.proposition.predicate} ${effect.proposition.relation} ${String(effect.proposition.value)}`,
        body: `${effect.proposition.gloss ?? ""}. ${effect.declared ? `Declared by ${change.label}.` : `Not declared by ${change.label}.`}`,
        evidenceClass: effect.evidenceClass,
      });
      continue;
    }
    // Otherwise the line matters because someone else relies on it.
    for (const [holderId, premise] of subject?.premises ?? []) {
      const holder = world.changes.get(holderId);
      if (holder === undefined || holder.id === change.id || premise.predicate === "invariant")
        continue;
      const gloss = holder.premises.find(
        (p) => p.subject === anchor.subjectKey && p.predicate === premise.predicate,
      )?.gloss;
      notes.push({
        path: anchor.path,
        side: anchor.side,
        line: anchor.line,
        kind: "premise",
        subjectKey: anchor.subjectKey,
        title: `${holder.label} relies on this line`,
        body: `Premise, declared by ${holder.label}: ${premise.predicate} ${premise.relation.replace("-", " ")} ${String(premise.value)}.${gloss === undefined ? "" : ` “${gloss}.”`}`,
        evidenceClass: "testimony",
      });
    }
  }
  return notes;
}

/** One change among several with the same intent, as it stands now. */
function intentRowOf(world: World, cards: Cards, change: ChangeEntry): IntentRow {
  const by = world.agents.get(change.agentId);
  const verdict = world.verdicts.get(change.verdictIds.at(-1) ?? "");
  return {
    id: change.id,
    label: change.label,
    goal: change.goal,
    agent: shownAgent(by, cards.get(change.agentId)),
    state: change.state,
    revision: change.revision,
    declaredAt: change.declaredAt,
    ...(verdict === undefined
      ? {}
      : { verdict: { outcome: verdict.outcome, evidence: verdict.evidence.length } }),
    conflicts: change.conflictIds.length,
  };
}

/**
 * The changes Keel told this one have its intent, each as it stands now, in the order Keel named them. One that
 * has since landed or been withdrawn stays: Keel named it, and its state says what became of it. Nothing here
 * orders them by anything else.
 */
function sameIntentOf(
  world: World,
  cards: Cards,
  change: ChangeEntry,
): ChangePageState["sameIntent"] {
  const others = change.alternatives.flatMap((told): AlternativeRow[] => {
    const other = world.changes.get(told.changeId);
    return other === undefined
      ? []
      : [
          {
            ...intentRowOf(world, cards, other),
            ...(told.landed === undefined ? {} : { landed: told.landed }),
            next: told.next,
          },
        ];
  });
  return others.length === 0 ? undefined : { self: intentRowOf(world, cards, change), others };
}

export function changePageOf(
  world: World,
  changeId: string,
  resources: Resources,
): ChangePageState | null {
  const change = world.changes.get(changeId);
  if (change === undefined) return null;
  const cards: Cards = resources.cards ?? new Map();
  const sameIntent = sameIntentOf(world, cards, change);
  const by = world.agents.get(change.agentId);
  const bounce = change.state === "bounced" ? change.bounce : undefined;
  const cause = world.conflicts.get(bounce?.conflictId ?? "");
  // A change bounced on a conflict, on its batch's refused push or on a ruling was given no verdict for that:
  // an earlier one is not this bounce's.
  const verdict =
    bounce?.conflictId === undefined &&
    bounce?.declined === undefined &&
    bounce?.decisionId === undefined
      ? world.verdicts.get(change.verdictIds.at(-1) ?? "")
      : undefined;
  const conflict = cause ?? world.conflicts.get(change.conflictIds.at(-1) ?? "");
  const escalation =
    change.escalationId === undefined ? undefined : world.escalations.get(change.escalationId);
  const diff = resources.diffs.get(change.id);
  const counts = (diff?.files ?? []).map((file) => changedLines(file.before, file.after));
  const withLabel =
    conflict?.parties
      .filter((id) => id !== change.id)
      .map((id) => world.changes.get(id)?.label ?? "") ?? [];
  const chosen = escalation?.options.find(
    (option) => option.id === escalation.ruling?.option,
  )?.label;
  return {
    change: {
      id: change.id,
      label: change.label,
      state: change.state,
      revision: change.revision,
      unverified: change.unverified,
      commit: change.commit ?? "",
      derived: change.derived,
      ...(change.landedAs === undefined ? {} : { landedAs: change.landedAs }),
      workspace:
        change.workspaceId === undefined ? "" : `ws-${change.workspaceId.slice(-8).toLowerCase()}`,
      declaredAt: change.declaredAt,
      ...(change.submittedAt === undefined ? {} : { submittedAt: change.submittedAt }),
      ...(change.laneId === undefined
        ? {}
        : { laneLabel: change.laneId.replace("lane-", "Lane ") }),
    },
    agent: { ...shownAgent(by, cards.get(change.agentId)), model: by?.model ?? "" },
    held: heldUnder(cards, change),
    session: { id: by?.sessionId ?? "", messages: by?.messages ?? 0 },
    intent: {
      goal: change.goal,
      footprint: change.footprint,
      premises: change.premises,
      declaredEffects: change.declaredEffects,
    },
    derived: change.effects.map((effect) => {
      // What an effect contradicts is not in the derivation: it is the conflict Keel opened over it.
      const against = contradictionsOf(world, change.id).find(
        ({ premise: held }) =>
          effect.proposition.subject === held.proposition.subject &&
          effect.proposition.predicate === held.proposition.predicate,
      );
      if (against === undefined) return effect;
      const { proposition: premise, holder } = against.premise;
      return {
        ...effect,
        against: `${nameOf(world, holder)}'s premise: ${premise.predicate} ${premise.relation.replace("-", " ")} ${String(premise.value)}`,
      };
    }),
    drift: change.drift,
    ...(verdict === undefined
      ? {}
      : {
          verdict: {
            id: verdict.id,
            outcome: verdict.outcome,
            summary: verdict.summary,
            said: verdictSaid(verdict),
            issuedAt: verdict.issuedAt,
            ...(verdict.planHash === undefined ? {} : { planHash: verdict.planHash }),
            // The evidence by class comes from Keel's view of the verdict. Until that is read there is none to show.
            evidence: (resources.verdicts.get(verdict.id)?.reasons ?? []).map(readable),
            // Where Keel serves no view of it, what the verdict's own event recorded is all there is, as Keel wrote it.
            ...(resources.refused.has(verdict.id) ? { recorded: verdict.evidence } : {}),
          },
        }),
    ...(conflict === undefined
      ? {}
      : {
          conflict: {
            id: conflict.id,
            label: conflict.label,
            state: conflict.state,
            // A change can also conflict with what trunk already holds.
            with: withLabel.filter((label) => label !== "").join(", ") || "a tenet on trunk",
            summary: conflict.title,
          },
        }),
    ...(sameIntent === undefined ? {} : { sameIntent }),
    ...(bounce === undefined
      ? {}
      : {
          bounce: {
            at: bounce.at,
            ...(cause === undefined
              ? {}
              : {
                  conflict: {
                    id: cause.id,
                    label: cause.label,
                    ...(cause.predicate === undefined ? {} : { predicate: cause.predicate }),
                  },
                }),
            ...(bounce.declined === undefined ? {} : { refused: bounce.declined }),
            ...(bounce.decisionId === undefined
              ? {}
              : { ruling: rulingOf(world, bounce.decisionId, bounce.reasons) }),
            next: bounce.next,
            ...(bounce.cites === undefined ? {} : { cites: bounce.cites }),
          },
        }),
    noted: change.noted.flatMap((note) => {
      const about = world.conflicts.get(note.conflictId);
      return about === undefined
        ? []
        : [
            {
              conflict: { id: about.id, label: about.label },
              predicate: note.predicate,
              policy: note.policy,
              at: note.at,
              next: note.next,
            },
          ];
    }),
    ...(escalation === undefined
      ? {}
      : {
          escalation: {
            id: escalation.id,
            label: escalation.label,
            question: escalation.question,
            state: escalation.state,
            ...(chosen === undefined ? {} : { ruling: chosen }),
          },
        }),
    plan: {
      hash: change.plan?.hash ?? "",
      costEstimateUsd: change.plan?.costEstimate ?? 0,
      steps: planSteps(world, change),
      ...(change.plan?.spec === undefined ? {} : { spec: change.plan.spec }),
      ...(change.plan?.stepCount === undefined ? {} : { stepCount: change.plan.stepCount }),
    },
    diff: {
      state: diff !== undefined ? "read" : resources.refused.has(change.id) ? "refused" : "reading",
      files: diff?.files ?? [],
      annotations: diff === undefined ? [] : annotationsOf(world, change, diff),
      additions: counts.reduce((sum, count) => sum + count.additions, 0),
      deletions: counts.reduce((sum, count) => sum + count.deletions, 0),
    },
    precedents: change.precedents.map((precedent) => ({
      decisionLabel: world.decisions.get(precedent.decisionId)?.label ?? "",
      summary: precedent.summary,
      decidedAt: precedent.decidedAt,
      scope: precedent.scope ?? "",
      ...(precedent.stance === undefined ? {} : { stance: precedent.stance }),
    })),
  };
}
