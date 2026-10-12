// What each view shows, read off the folded world. These are pure: the same
// world and the same instant always give the same picture.

import type { Lattice } from "../contract/keel/index.ts";
import type { FlowNode, StepSpec } from "../contract/provisional.ts";
import type {
  AlternativeRow,
  ChangePageState,
  IntentRow,
  DiffAnnotation,
  EvidenceItem,
  MatrixCell,
  MatrixCheck,
  Outcome,
  Party,
  Pending,
  PlanStep,
  StepOutcome,
  ConflictPageState,
  TimelineItem,
  World as WorldId,
} from "../domain/state.ts";
import type { ChangeDiff, ProbeSource, VerdictReasons } from "../source/types.ts";
import { readable } from "./evidence.ts";
import { chainThrough, valueIdOf } from "./lattice.ts";
import { contradictionsOf, sidesOf } from "./sides.ts";
import type { ChangeEntry, ConflictEntry, EscalationEntry, ProbeEntry, World } from "./world.ts";

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

function party(
  world: World,
  change: ChangeEntry,
  role: "holder" | "other",
  conflict: ConflictEntry,
  subjectKey: string,
): Party {
  const by = world.agents.get(change.agentId);
  const premise = change.premises.find(
    (p) => p.subject === subjectKey && p.predicate === conflict.predicate,
  );
  const effects = change.effects.filter(
    (e) => e.proposition.subject === subjectKey && e.proposition.predicate === conflict.predicate,
  );
  // Where an extractor and Clef both derived it, the extractor's is the fact.
  const effect = effects.find((e) => e.method === "extractor") ?? effects[0];
  const proposition: Party["proposition"] =
    role === "holder" && premise !== undefined
      ? {
          role: "premise",
          relation: premise.relation,
          value: String(premise.value),
          gloss: premise.gloss ?? "",
          origin: "declared",
        }
      : {
          role: "effect",
          relation: effect?.proposition.relation ?? "is",
          value: String(effect?.proposition.value ?? "unknown"),
          gloss: effect?.proposition.gloss ?? "",
          origin: effect?.declared === true ? "declared" : "derived",
          derivation: effects.map((e) => ({
            method: e.method,
            evidenceClass: e.evidenceClass,
            ...(e.method === "extractor" || e.p === undefined ? {} : { p: e.p }),
          })),
        };
  const told = toldOf(change, conflict);
  return {
    world: role === "holder" ? "A" : "B",
    changeId: change.id,
    label: change.label,
    goal: change.goal,
    agent: {
      label: by?.name ?? "Agent",
      class: by?.class ?? "hosted",
      harness: by?.harness ?? "",
    },
    proposition,
    ...(told === undefined ? {} : { told }),
  };
}

/**
 * What Keel told a change's agent about one conflict: the ways forward on the bounce that cites the conflict,
 * or on the note of it. An annotation tells no one, so it gives nothing here.
 */
function toldOf(change: ChangeEntry, conflict: ConflictEntry): Party["told"] {
  if (change.bounce?.conflictId === conflict.id && change.bounce.next.length > 0)
    return { how: "bounced", next: change.bounce.next };
  const note = change.noted.findLast((noted) => noted.conflictId === conflict.id);
  return note === undefined || note.next.length === 0
    ? undefined
    : { how: "noted", next: note.next };
}

function matrixOf(
  world: World,
  conflict: ConflictEntry,
  probe: ProbeEntry | undefined,
  holder: ChangeEntry,
  other: ChangeEntry,
): ConflictPageState["matrix"] {
  // The worlds are Keel's own names for the two sides of a conflict: A holds the premise, B alters what it
  // relies on. Which change each is, by its number, is said beside every world.
  const checks: MatrixCheck[] = [
    { id: "tests-a", label: "A's tests" },
    { id: "tests-b", label: "B's tests" },
    { id: "probe", label: probe === undefined ? "Probe" : `Probe ${probe.label}` },
  ];
  // The first thing not yet in is what is running now; everything after it is still to come.
  let reached = !(probe !== undefined && probe.state === "calibrating");
  const next = (): Pending => {
    if (reached) return "pending";
    reached = true;
    return "running";
  };
  const cellsFor = (id: WorldId): Record<MatrixCheck["id"], MatrixCell> => {
    // Each change's own suite, run in this world.
    const tests = (change: ChangeEntry): MatrixCell => {
      const seen = world.suites.get(`${conflict.id}/${id}/suite:${change.id}`);
      // The control world runs the probe alone: no suite is waited for there, and none is said to be running.
      if (seen === undefined)
        return id === "A-noop" ? { kind: "none" } : { kind: "tests", outcome: next() };
      return {
        kind: "tests",
        outcome: seen.outcome,
        ...(seen.passed === undefined ? {} : { passed: seen.passed }),
        ...(seen.total === undefined ? {} : { total: seen.total }),
        ...(seen.reason === undefined ? {} : { reason: seen.reason }),
      };
    };
    const a = tests(holder);
    const b = tests(other);
    // The matrix is the probe's own record. Keel runs nothing in these worlds once the conflict is settled.
    const ran: Outcome[] = probe?.runs[id] ?? [];
    const runs: [Outcome | Pending, Outcome | Pending, Outcome | Pending] = [
      ran[0] ?? next(),
      ran[1] ?? next(),
      ran[2] ?? next(),
    ];
    const reason = probe?.reasons[id];
    return {
      "tests-a": a,
      "tests-b": b,
      probe: {
        kind: "probe",
        runs,
        ...(reason === undefined ? {} : { reason }),
        ...(id === "A-noop" ? { control: true } : {}),
      },
    };
  };
  // In this order: it is the order the cells arrive in.
  const cells = {
    trunk: cellsFor("trunk"),
    "A-noop": cellsFor("A-noop"),
    A: cellsFor("A"),
    B: cellsFor("B"),
    AB: cellsFor("AB"),
  };
  return {
    worlds: [
      { id: "trunk", label: "trunk", gloss: "Neither change" },
      { id: "A-noop", label: "A-noop", gloss: `${holder.label}, with what it relies on removed` },
      { id: "A", label: "A", gloss: `${holder.label} alone` },
      { id: "B", label: "B", gloss: `${other.label} alone` },
      { id: "AB", label: "A+B", gloss: `${holder.label} and ${other.label}, composed` },
    ],
    checks,
    cells,
  };
}

const TIMES = ["once", "twice", "three runs out of three"];

/** Evidence as it stands before anyone is asked: built from what has happened so far. */
/** Where a conflict's two sides sit on Keel's lattice for its predicate. */
function latticeOf(
  resources: Resources,
  conflict: ConflictEntry,
  a: Party,
  b: Party,
): ConflictPageState["lattice"] {
  const predicate = conflict.predicate ?? "invariant";
  const lattice = resources.lattices.get(predicate);
  const [premise, effect] = [a.proposition.value, b.proposition.value];
  if (lattice === undefined || lattice.covers.length === 0)
    return { predicate, values: [], standing: "unknown" };
  const chain = chainThrough(lattice, [premise, effect]);
  if (chain !== null) return { predicate, values: chain, standing: "ranked" };
  // Both are values of this lattice, and it puts neither above the other.
  const known =
    valueIdOf(lattice, premise) !== undefined && valueIdOf(lattice, effect) !== undefined;
  return { predicate, values: [], standing: known ? "unranked" : "unknown" };
}

function evidenceSoFar(
  world: World,
  conflict: ConflictEntry,
  probe: ProbeEntry | undefined,
  holder: ChangeEntry,
  other: ChangeEntry,
  subjectKey: string,
  line: readonly string[],
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const fails = probe?.runs.AB.filter((outcome) => outcome === "fail").length ?? 0;
  if (probe !== undefined && fails > 0) {
    items.push({
      class: "proof",
      summary: `Probe ${probe.label} fails in A+B, ${TIMES[fails - 1] ?? ""}${fails < 3 ? " so far" : ""}`,
      by: "World matrix · Tier 1 isolate",
      ref: `prb:${probe.id}/AB`,
      at: conflict.openedAt,
    });
  }
  const onSubject = other.effects.filter(
    (e) => e.proposition.subject === subjectKey && e.proposition.predicate === conflict.predicate,
  );
  for (const effect of onSubject) {
    if (effect.method === "extractor") {
      items.push({
        class: effect.evidenceClass,
        summary: `Extractor: ${effect.proposition.gloss ?? `${effect.proposition.predicate} ${effect.proposition.relation} ${String(effect.proposition.value)}`}`,
        by: "Effect derivation · extractor",
        ref: `${effect.anchors[0]?.path ?? ""}#${effect.anchors[0]?.symbol ?? ""}`,
        at: conflict.openedAt,
      });
    }
  }
  const premise = holder.premises.find(
    (p) => p.subject === subjectKey && p.predicate === conflict.predicate,
  );
  // The lattice rules only on a derived fact. An opinion of Clef's is weighed, not ruled on.
  const contradicting = onSubject.find((e) => e.method === "extractor");
  if (premise !== undefined && contradicting !== undefined) {
    items.push({
      class: "ruling",
      summary: `${String(contradicting.proposition.value)} is not ${premise.relation.replace("-", " ")} ${String(premise.value)}`,
      by: `Lattice comparison · ${conflict.predicate ?? ""}`,
      ref: `lattice:${conflict.predicate ?? ""}`,
      at: conflict.openedAt,
      ...(line.length === 0 ? {} : { detail: `Deterministic: ${line.join(" < ")}.` }),
    });
  }
  const testsA = world.suites.get(`${conflict.id}/AB/suite:${holder.id}`);
  const testsB = world.suites.get(`${conflict.id}/AB/suite:${other.id}`);
  if (testsA?.outcome === "pass" && testsB?.outcome === "pass") {
    items.push({
      class: "proof",
      summary: `A's tests (${testsA.total ?? 0}) and B's tests (${testsB.total ?? 0}) all pass in A+B`,
      by: "World matrix · Tier 1 isolate",
      ref: `cnd:${conflict.id}/AB/tests`,
      at: testsB.at,
      detail: "Nothing either change wrote notices the disagreement.",
    });
  }
  const vague = other.premises.find((p) => p.subject === subjectKey);
  if (vague?.gloss !== undefined) {
    items.push({
      class: "testimony",
      summary: `${other.label}: “${vague.gloss}.”`,
      by: `${world.agents.get(other.agentId)?.name ?? "Agent"} · intent, revision 1`,
      ref: `chg:${other.id}`,
      at: other.declaredAt,
    });
  }
  for (const effect of onSubject) {
    if (effect.method === "clef") {
      items.push({
        class: "opinion",
        summary: `Clef: ${(effect.proposition.gloss ?? "").replace(/^./, (c) => c.toLowerCase())}, p = ${effect.p}`,
        by: "Effect derivation · Clef",
        ref: `drv:${other.id}/clef`,
        at: conflict.openedAt,
      });
    }
  }
  return items;
}

export function conflictPageOf(
  world: World,
  conflictId: string,
  resources: Resources,
): ConflictPageState | null {
  const conflict = world.conflicts.get(conflictId);
  const subject =
    conflict?.subjectId === undefined ? undefined : world.subjects.get(conflict.subjectId);
  if (conflict === undefined || subject === undefined || conflict.predicate === undefined)
    return null;
  const pair = sidesOf(world, conflict);
  if (pair === null) return null;
  const probe = conflict.probeId === undefined ? undefined : world.probes.get(conflict.probeId);
  const escalation =
    conflict.escalationId === undefined ? undefined : world.escalations.get(conflict.escalationId);
  const guard = conflict.guardId === undefined ? undefined : world.guards.get(conflict.guardId);
  const decision =
    conflict.decisionId === undefined ? undefined : world.decisions.get(conflict.decisionId);
  const timeline: TimelineItem[] = conflict.timeline.map((entry, index, all) => ({
    at: entry.at,
    type: entry.type,
    title: entry.title,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(index === all.length - 1 ? { now: true } : {}),
  }));
  const parties = {
    A: party(world, pair.holder, "holder", conflict, subject.key),
    B: party(world, pair.other, "other", conflict, subject.key),
  };
  const lattice = latticeOf(resources, conflict, parties.A, parties.B);
  return {
    conflict: {
      id: conflict.id,
      label: conflict.label,
      kind: conflict.kind,
      state: conflict.state,
      silentRetraction: conflict.silentRetraction,
      openedAt: conflict.openedAt,
      summary: conflict.summary,
      ...(conflict.costUsd === undefined ? {} : { costUsd: conflict.costUsd }),
    },
    ...(escalation === undefined
      ? {}
      : {
          escalation: {
            id: escalation.id,
            label: escalation.label,
            question: escalation.question,
            state: escalation.state,
          },
        }),
    ...(guard === undefined ? {} : { guard: { label: guard.label, state: guard.state } }),
    ...(decision === undefined
      ? {}
      : { decision: { label: decision.label, chosen: decision.chosen } }),
    subject: { key: subject.key, gloss: subject.gloss },
    lattice,
    parties,
    matrix: matrixOf(world, conflict, probe, pair.holder, pair.other),
    after: [pair.holder, pair.other].flatMap((side) => {
      const judged = world.verdicts.get(side.verdictIds.at(-1) ?? "");
      if (conflict.settledT === undefined || judged === undefined) return [];
      if (judged.issuedT < conflict.settledT) return [];
      return [
        {
          changeId: side.id,
          label: side.label,
          revision: side.verdictRevision ?? side.revision,
          outcome: judged.outcome,
          summary: judged.summary,
        },
      ];
    }),
    probe: {
      id: probe?.id ?? "",
      label: probe?.label ?? "",
      attempt: probe?.attempts ?? 0,
      bundleHash: probe?.bundleHash ?? "",
      state: probe?.state ?? "calibrating",
      path: probe?.path ?? "",
      source: probe === undefined ? "" : (resources.probes.get(probe.id)?.source ?? ""),
    },
    evidence:
      escalation === undefined
        ? evidenceSoFar(
            world,
            conflict,
            probe,
            pair.holder,
            pair.other,
            subject.key,
            lattice.values,
          )
        : escalation.evidence,
    timeline,
  };
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
      const decided = probe.runs.AB.length === 3;
      outcome = !decided
        ? "running"
        : probe.runs.AB.every((run) => run === "fail")
          ? "fail"
          : "pass";
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
function intentRowOf(world: World, change: ChangeEntry): IntentRow {
  const by = world.agents.get(change.agentId);
  const verdict = world.verdicts.get(change.verdictIds.at(-1) ?? "");
  return {
    id: change.id,
    label: change.label,
    goal: change.goal,
    agent: { label: by?.name ?? "Agent", class: by?.class ?? "hosted", harness: by?.harness ?? "" },
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
function sameIntentOf(world: World, change: ChangeEntry): ChangePageState["sameIntent"] {
  const others = change.alternatives.flatMap((told): AlternativeRow[] => {
    const other = world.changes.get(told.changeId);
    return other === undefined
      ? []
      : [
          {
            ...intentRowOf(world, other),
            ...(told.landed === undefined ? {} : { landed: told.landed }),
            next: told.next,
          },
        ];
  });
  return others.length === 0 ? undefined : { self: intentRowOf(world, change), others };
}

export function changePageOf(
  world: World,
  changeId: string,
  resources: Resources,
): ChangePageState | null {
  const change = world.changes.get(changeId);
  if (change === undefined) return null;
  const sameIntent = sameIntentOf(world, change);
  const by = world.agents.get(change.agentId);
  const bounce = change.state === "bounced" ? change.bounce : undefined;
  const cause = world.conflicts.get(bounce?.conflictId ?? "");
  // A change bounced on a conflict, or on its batch's refused push, was given no verdict for that: an earlier
  // one is not this bounce's.
  const verdict =
    bounce?.conflictId === undefined && bounce?.declined === undefined
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
      workspace:
        change.workspaceId === undefined ? "" : `ws-${change.workspaceId.slice(-8).toLowerCase()}`,
      declaredAt: change.declaredAt,
      ...(change.submittedAt === undefined ? {} : { submittedAt: change.submittedAt }),
      ...(change.laneId === undefined
        ? {}
        : { laneLabel: change.laneId.replace("lane-", "Lane ") }),
    },
    agent: {
      label: by?.name ?? "Agent",
      class: by?.class ?? "hosted",
      harness: by?.harness ?? "",
      model: by?.model ?? "",
    },
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
        ({ conflict: open, subjectKey }) =>
          effect.proposition.subject === subjectKey &&
          effect.proposition.predicate === open.predicate,
      );
      const premise = against?.sides.holder.premises.find(
        (p) => p.subject === against.subjectKey && p.predicate === against.conflict.predicate,
      );
      if (against === undefined || premise === undefined) return effect;
      return {
        ...effect,
        against: `${against.sides.holder.label}'s premise: ${premise.predicate} ${premise.relation.replace("-", " ")} ${String(premise.value)}`,
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
            issuedAt: verdict.issuedAt,
            ...(verdict.planHash === undefined ? {} : { planHash: verdict.planHash }),
            // The evidence itself comes from Keel's view of the verdict. Until that is read there is none to show.
            evidence: (resources.verdicts.get(verdict.id)?.reasons ?? []).map(readable),
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
            summary: conflict.summary,
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
            next: bounce.next,
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
