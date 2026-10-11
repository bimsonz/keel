// The console's picture of Keel, folded from the event log one event at a
// time. Nothing here is invented: every field comes from an event or an
// observation, and replaying the same log gives the same world.

import type { EntityRef } from "../contract/envelope.ts";
import type { AgentKind, AnyEvent, DriftEntry } from "../contract/events.ts";
import type {
  DerivedEffect,
  FootprintEntry,
  Predicate,
  Proposition,
  VerdictOutcome,
} from "../contract/mfp.ts";
import type {
  FunnelObservation,
  MetricsObservation,
  Observation,
  SealObservation,
  StepObservation,
  UnsealObservation,
} from "../contract/observations.ts";
import type { EscalationCategory, EscalationOption } from "../contract/events.ts";
import type { FlowNode } from "../contract/provisional.ts";
import type { EvidenceItem } from "../domain/state.ts";
import type {
  AgentClass,
  CandidateState,
  ChangeState,
  ConflictKind,
  ConflictState,
  Outcome,
  World as WorldId,
} from "../domain/state.ts";

export interface AgentEntry {
  id: string;
  name: string;
  class: AgentClass;
  harness: string;
  model?: string;
  sessionId?: string;
  messages: number;
}

export interface SubjectEntry {
  id: string;
  key: string;
  gloss: string;
  /** Premises changes hold here, by change id. */
  premises: Map<string, Proposition>;
  tenetIds: string[];
  guardIds: string[];
  decisionIds: string[];
}

export interface ChangeEntry {
  id: string;
  label: string;
  agentId: string;
  goal: string;
  state: ChangeState;
  revision: number;
  footprint: FootprintEntry[];
  premises: Proposition[];
  /** What the agent said the change would make true. Advisory. */
  declaredEffects: Proposition[];
  effects: DerivedEffect[];
  drift: DriftEntry[];
  /** `spec` is the plan's flow when Keel publishes it; until then only `stepCount`, how many steps it has. */
  plan?: {
    hash: string;
    spec?: FlowNode;
    stepCount?: number;
    costEstimate: number;
    instanceId?: string;
  };
  laneId?: string;
  batchId?: string;
  workspaceId?: string;
  commit?: string;
  declaredAt: string;
  declaredT: number;
  submittedAt?: string;
  submittedT?: number;
  landedT?: number;
  escalationId?: string;
  verdictIds: string[];
  /** The revision the change stood at when its latest verdict reached it. A verdict names no revision itself. */
  verdictRevision?: number;
  /** True once it has a verdict, or has landed in an advance, that was not verified. */
  unverified: boolean;
  conflictIds: string[];
  /** Each time a guard failed in this change's own plan: Keel's fact, with the revision it was at. */
  guardFailures: { guardId: string; revision: number; at: string }[];
  /** Its latest bounce, and the one thing Keel named as its cause: a verdict, or a conflict proven against it. */
  bounce?: { at: string; verdictId?: string; conflictId?: string };
  /** Conflicts Keel proved against it and did not stop it for: the project's policy for the predicate was not to block. */
  noted: { conflictId: string; predicate: Predicate; policy: "advise" | "annotate"; at: string }[];
  /** Decisions surfaced to it, each dated, and the stance it went on to take. */
  precedents: {
    decisionId: string;
    summary: string;
    decidedAt: string;
    scope?: string;
    stance?: "followed" | "distinguished" | "overrule-requested";
  }[];
}

export interface TimelineEntry {
  t: number;
  at: string;
  type: string;
  title: string;
  detail?: string;
}

export interface ConflictEntry {
  id: string;
  label: string;
  kind: ConflictKind;
  state: ConflictState;
  parties: string[];
  subjectId?: string;
  predicate?: Predicate;
  summary: string;
  silentRetraction: boolean;
  probeId?: string;
  guardId?: string;
  escalationId?: string;
  decisionId?: string;
  costUsd?: number;
  openedAt: string;
  /** When it was resolved or dismissed, in simulated ms. */
  settledT?: number;
  timeline: TimelineEntry[];
}

export interface ProbeEntry {
  id: string;
  label: string;
  conflictId: string;
  attempts: number;
  bundleHash: string;
  path: string;
  state: "calibrating" | "admitted" | "discarded";
  runs: Record<WorldId, Outcome[]>;
  reasons: Partial<Record<WorldId, string>>;
  /** What its runs have cost so far. Absent until Keel records a cost for one. */
  costUsd?: number;
}

export interface EscalationEntry {
  id: string;
  label: string;
  question: string;
  category: EscalationCategory;
  options: EscalationOption[];
  /** The id of the option that stands while nobody has answered. */
  default: string;
  evidence: EvidenceItem[];
  /** Decisions that bear on the question, by id. */
  precedents: string[];
  about: EntityRef;
  state: "open" | "ruled" | "withdrawn";
  raisedAt: string;
  raisedT: number;
  ruling?: { option: string; by: string; at: string };
}

export interface DecisionEntry {
  id: string;
  label: string;
  question: string;
  chosen: string;
  scope: string;
  decidedAt: string;
  alternatives: { option: string; reasonRejected: string }[];
  state: "active" | "superseded" | "overruled";
}

export interface GuardEntry {
  id: string;
  label: string;
  probeId: string;
  conflictId: string;
  state: "admitted" | "retired";
  admittedAt: string;
}

export interface VerdictEntry {
  id: string;
  subject: string;
  outcome: VerdictOutcome;
  summary: string;
  /** References to its evidence. The evidence itself is read from Keel's view of the verdict, when someone looks. */
  evidence: string[];
  /** Absent for a ruling made at Precheck, before any plan is compiled. */
  planHash?: string;
  issuedAt: string;
  /** When it was issued, in the log's own milliseconds. */
  issuedT: number;
}

export interface BatchEntry {
  id: string;
  label: string;
  laneId: string;
  members: string[];
  state: CandidateState;
  tier: 0 | 1 | 2;
}

export interface TrunkEntry {
  head: string;
  advances: number;
  redCount: number;
  changesLanded: number;
  /** Advances made with verification switched off. Zero on any project that verifies. */
  unverifiedAdvances: number;
  humansAsked: number;
  /** For each landed change: when it landed and how long it took from declaration, in ms. */
  landings: { t: number; tookMs: number }[];
  recent: {
    height: number;
    members: number;
    commuted: boolean;
    t: number;
    proofId: string;
    verifiedAt: number;
  }[];
  audits: { head: string; outcome: "green" | "red"; t: number }[];
}

/** `human` is the operator or a sponsor, never an agent, so it has no class. */
const CLASS_OF: Record<Exclude<AgentKind, "human">, AgentClass> = {
  interactive: "real",
  hosted: "hosted",
  synthetic: "synthetic",
};

const NO_RUNS = (): Record<WorldId, Outcome[]> => ({
  trunk: [],
  "A-noop": [],
  A: [],
  B: [],
  AB: [],
});

/** One suite's latest run in one world: a cell of the world matrix outside the probe's column. */
export interface SuiteRun {
  outcome: Outcome;
  passed?: number;
  total?: number;
  reason?: string;
  at: string;
}

function short(id: string): string {
  return id.slice(-4);
}

export class World {
  /** Bumps on every change, so a reader can tell whether to look again. */
  version = 0;
  readonly agents = new Map<string, AgentEntry>();
  readonly subjects = new Map<string, SubjectEntry>();
  readonly changes = new Map<string, ChangeEntry>();
  readonly conflicts = new Map<string, ConflictEntry>();
  readonly probes = new Map<string, ProbeEntry>();
  readonly escalations = new Map<string, EscalationEntry>();
  readonly decisions = new Map<string, DecisionEntry>();
  readonly guards = new Map<string, GuardEntry>();
  readonly verdicts = new Map<string, VerdictEntry>();
  readonly batches = new Map<string, BatchEntry>();
  /** Session id to agent id. */
  readonly sessions = new Map<string, string>();
  /** The suites' cells of the world matrix, keyed `conflictId/world/suite:<changeId>`. The latest run stands. */
  readonly suites = new Map<string, SuiteRun>();
  /** The latest status of each step, keyed `subject/stepId`. */
  readonly steps = new Map<string, StepObservation>();
  /** The latest counters only the platform knows. */
  metrics: MetricsObservation | undefined;
  /** The review funnel's cheaper levels, as last reported. Absent when the source does not count them. */
  funnel: FunnelObservation | undefined;
  /** A swarm runner's commitment to its ground truth, and the ground truth once it is published. */
  seal: SealObservation | undefined;
  unseal: UnsealObservation | undefined;
  /** The project this log is about, once the log has named it. */
  project: { id: string; name: string } | undefined;
  /**
   * What each commit on trunk landed, by the commit: Keel's history names a commit's change, and the advance
   * that put it on trunk is what says how high trunk then stood and whether it was verified.
   */
  readonly landed = new Map<string, { changeId?: string; height: number; unverified: boolean }>();
  readonly trunk: TrunkEntry = {
    head: "",
    advances: 0,
    redCount: 0,
    changesLanded: 0,
    unverifiedAdvances: 0,
    humansAsked: 0,
    landings: [],
    recent: [],
    audits: [],
  };

  subjectByKey(key: string): SubjectEntry | undefined {
    for (const subject of this.subjects.values()) if (subject.key === key) return subject;
    return undefined;
  }

  #change(id: string, state?: ChangeState): ChangeEntry | undefined {
    const change = this.changes.get(id);
    if (change !== undefined && state !== undefined) change.state = state;
    return change;
  }

  #note(
    conflictId: string | undefined,
    event: AnyEvent,
    t: number,
    title: string,
    detail?: string,
  ): void {
    if (conflictId === undefined) return;
    this.conflicts.get(conflictId)?.timeline.push({
      t,
      at: event.at,
      type: event.type,
      title,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** The open conflict a change is party to, if any. */
  #conflictOf(changeId: string): string | undefined {
    return this.changes.get(changeId)?.conflictIds.at(-1);
  }

  #labelOf(changeId: string): string {
    return this.changes.get(changeId)?.label ?? short(changeId);
  }

  observe(observation: Observation): void {
    this.version += 1;
    if (observation.kind === "step") {
      this.steps.set(`${observation.subject}/${observation.stepId}`, observation);
    } else if (observation.kind === "metrics") {
      this.metrics = observation;
    } else if (observation.kind === "funnel") {
      this.funnel = observation;
    } else if (observation.kind === "seal") {
      this.seal = observation;
    } else if (observation.kind === "unseal") {
      this.unseal = observation;
    }
  }

  apply(event: AnyEvent, t: number): void {
    this.version += 1;
    const p = event.payload;
    switch (event.type) {
      case "AgentEnrolled": {
        if (event.payload.kind === "human") break;
        this.agents.set(event.payload.agentId, {
          id: event.payload.agentId,
          name: event.payload.name,
          class: CLASS_OF[event.payload.kind],
          // The harness is the session's to say (SessionOpened).
          harness: "",
          messages: 0,
        });
        break;
      }
      case "SessionOpened": {
        this.sessions.set(event.payload.sessionId, event.payload.agentId);
        const agent = this.agents.get(event.payload.agentId);
        if (agent === undefined) break;
        agent.sessionId = event.payload.sessionId;
        if (event.payload.harness !== undefined) agent.harness = event.payload.harness;
        if (event.payload.model !== undefined) agent.model = event.payload.model;
        break;
      }
      case "MessagesCaptured": {
        const agent = this.agents.get(this.sessions.get(event.payload.sessionId) ?? "");
        if (agent !== undefined) agent.messages = Math.max(agent.messages, event.payload.toSeq + 1);
        break;
      }
      case "SubjectMinted": {
        this.subjects.set(event.payload.subjectId, {
          id: event.payload.subjectId,
          key: event.payload.key,
          gloss: event.payload.gloss,
          premises: new Map(),
          tenetIds: [],
          guardIds: [],
          decisionIds: [],
        });
        break;
      }
      case "IntentDeclared": {
        this.changes.set(event.payload.changeId, {
          id: event.payload.changeId,
          // Keel numbers a project's changes as it records them: #1, #2, … Without one, part of the id.
          label: event.label ?? short(event.payload.changeId),
          agentId: event.payload.agentId,
          goal: event.payload.goal,
          state: "declared",
          revision: 1,
          footprint: event.payload.footprint,
          premises: event.payload.premises,
          declaredEffects: event.payload.declaredEffects ?? [],
          effects: [],
          drift: [],
          declaredAt: event.at,
          declaredT: t,
          verdictIds: [],
          unverified: false,
          conflictIds: [],
          guardFailures: [],
          noted: [],
          precedents: [],
        });
        break;
      }
      case "PreflightIssued": {
        const change = this.#change(event.payload.changeId);
        if (change === undefined) break;
        for (const precedent of event.payload.precedents) {
          if (change.precedents.some((known) => known.decisionId === precedent.decisionId))
            continue;
          // An instant inside a payload is milliseconds; the world keeps every time as Keel's envelope has it.
          change.precedents.push({
            decisionId: precedent.decisionId,
            summary: precedent.summary,
            decidedAt: new Date(precedent.decidedAt).toISOString(),
            ...(precedent.scope === undefined ? {} : { scope: precedent.scope }),
          });
        }
        break;
      }
      case "IntentRevised": {
        const change = this.#change(event.payload.changeId, "working");
        if (change === undefined) break;
        change.revision = event.payload.revision;
        if (event.payload.goal !== undefined) change.goal = event.payload.goal;
        if (event.payload.footprint !== undefined) change.footprint = event.payload.footprint;
        const retracted = new Set(
          event.payload.premisesRetracted.map(
            (premise) => `${premise.subject}/${premise.predicate}`,
          ),
        );
        change.premises = [
          ...change.premises.filter(
            (premise) => !retracted.has(`${premise.subject}/${premise.predicate}`),
          ),
          ...event.payload.premisesAdded,
        ];
        if (event.payload.declaredEffects !== undefined)
          change.declaredEffects = event.payload.declaredEffects;
        this.#note(
          this.#conflictOf(change.id),
          event,
          t,
          `${change.label} revises its intent`,
          `Revision ${event.payload.revision}`,
        );
        break;
      }
      case "PremiseRelied": {
        this.subjects
          .get(event.payload.subjectId)
          ?.premises.set(event.payload.changeId, event.payload.premise);
        break;
      }
      case "ChangeStarted": {
        const change = this.#change(event.payload.changeId, "working");
        if (change !== undefined) change.workspaceId = event.payload.workspaceId;
        break;
      }
      case "TrunkInitialized": {
        this.trunk.head = event.payload.head;
        // Where trunk starts is a commit that landed no change: its height is none.
        this.landed.set(event.payload.head, { height: 0, unverified: false });
        break;
      }
      case "ChangeSubmitted": {
        const change = this.#change(event.payload.changeId, "submitted");
        if (change === undefined) break;
        change.revision = event.payload.revision;
        change.commit = event.payload.commitSha;
        change.submittedAt = event.at;
        change.submittedT = t;
        break;
      }
      case "PrecheckStarted": {
        const change = this.#change(event.payload.changeId, "deriving");
        if (change === undefined) break;
        // Drift and step runs belong to one revision's check. The next revision's starts clean.
        change.drift = [];
        for (const key of this.steps.keys())
          if (key.startsWith(`${change.id}/`)) this.steps.delete(key);
        break;
      }
      case "EffectsDerived": {
        const change = this.#change(event.payload.changeId);
        if (change !== undefined) change.effects = event.payload.effects;
        break;
      }
      case "DriftDetected": {
        const change = this.#change(event.payload.changeId);
        if (change !== undefined) change.drift = event.payload.drift;
        break;
      }
      case "ChangeDrifted": {
        this.#change(event.payload.changeId, "drifted");
        break;
      }
      case "PlanCompiled": {
        const change = this.#change(event.payload.changeId, "verifying");
        if (change !== undefined) {
          const { steps } = event.payload;
          change.plan = {
            hash: event.payload.planHash,
            ...(typeof steps === "number" ? { stepCount: steps } : { spec: steps }),
            costEstimate: event.payload.costEstimate,
          };
        }
        break;
      }
      case "ChangeQueued": {
        const change = this.#change(event.payload.changeId, "queued");
        if (change !== undefined) change.laneId = event.payload.laneId;
        break;
      }
      case "ChangeBatched": {
        const change = this.#change(event.payload.changeId, "integrating");
        if (change !== undefined) change.batchId = event.payload.batchId;
        break;
      }
      case "ChangeRequeued": {
        this.#change(event.payload.changeId, "queued");
        break;
      }
      case "ChangeLanded": {
        const change = this.#change(event.payload.changeId, "landed");
        if (change === undefined) break;
        change.landedT = t;
        this.trunk.changesLanded += 1;
        // By the events' own timestamps: history replayed at once still took the time it took.
        this.trunk.landings.push({
          t,
          tookMs: Date.parse(event.at) - Date.parse(change.declaredAt),
        });
        this.#note(
          this.#conflictOf(change.id),
          event,
          t,
          `${change.label} lands`,
          `trunk ${event.payload.trunkSha.slice(0, 7)}`,
        );
        break;
      }
      case "ChangeBounced": {
        const change = this.#change(event.payload.changeId, "bounced");
        if (change !== undefined) {
          const { verdictId, conflictId } = event.payload;
          change.bounce = {
            at: event.at,
            ...(verdictId === undefined ? {} : { verdictId }),
            ...(conflictId === undefined ? {} : { conflictId }),
          };
          // A bounce on a conflict ties the change to it, whether or not the change was one of its two sides.
          if (conflictId !== undefined && !change.conflictIds.includes(conflictId))
            change.conflictIds.push(conflictId);
          this.#note(
            this.#conflictOf(change.id),
            event,
            t,
            `${change.label} bounces`,
            event.payload.nextActions?.[0]?.title,
          );
        }
        break;
      }
      case "ConflictNoted": {
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        const { conflictId, predicate, policy } = event.payload;
        change.noted.push({ conflictId, predicate, policy, at: event.at });
        this.#note(conflictId, event, t, `Noted against ${change.label}`, `policy: ${policy}`);
        break;
      }
      case "ChangeParked": {
        const change = this.#change(event.payload.changeId, "parked");
        if (change !== undefined && event.payload.escalationId !== undefined)
          change.escalationId = event.payload.escalationId;
        break;
      }
      case "ChangeResumed": {
        this.#change(event.payload.changeId, "verifying");
        break;
      }
      case "ChangeAdopted": {
        const change = this.#change(event.payload.changeId, "working");
        if (change !== undefined) change.agentId = event.payload.agentId;
        break;
      }
      case "ChangeWithdrawn": {
        const change = this.#change(event.payload.changeId, "withdrawn");
        if (change !== undefined)
          this.#note(
            this.#conflictOf(change.id),
            event,
            t,
            `${change.label} is withdrawn`,
            event.payload.reason,
          );
        break;
      }
      case "ChangeSuperseded": {
        this.#change(event.payload.changeId, "superseded");
        break;
      }
      case "ConflictSuspected": {
        const parties = event.payload.parties;
        this.conflicts.set(event.payload.conflictId, {
          id: event.payload.conflictId,
          label: event.label ?? `C·${short(event.payload.conflictId)}`,
          kind: event.payload.kind,
          state: "suspected",
          parties,
          ...(event.payload.subjectId === undefined ? {} : { subjectId: event.payload.subjectId }),
          ...(event.payload.predicate === undefined ? {} : { predicate: event.payload.predicate }),
          summary: event.payload.x?.summary ?? "",
          silentRetraction: event.payload.x?.silentRetraction ?? false,
          openedAt: event.at,
          timeline: [],
        });
        for (const party of parties)
          this.changes.get(party)?.conflictIds.push(event.payload.conflictId);
        // The story of a conflict starts before it opens: with the submission that caused it.
        const cause = parties
          .map((party) => this.changes.get(party))
          .findLast((change) => change?.submittedAt !== undefined);
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (cause !== undefined && conflict !== undefined) {
          const subjectKey = this.subjects.get(event.payload.subjectId ?? "")?.key;
          const effect =
            cause.effects.find(
              (candidate) =>
                candidate.proposition.subject === subjectKey &&
                candidate.proposition.predicate === event.payload.predicate,
            ) ?? cause.effects[0];
          conflict.timeline.push({
            t: cause.submittedT ?? t,
            at: cause.submittedAt ?? event.at,
            type: "ChangeSubmitted",
            title: `${cause.label} submits`,
            detail: `commit ${cause.commit ?? ""}`,
          });
          if (effect !== undefined) {
            conflict.timeline.push({
              t,
              at: event.at,
              type: "EffectsDerived",
              title: `Keel derives: ${effect.proposition.predicate} ${effect.proposition.relation} ${String(effect.proposition.value)}`,
              detail: effect.declared ? "Declared by the agent" : `${cause.label} declared nothing`,
            });
          }
          if (conflict.silentRetraction) {
            conflict.timeline.push({
              t,
              at: event.at,
              type: "DriftDetected",
              title: "Silent retraction",
              detail: "An undeclared effect contradicts a live premise",
            });
          }
        }
        this.#note(
          event.payload.conflictId,
          event,
          t,
          `Conflict ${conflict?.label ?? ""} opens`,
          `${parties.map((party) => this.#labelOf(party)).join(" and ")}${event.payload.predicate === undefined ? "" : `, on ${event.payload.predicate}`}`,
        );
        break;
      }
      case "ProbeDrafted": {
        const label = event.label ?? `P·${short(event.payload.probeId)}`;
        this.probes.set(event.payload.probeId, {
          id: event.payload.probeId,
          label,
          conflictId: event.payload.conflictId,
          attempts: event.payload.attempts,
          bundleHash: event.payload.bundleHash,
          path: event.payload.x?.path ?? "",
          state: "calibrating",
          runs: NO_RUNS(),
          reasons: {},
        });
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict !== undefined) {
          conflict.state = "probing";
          conflict.probeId = event.payload.probeId;
        }
        this.#note(
          event.payload.conflictId,
          event,
          t,
          `Probe ${label} drafted`,
          `Attempt ${event.payload.attempts} of 3`,
        );
        break;
      }
      case "ProbeRan": {
        const probe = this.probes.get(event.payload.probeId);
        if (probe === undefined) break;
        const world = event.payload.world;
        probe.runs[world][event.payload.run - 1] = event.payload.outcome;
        const usd = event.payload.x?.cost?.usd;
        if (usd !== undefined) probe.costUsd = (probe.costUsd ?? 0) + usd;
        if (event.payload.x?.reason !== undefined) probe.reasons[world] = event.payload.x.reason;
        const name = world === "AB" ? "A+B" : world;
        // The deciding world is told run by run; the others once all three are in.
        if (world === "AB") {
          this.#note(
            event.payload.conflictId,
            event,
            t,
            `${name}, run ${event.payload.run}: ${event.payload.outcome}`,
          );
        } else if (event.payload.run === 3) {
          this.#note(
            event.payload.conflictId,
            event,
            t,
            `${name}: ${event.payload.outcome}, three runs`,
          );
        }
        break;
      }
      case "WorldCheckRan": {
        const { counts } = event.payload;
        this.suites.set(
          `${event.payload.conflictId}/${event.payload.world}/${event.payload.check}`,
          {
            outcome: event.payload.outcome,
            ...(counts === undefined
              ? {}
              : { passed: counts.passed, total: counts.passed + counts.failed + counts.skipped }),
            ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
            at: event.at,
          },
        );
        break;
      }
      case "ProbeDiscarded": {
        const probe = this.probes.get(event.payload.probeId);
        if (probe === undefined) break;
        probe.state = "discarded";
        this.#note(
          probe.conflictId,
          event,
          t,
          `Probe ${probe.label} discarded`,
          event.payload.reason,
        );
        break;
      }
      case "GuardAdmitted": {
        const label = event.label ?? `G·${short(event.payload.guardId)}`;
        this.guards.set(event.payload.guardId, {
          id: event.payload.guardId,
          label,
          probeId: event.payload.probeId,
          conflictId: event.payload.conflictId,
          state: "admitted",
          admittedAt: event.at,
        });
        const probe = this.probes.get(event.payload.probeId);
        if (probe !== undefined) probe.state = "admitted";
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict !== undefined) {
          conflict.guardId = event.payload.guardId;
          if (conflict.subjectId !== undefined)
            this.subjects.get(conflict.subjectId)?.guardIds.push(event.payload.guardId);
        }
        this.#note(
          event.payload.conflictId,
          event,
          t,
          `Guard ${label} admitted`,
          `${probe?.label ?? "The probe"} discriminates, three runs out of three`,
        );
        break;
      }
      case "GuardFailed": {
        // In a change's own plan it is a fact of that change. In a batch's candidate it feeds the batch's verdict.
        const change =
          event.payload.changeId === undefined
            ? undefined
            : this.changes.get(event.payload.changeId);
        change?.guardFailures.push({
          guardId: event.payload.guardId,
          revision: change.revision,
          at: event.at,
        });
        break;
      }
      case "GuardRetired": {
        const guard = this.guards.get(event.payload.guardId);
        if (guard === undefined) break;
        guard.state = "retired";
        this.#note(
          guard.conflictId,
          event,
          t,
          `Guard ${guard.label} retired`,
          "The decision went the other way",
        );
        break;
      }
      case "ConflictProven": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "proven";
        if (event.payload.x?.cost?.usd !== undefined) conflict.costUsd = event.payload.x.cost.usd;
        this.#note(conflict.id, event, t, `Conflict ${conflict.label} is proven`);
        break;
      }
      case "ConflictDismissed": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "dismissed";
        conflict.settledT = t;
        if (event.payload.x?.cost?.usd !== undefined) conflict.costUsd = event.payload.x.cost.usd;
        this.#note(
          conflict.id,
          event,
          t,
          `Conflict ${conflict.label} dismissed`,
          "The probe gave the same answer in every world",
        );
        break;
      }
      case "ConflictEscalated": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "escalated";
        conflict.escalationId = event.payload.escalationId;
        const escalation = this.escalations.get(event.payload.escalationId);
        this.#note(
          conflict.id,
          event,
          t,
          `A person is asked: ${escalation?.label ?? ""}`,
          escalation?.question,
        );
        break;
      }
      case "ConflictResolved": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "resolved";
        conflict.settledT = t;
        if (event.payload.decisionId !== undefined) conflict.decisionId = event.payload.decisionId;
        break;
      }
      case "VerdictIssued": {
        this.verdicts.set(event.payload.verdictId, {
          id: event.payload.verdictId,
          subject: event.payload.subject,
          outcome: event.payload.outcome,
          summary: event.payload.x?.summary ?? "",
          evidence: event.payload.evidence,
          ...(event.payload.planHash === undefined ? {} : { planHash: event.payload.planHash }),
          issuedAt: event.at,
          issuedT: t,
        });
        const judged = this.changes.get(event.payload.subject);
        if (judged !== undefined) {
          judged.verdictIds.push(event.payload.verdictId);
          judged.verdictRevision = judged.revision;
          if (event.payload.verified === false) judged.unverified = true;
        }
        break;
      }
      case "EscalationRaised": {
        this.escalations.set(event.payload.escalationId, {
          id: event.payload.escalationId,
          label: event.label ?? `E·${short(event.payload.escalationId)}`,
          question: event.payload.question,
          category: event.payload.category,
          // Copied: the world never hands out an event's own payload.
          options: event.payload.options.map((option) => ({ ...option })),
          default: event.payload.default,
          evidence: event.payload.evidence.map((line) => ({
            class: line.class,
            summary: line.summary,
            by: "",
            ref: line.ref ?? "",
          })),
          precedents: [...event.payload.precedents],
          about: event.payload.about,
          state: "open",
          raisedAt: event.at,
          raisedT: t,
        });
        this.trunk.humansAsked += 1;
        break;
      }
      case "EscalationWithdrawn": {
        const escalation = this.escalations.get(event.payload.escalationId);
        if (escalation !== undefined) escalation.state = "withdrawn";
        break;
      }
      case "RulingGiven": {
        const escalation = this.escalations.get(event.payload.escalationId);
        if (escalation === undefined) break;
        escalation.state = "ruled";
        escalation.ruling = { option: event.payload.option, by: event.payload.by, at: event.at };
        const chosen = escalation.options.find((option) => option.id === event.payload.option);
        if (escalation.about.kind === "conflict") {
          this.#note(
            escalation.about.id,
            event,
            t,
            "Ruling given",
            chosen?.label ?? event.payload.option,
          );
        }
        break;
      }
      case "DecisionRecorded": {
        const label = event.label ?? `D·${short(event.payload.decisionId)}`;
        this.decisions.set(event.payload.decisionId, {
          id: event.payload.decisionId,
          label,
          question:
            this.escalations.get(event.payload.escalationId)?.question ??
            event.payload.x?.question ??
            "",
          chosen: event.payload.summary,
          scope: event.payload.scope ?? "",
          decidedAt: event.at,
          alternatives: event.payload.alternatives,
          state: "active",
        });
        if (event.payload.scope !== undefined)
          this.subjectByKey(event.payload.scope)?.decisionIds.push(event.payload.decisionId);
        const escalation = this.escalations.get(event.payload.escalationId);
        if (escalation?.about.kind === "conflict") {
          this.#note(
            escalation.about.id,
            event,
            t,
            `Decision ${label} recorded`,
            event.payload.summary,
          );
        }
        break;
      }
      case "DecisionSuperseded":
      case "DecisionOverruled": {
        const decision = this.decisions.get(event.payload.decisionId);
        if (decision !== undefined)
          decision.state = event.type === "DecisionSuperseded" ? "superseded" : "overruled";
        break;
      }
      case "PrecedentSurfaced":
      case "PrecedentFollowed":
      case "PrecedentDistinguished":
      case "OverruleRequested": {
        const change = this.changes.get(event.payload.changeId);
        const decision = this.decisions.get(event.payload.decisionId);
        if (change === undefined || decision === undefined) break;
        let entry = change.precedents.find((known) => known.decisionId === decision.id);
        if (entry === undefined) {
          entry = {
            decisionId: decision.id,
            summary: decision.chosen,
            decidedAt: decision.decidedAt,
            scope: decision.scope,
          };
          change.precedents.push(entry);
        }
        if (event.type === "PrecedentFollowed") entry.stance = "followed";
        else if (event.type === "PrecedentDistinguished") entry.stance = "distinguished";
        else if (event.type === "OverruleRequested") entry.stance = "overrule-requested";
        break;
      }
      case "TenetEstablished": {
        this.subjects.get(event.payload.subjectId)?.tenetIds.push(event.payload.tenetId);
        break;
      }
      case "BatchFormed": {
        this.batches.set(event.payload.batchId, {
          id: event.payload.batchId,
          label: event.payload.x?.label ?? short(event.payload.batchId),
          laneId: event.payload.laneId,
          members: event.payload.members,
          state: "forming",
          tier: 0,
        });
        break;
      }
      case "CandidateAssembled": {
        const batch = this.batches.get(event.payload.batchId);
        if (batch === undefined) break;
        batch.state = "assembled";
        batch.tier = event.payload.tier;
        break;
      }
      case "VerificationStarted":
      case "BatchVerified":
      case "BatchFailed":
      case "CandidateBisected":
      case "CandidateInvalidated":
      case "CandidatePromoted": {
        const batch = this.batches.get(event.payload.batchId);
        if (batch === undefined) break;
        // A batch's verdict is its members' too: it is what a landed change landed on.
        if (event.type === "BatchVerified")
          for (const member of batch.members) {
            const landing = this.changes.get(member);
            if (landing === undefined) continue;
            landing.verdictIds.push(event.payload.verdictId);
            landing.verdictRevision = landing.revision;
          }
        const next: Record<typeof event.type, CandidateState> = {
          VerificationStarted: "verifying",
          BatchVerified: "green",
          BatchFailed: "red",
          CandidateBisected: "bisected",
          CandidateInvalidated: "invalidated",
          CandidatePromoted: "promoted",
        };
        batch.state = next[event.type];
        break;
      }
      case "ProjectCreated": {
        this.project = { id: event.payload.projectId, name: event.payload.name };
        break;
      }
      case "TrunkAdvanced": {
        this.trunk.head = event.payload.to;
        // Keel's own count, from the Trunk DO. The console never counts arrivals: it may have started reading
        // mid-log. An advance that does not say its height leaves the count where Keel last put it.
        this.trunk.advances = event.payload.height ?? this.trunk.advances;
        for (const landing of event.payload.landings) {
          this.landed.set(landing.commitSha, {
            changeId: landing.changeId,
            height: this.trunk.advances,
            unverified: event.payload.verified === false,
          });
        }
        if (event.payload.verified === false) {
          this.trunk.unverifiedAdvances += 1;
          for (const landing of event.payload.landings) {
            const landed = this.changes.get(landing.changeId);
            if (landed !== undefined) landed.unverified = true;
          }
        }
        this.trunk.recent.unshift({
          height: this.trunk.advances,
          members: event.payload.landings.length,
          commuted: (event.payload.x?.commuted.length ?? 0) > 0,
          t,
          proofId: event.payload.landings[0]?.proofId ?? "",
          verifiedAt: event.payload.x?.commuted[0]?.verifiedAtHeight ?? this.trunk.advances,
        });
        if (this.trunk.recent.length > 12) this.trunk.recent.length = 12;
        break;
      }
      case "AuditCompleted": {
        if (event.payload.outcome === "red") this.trunk.redCount += 1;
        this.trunk.audits.unshift({ head: event.payload.head, outcome: event.payload.outcome, t });
        if (this.trunk.audits.length > 12) this.trunk.audits.length = 12;
        break;
      }
      default:
        // Events no view projects yet still count as seen.
        void p;
    }
  }
}
