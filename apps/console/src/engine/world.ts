// The console's picture of Keel, folded from the event log one event at a
// time. Nothing here is invented: every field comes from an event or an
// observation, and replaying the same log gives the same world.

import type { EntityRef } from "../contract/envelope.ts";
import type { AgentKind, AnyEvent, DriftEntry, NextAction } from "../contract/events.ts";
import type {
  ConflictEscalated,
  ConflictProven,
  MatrixCheck,
  MatrixProbeRun,
  Move,
  ProbeDiscard,
  PushRefusedReason,
  RunRef,
  SuspectEffect,
  SuspectPremise,
} from "../contract/keel/index.ts";
import type {
  Anchor,
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
  UnsealObservation,
} from "../contract/observations.ts";
import type { EscalationCategory, EscalationOption } from "../contract/events.ts";
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
import { citedIn } from "./decisions.ts";

/** A proposition as a claim, as Keel keys one: what it says, and not its gloss, its strength or its anchors. */
export const claimOf = (proposition: Proposition): string =>
  JSON.stringify([
    proposition.subject,
    proposition.predicate,
    proposition.relation,
    proposition.value,
    proposition.unit ?? null,
    proposition.scope ?? null,
  ]);

export interface AgentEntry {
  id: string;
  name: string;
  class: AgentClass;
  harness: string;
  model?: string;
  sessionId?: string;
  messages: number;
}

/**
 * One run of an agent, as the log names it on what the run committed: Keel's id for it, and the label the
 * agent gave it, which is the agent's own word and nobody else's.
 */
export interface RunEntry {
  id: string;
  label?: string;
  firstAt: string;
  lastAt: string;
  /** The entries of the log this run committed. */
  entries: number;
}

/**
 * What a project's log says of one agent's work in it. Keel names the agent on every entry its command
 * committed, and the run where its token named one. The log names it by its id alone: an agent's sign-up is in
 * no project's log, so its handle and its name are its card's to give. Who sponsors it is not kept.
 */
export interface WorkEntry {
  agentId: string;
  /** When it last wrote here. Absent where the log only names it as a change's holder. */
  lastAt?: string;
  runs: Map<string, RunEntry>;
  /** The entries it committed with a token that named no run. */
  unnamed: number;
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
  /** True once Keel has derived the effects of a commit of this change, whether or not it found any. */
  derived: boolean;
  drift: DriftEntry[];
  /** Keel says how many steps the plan has, and not what they are. */
  plan?: {
    hash: string;
    stepCount: number;
    costEstimate: number;
  };
  laneId?: string;
  batchId?: string;
  workspaceId?: string;
  commit?: string;
  /** The run that holds the change, where its holder's token named one. Whoever adopts the change replaces it. */
  run?: RunRef;
  declaredAt: string;
  declaredT: number;
  submittedAt?: string;
  submittedT?: number;
  landedT?: number;
  /** The commit on trunk the change landed as, as Keel's `ChangeLanded` names it. Not its own workspace's commit. */
  landedAs?: string;
  /**
   * Where the latest preview of the change's candidate answers, as Keel's `PreviewDeployed` tells the change:
   * the change's own stable address where Keel gives one, else the candidate's version; `down` once Keel has
   * taken that preview down.
   */
  preview?: { deploymentId: string; url: string; down: boolean };
  escalationId?: string;
  verdictIds: string[];
  /** The revision the change stood at when its latest verdict reached it. A verdict names no revision itself. */
  verdictRevision?: number;
  /** True once it has a verdict, or has landed in an advance, that was not verified. */
  unverified: boolean;
  conflictIds: string[];
  /**
   * Its latest bounce, and the one thing Keel named as its cause: a verdict, a conflict proven against it, its
   * batch's push being refused, or the decision of a ruling that went against it. `reasons` is why and `next`
   * the ways forward Keel gave its agent, both in Keel's words.
   */
  bounce?: {
    at: string;
    verdictId?: string;
    conflictId?: string;
    declined?: PushRefusedReason;
    decisionId?: string;
    reasons: string[];
    next: string[];
    /** The decision this bounce cites: the one Keel's next actions say to read, where they name one. */
    cites?: string;
  };
  /** Every bounce Keel recorded of it, each counted under the one cause Keel named for it. */
  bounces: BounceCounts;
  /**
   * How far Keel's own events have taken it, of the stages Insights counts, each set by the event that says
   * so. Neither is taken back: a bounce, a drift or a revision sends a change round again, and it is still
   * one that got that far.
   */
  reached: { precheck: boolean; verified: boolean };
  /**
   * Conflicts Keel proved against it and did not stop it for: its plan's policy for the predicate was not to
   * block. `next` is what Keel told its agent it could do, which it does only when the policy is to advise.
   */
  noted: {
    conflictId: string;
    predicate: Predicate;
    policy: "advise" | "annotate";
    at: string;
    next: string[];
  }[];
  /**
   * Its premises Keel put in doubt and has not since reaffirmed: by another change's edit to code a premise rests
   * on (`anchor`), or by another change's effect that may contradict it (`effect`). Keel names one of the two.
   */
  doubts: {
    subjectId: string;
    premise: Proposition;
    cause: { changeId: string; effect?: Proposition; anchor?: Anchor };
    at: string;
  }[];
  /**
   * The changes Keel has told this one have its intent, in the order Keel named them: at its latest preflight,
   * and by a notice since. Keel shows alternatives to each other and never ranks them, and nor does this list.
   * `landed` is Keel telling this change that one of them landed. `next` is the ways forward Keel gave this
   * change's agent about that one, in Keel's words.
   */
  alternatives: { changeId: string; landed?: { at: string }; next: string[] }[];
  /** Decisions surfaced to it, each dated, and the stance it went on to take. */
  precedents: {
    decisionId: string;
    summary: string;
    decidedAt: string;
    scope?: string;
    stance?: "followed" | "distinguished" | "overrule-requested";
  }[];
  /**
   * What the change's latest preflight read near its intent: how many live changes it read, and how many
   * subject keys they were under. Absent until a preflight that carried it; a preflight without it leaves
   * nothing here.
   */
  compared?: { changes: number; subjects: number };
}

/**
 * Bounces by the one cause Keel names for each: a verdict, a conflict proven against the change, its batch's
 * push refused, or a ruling that went against it.
 */
export interface BounceCounts {
  verdict: number;
  conflict: number;
  declined: number;
  ruling: number;
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
  /** The subject's key, as the suspicion itself names it, or as the subject it names was minted with. */
  subjectKey?: string;
  predicate?: Predicate;
  /** What a page calls it, in Keel's own fields: its subject and predicate, or its `C-n` where it names no subject. */
  title: string;
  /** `fallout`: two changes' claims contradict. `opinion`: a decision model suspects it. Absent means fallout. */
  origin?: "fallout" | "opinion";
  /**
   * The two sides, as Keel's suspicion names them: the premise at stake with the change that holds it, and the
   * effect against it with the change that makes it. Absent where Keel named neither; nothing is worked out.
   */
  premise?: SuspectPremise;
  effect?: SuspectEffect;
  silentRetraction: boolean;
  probeId?: string;
  guardId?: string;
  escalationId?: string;
  /** Why it was put to a person. */
  escalated?: ConflictEscalated["reason"];
  decisionId?: string;
  /** The changes its ruling went against, as its resolution names them: each bounces by that decision. */
  against?: string[];
  /** What proved it, as ConflictProven carries it. */
  proven?: ConflictProven["evidence"];
  /** Why it was dismissed, in Keel's words. */
  dismissed?: string;
  /** The move that resolved it. */
  move?: Move;
  costUsd?: number;
  openedAt: string;
  /** When it was resolved or dismissed, in simulated ms. */
  settledT?: number;
  /** The same instant, as Keel's event said it. */
  settledAt?: string;
  /** Every run of its probe Keel has recorded, in the order they arrived. */
  runs: ProbeRunEntry[];
  /** Every suite run Keel has recorded in one of its worlds, in the order they arrived. */
  checks: WorldCheckEntry[];
  timeline: TimelineEntry[];
}

/** One run of a conflict's probe in a world, as ProbeRan carries it. */
export interface ProbeRunEntry extends MatrixProbeRun {
  world: WorldId;
  /** Why it did not apply, where the source says. */
  reason?: string;
}

/** One run of a suite in a world of a conflict's matrix, as WorldCheckRan carries it. */
export interface WorldCheckEntry extends MatrixCheck {
  world: WorldId;
}

export interface ProbeEntry {
  id: string;
  label: string;
  conflictId: string;
  /** How many drafts it took, and the bundle its source is in. Absent on a probe none of whose drafts was kept. */
  attempts?: number;
  bundleHash?: string;
  state: "calibrating" | "admitted" | "discarded" | "retired";
  /** Why it was discarded, in ProbeDiscarded's words. */
  discarded?: ProbeDiscard;
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
  /** The id of the option the ruling chose, among its escalation's options. */
  option: string;
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
  /** The discriminating runs that admitted it. */
  runs: number;
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
  /** Keel's own word that it issued this with no plan run: the project's verification is off. */
  unverified: boolean;
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
  /**
   * The public repository trunk was imported from, as trunk's first entry names it: none for a trunk Keel
   * started, forked or made from a template, or one started before Keel kept where a trunk came from.
   */
  upstream?: { url: string; ref: string };
}

/** How an entry of the log names the agent whose command committed it: `agent:<AgentId>`. */
const BY_AGENT = "agent:";

/** `human` is the operator or a sponsor, never an agent, so it has no class. */
const CLASS_OF: Record<Exclude<AgentKind, "human">, AgentClass> = {
  interactive: "real",
  hosted: "hosted",
  synthetic: "synthetic",
};

/** The worlds of a conflict's matrix, in the order Keel shows them: trunk, the control, each side, both. */
export const MATRIX_WORLDS = [
  "trunk",
  "A-noop",
  "A",
  "B",
  "AB",
] as const satisfies readonly WorldId[];

/** A probe's outcomes in one world of its conflict's matrix, in run order. */
export function outcomesIn(conflict: ConflictEntry | undefined, world: WorldId): Outcome[] {
  return (conflict?.runs ?? [])
    .filter((run) => run.world === world)
    .toSorted((a, b) => a.run - b.run)
    .map((run) => run.outcome);
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
  /** Each agent the log names as having written here or as holding a change, by its id. */
  readonly work = new Map<string, WorkEntry>();
  /**
   * What Keel last told a change about a conflict, keyed `conflictId/changeId`: a bounce that cites it, or a note
   * of it. Kept beside the conflict, as Keel keeps it: the change's event and the conflict's come in no fixed order.
   */
  readonly told = new Map<
    string,
    { how: "bounced" | "noted"; nextActions: NextAction[]; at: string }
  >();
  /**
   * The ways forward Keel gave a change a ruling went against, keyed `decisionId/changeId`. Kept beside the
   * conflict as `told` is: the bounce names the decision and no conflict, and the two come in no fixed order.
   */
  readonly ruled = new Map<string, string[]>();
  /**
   * The changes Keel bounced citing each decision, by the decision's id, in the order each first was. A later
   * bounce for another cause replaces a change's latest bounce and not this: it was still bounced citing it.
   */
  readonly citing = new Map<string, string[]>();
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
  /**
   * The plans Keel compiled to verify a change, and its own estimates of what each would cost to run, added
   * up. An estimate is what Keel reckoned before it ran anything: it is never what was spent.
   */
  readonly planned = { plans: 0, usd: 0 };
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
    if (observation.kind === "metrics") {
      this.metrics = observation;
    } else if (observation.kind === "funnel") {
      this.funnel = observation;
    } else if (observation.kind === "seal") {
      this.seal = observation;
    } else if (observation.kind === "unseal") {
      this.unseal = observation;
    }
  }

  /** The agent's work in this project, made on the first word the log has of it. */
  #workOf(agentId: string): WorkEntry {
    let work = this.work.get(agentId);
    if (work === undefined) {
      work = { agentId, runs: new Map(), unnamed: 0 };
      this.work.set(agentId, work);
    }
    return work;
  }

  /**
   * Counts an entry to the agent whose command committed it, and to the run its token named. Keel names both
   * on the entry itself; an entry a person or the platform committed is nobody's work here.
   */
  #wrote(event: AnyEvent): void {
    if (event.actor?.startsWith(BY_AGENT) !== true) return;
    const work = this.#workOf(event.actor.slice(BY_AGENT.length));
    work.lastAt = event.at;
    if (event.run === undefined) {
      work.unnamed += 1;
      return;
    }
    const run = this.#runOf(work, event.run, event.at);
    run.lastAt = event.at;
    run.entries += 1;
  }

  /** A run as its agent's work has it, made on the first entry that names it. */
  #runOf(work: WorkEntry, named: RunRef, at: string): RunEntry {
    let run = work.runs.get(named.id);
    if (run === undefined) {
      run = {
        id: named.id,
        ...(named.label === undefined ? {} : { label: named.label }),
        firstAt: at,
        lastAt: at,
        entries: 0,
      };
      work.runs.set(named.id, run);
    }
    return run;
  }

  /** A change's holder, and the run it holds the change under, are an agent and a run of this project. */
  #holds(agentId: string, run: RunRef | undefined, at: string): void {
    const work = this.#workOf(agentId);
    if (run !== undefined) this.#runOf(work, run, at);
  }

  apply(event: AnyEvent, t: number): void {
    this.version += 1;
    this.#wrote(event);
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
          derived: false,
          drift: [],
          declaredAt: event.at,
          declaredT: t,
          verdictIds: [],
          unverified: false,
          conflictIds: [],
          bounces: { verdict: 0, conflict: 0, declined: 0, ruling: 0 },
          reached: { precheck: false, verified: false },
          noted: [],
          doubts: [],
          alternatives: [],
          precedents: [],
          ...(event.payload.run === undefined ? {} : { run: event.payload.run }),
        });
        this.#holds(event.payload.agentId, event.payload.run, event.at);
        break;
      }
      case "PreflightIssued": {
        const change = this.#change(event.payload.changeId);
        if (change === undefined) break;
        // A preflight is Keel's whole word, at that revision, on who has this intent: it replaces the last one's
        // list, and keeps what Keel has since said of a change that is still on it.
        const told = change.alternatives;
        change.alternatives = (event.payload.alternatives ?? []).map(
          (changeId) => told.find((known) => known.changeId === changeId) ?? { changeId, next: [] },
        );
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
        // What the preflight compared: how many live changes it read near the intent, and how many subject
        // keys they were under. A preflight without it leaves nothing here.
        if (event.payload.compared === undefined) delete change.compared;
        else
          change.compared = {
            changes: event.payload.compared.changes,
            subjects: event.payload.compared.subjects,
          };
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
        const { origin } = event.payload;
        if (origin?.kind === "imported") this.trunk.upstream = { url: origin.url, ref: origin.ref };
        break;
      }
      case "TrunkSynced": {
        // Trunk's head is upstream's own commit now: an advance that landed no change, at Keel's height where
        // it says one.
        this.trunk.head = event.payload.to;
        if (event.payload.height !== undefined) this.trunk.advances = event.payload.height;
        this.landed.set(event.payload.to, { height: this.trunk.advances, unverified: false });
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
        change.reached.precheck = true;
        // Drift belongs to one revision's check. The next revision's starts clean.
        change.drift = [];
        break;
      }
      case "EffectsDerived": {
        const change = this.#change(event.payload.changeId);
        if (change !== undefined) change.effects = event.payload.effects;
        if (change !== undefined) change.derived = true;
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
          change.plan = {
            hash: event.payload.planHash,
            stepCount: event.payload.steps,
            costEstimate: event.payload.costEstimate,
          };
          this.planned.plans += 1;
          this.planned.usd += event.payload.costEstimate;
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
        change.landedAs = event.payload.commitSha;
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
          const { verdictId, conflictId, declined, decisionId, nextActions } = event.payload;
          change.bounce = {
            at: event.at,
            ...(verdictId === undefined ? {} : { verdictId }),
            ...(conflictId === undefined ? {} : { conflictId }),
            ...(declined === undefined ? {} : { declined: declined.reason }),
            ...(decisionId === undefined ? {} : { decisionId }),
            reasons: [...event.payload.reasons],
            next: (nextActions ?? []).map((action) => action.title),
          };
          if (conflictId !== undefined)
            this.told.set(`${conflictId}/${change.id}`, {
              how: "bounced",
              nextActions: nextActions ?? [],
              at: event.at,
            });
          // A bounce on a conflict ties the change to it, whether or not the change was one of its two sides.
          if (conflictId !== undefined && !change.conflictIds.includes(conflictId))
            change.conflictIds.push(conflictId);
          // Keel names exactly one cause for a bounce.
          if (declined !== undefined) change.bounces.declined += 1;
          else if (conflictId !== undefined) change.bounces.conflict += 1;
          else if (verdictId !== undefined) change.bounces.verdict += 1;
          else if (decisionId !== undefined) change.bounces.ruling += 1;
          if (decisionId !== undefined)
            this.ruled.set(
              `${decisionId}/${change.id}`,
              (nextActions ?? []).map((action) => action.title),
            );
          this.#note(
            this.#conflictOf(change.id),
            event,
            t,
            `${change.label} bounces`,
            event.payload.nextActions?.[0]?.title,
          );
          // A bounce by a guard that holds a decision is a verdict's, and names the decision among its ways on.
          const cited = citedIn(nextActions ?? []);
          if (cited !== undefined) change.bounce.cites = cited;
          // The verdict a bounce names is the change's own to show, though it judged the batch the change was in:
          // Keel runs a plan on a batch's candidate, and a failed batch's verdict names no change itself.
          if (verdictId !== undefined && !change.verdictIds.includes(verdictId)) {
            change.verdictIds.push(verdictId);
            change.verdictRevision = change.revision;
          }
          // A change is counted once for a decision, however many of its bounces cited it.
          const citing = cited === undefined ? undefined : (this.citing.get(cited) ?? []);
          if (cited !== undefined && citing !== undefined && !citing.includes(change.id))
            this.citing.set(cited, [...citing, change.id]);
        }
        break;
      }
      case "AlternativeDeclared":
      case "AlternativeLanded": {
        // A notice to one change's agent, committed on the project. It is folded onto the change it was sent
        // to and never onto the other: Keel tells each side itself.
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        const other =
          event.type === "AlternativeDeclared"
            ? event.payload.alternativeId
            : event.payload.landedChangeId;
        let entry = change.alternatives.find((known) => known.changeId === other);
        if (entry === undefined) {
          entry = { changeId: other, next: [] };
          change.alternatives.push(entry);
        }
        entry.next = event.payload.nextActions.map((action) => action.title);
        if (event.type === "AlternativeLanded") entry.landed = { at: event.at };
        break;
      }
      case "ConflictNoted": {
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        const { conflictId, predicate, policy, nextActions } = event.payload;
        change.noted.push({
          conflictId,
          predicate,
          policy,
          at: event.at,
          next: (nextActions ?? []).map((action) => action.title),
        });
        this.told.set(`${conflictId}/${change.id}`, {
          how: "noted",
          nextActions: nextActions ?? [],
          at: event.at,
        });
        this.#note(conflictId, event, t, `Noted against ${change.label}`, `policy: ${policy}`);
        break;
      }
      case "PremiseSuspected": {
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        const { subjectId, premise, cause } = event.payload;
        change.doubts.push({
          subjectId,
          premise,
          cause: {
            changeId: cause.changeId,
            ...(cause.effect === undefined ? {} : { effect: cause.effect }),
            ...(cause.anchor === undefined ? {} : { anchor: cause.anchor }),
          },
          at: event.at,
        });
        break;
      }
      case "PremiseReaffirmed": {
        // Keel reaffirms a premise as a claim: its subject, predicate, relation, value, unit and scope.
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        const claim = claimOf(event.payload.premise);
        change.doubts = change.doubts.filter((doubt) => claimOf(doubt.premise) !== claim);
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
        // Whoever adopts a change holds it from then on: under the run its token named, or under none.
        if (change !== undefined) {
          if (event.payload.run === undefined) delete change.run;
          else change.run = event.payload.run;
        }
        this.#holds(event.payload.agentId, event.payload.run, event.at);
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
        const label = event.label ?? `C·${short(event.payload.conflictId)}`;
        // An event older than the field names its subject by id alone; the key is then the minted subject's.
        const subjectKey =
          event.payload.subjectKey ?? this.subjects.get(event.payload.subjectId ?? "")?.key;
        this.conflicts.set(event.payload.conflictId, {
          id: event.payload.conflictId,
          label,
          kind: event.payload.kind,
          state: "suspected",
          parties,
          ...(event.payload.subjectId === undefined ? {} : { subjectId: event.payload.subjectId }),
          ...(subjectKey === undefined ? {} : { subjectKey }),
          ...(event.payload.predicate === undefined ? {} : { predicate: event.payload.predicate }),
          title:
            subjectKey === undefined
              ? `Conflict ${label}`
              : event.payload.predicate === undefined
                ? subjectKey
                : `${subjectKey} · ${event.payload.predicate}`,
          ...(event.payload.origin === undefined ? {} : { origin: event.payload.origin }),
          // The two sides are Keel's to name. Where its suspicion names none, the console holds none.
          ...(event.payload.premise === undefined ? {} : { premise: event.payload.premise }),
          ...(event.payload.effect === undefined ? {} : { effect: event.payload.effect }),
          silentRetraction: event.payload.x?.silentRetraction ?? false,
          openedAt: event.at,
          runs: [],
          checks: [],
          timeline: [],
        });
        for (const party of parties)
          this.changes.get(party)?.conflictIds.push(event.payload.conflictId);
        // The story of a conflict starts before it opens: with the submission whose effect Keel set against a
        // premise. Which change that is, and what its effect is, are the suspicion's own words.
        const { effect } = event.payload;
        const cause = effect === undefined ? undefined : this.changes.get(effect.changeId);
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (cause !== undefined && effect !== undefined && conflict !== undefined) {
          if (cause.submittedAt !== undefined)
            conflict.timeline.push({
              t: cause.submittedT ?? t,
              at: cause.submittedAt,
              type: "ChangeSubmitted",
              title: `${cause.label} submits`,
              ...(cause.commit === undefined ? {} : { detail: `commit ${cause.commit}` }),
            });
          const held = `${effect.proposition.predicate} ${effect.proposition.relation} ${String(effect.proposition.value)}`;
          conflict.timeline.push({
            t,
            at: event.at,
            type: "ConflictSuspected",
            title:
              effect.evidence === undefined
                ? `${cause.label}'s effect: ${held}`
                : effect.evidence.declared
                  ? `${cause.label} declares: ${held}`
                  : `Keel derives: ${held}`,
            ...(effect.evidence === undefined || effect.evidence.declared
              ? {}
              : { detail: `${cause.label} did not declare it` }),
          });
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
          state: "calibrating",
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
          `Draft ${event.payload.attempts}`,
        );
        break;
      }
      case "ProbeRan": {
        const probe = this.probes.get(event.payload.probeId);
        const ran = this.conflicts.get(event.payload.conflictId);
        if (probe === undefined || ran === undefined) break;
        const world = event.payload.world;
        ran.runs.push({
          world,
          run: event.payload.run,
          outcome: event.payload.outcome,
          resultRef: event.payload.resultRef,
          at: event.at,
          ...(event.payload.x?.reason === undefined ? {} : { reason: event.payload.x.reason }),
        });
        const usd = event.payload.x?.cost?.usd;
        if (usd !== undefined) probe.costUsd = (probe.costUsd ?? 0) + usd;
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
        const { counts, reason } = event.payload;
        this.conflicts.get(event.payload.conflictId)?.checks.push({
          world: event.payload.world,
          check: event.payload.check,
          run: event.payload.run,
          outcome: event.payload.outcome,
          ...(counts === undefined ? {} : { counts }),
          ...(reason === undefined ? {} : { reason }),
          at: event.at,
        });
        break;
      }
      case "ProbeDiscarded": {
        // A probe none of whose drafts was kept is discarded without ever having been drafted: Keel names its
        // conflict on the event, and it is a probe of that conflict all the same.
        const conflictId =
          this.probes.get(event.payload.probeId)?.conflictId ?? event.payload.conflictId;
        if (conflictId === undefined) break;
        const probe: ProbeEntry = this.probes.get(event.payload.probeId) ?? {
          id: event.payload.probeId,
          label: event.label ?? `P·${short(event.payload.probeId)}`,
          conflictId,
          state: "discarded",
        };
        this.probes.set(probe.id, probe);
        probe.state = "discarded";
        probe.discarded = {
          reason: event.payload.reason,
          ...(event.payload.detail === undefined ? {} : { detail: event.payload.detail }),
        };
        const of = this.conflicts.get(conflictId);
        if (of !== undefined && of.probeId === undefined) of.probeId = probe.id;
        this.#note(
          conflictId,
          event,
          t,
          `Probe ${probe.label} discarded`,
          event.payload.detail === undefined
            ? event.payload.reason
            : `${event.payload.reason}: ${event.payload.detail}`,
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
          runs: event.payload.runs,
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
          `${probe?.label ?? "The probe"} discriminates, in ${event.payload.runs} ${event.payload.runs === 1 ? "run" : "runs"}`,
        );
        break;
      }
      case "GuardRetired": {
        const guard = this.guards.get(event.payload.guardId);
        if (guard === undefined) break;
        guard.state = "retired";
        const retired = this.probes.get(guard.probeId);
        if (retired !== undefined) retired.state = "retired";
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
        conflict.proven = event.payload.evidence;
        if (event.payload.x?.cost?.usd !== undefined) conflict.costUsd = event.payload.x.cost.usd;
        this.#note(conflict.id, event, t, `Conflict ${conflict.label} is proven`);
        break;
      }
      case "ConflictDismissed": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "dismissed";
        conflict.settledT = t;
        conflict.settledAt = event.at;
        conflict.dismissed = event.payload.evidence;
        if (event.payload.x?.cost?.usd !== undefined) conflict.costUsd = event.payload.x.cost.usd;
        this.#note(
          conflict.id,
          event,
          t,
          `Conflict ${conflict.label} dismissed`,
          event.payload.evidence,
        );
        break;
      }
      case "ConflictEscalated": {
        const conflict = this.conflicts.get(event.payload.conflictId);
        if (conflict === undefined) break;
        conflict.state = "escalated";
        conflict.escalationId = event.payload.escalationId;
        conflict.escalated = event.payload.reason;
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
        conflict.settledAt = event.at;
        conflict.move = event.payload.move;
        if (event.payload.decisionId !== undefined) conflict.decisionId = event.payload.decisionId;
        if (event.payload.against !== undefined) conflict.against = [...event.payload.against];
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
          unverified: event.payload.verified === false,
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
          option: event.payload.option,
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
            // Where the project's verification is off Keel passes the batch and says the plan was not run.
            if (event.payload.verified !== false) landing.reached.verified = true;
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
      case "PreviewDeployed": {
        const change = this.#change(event.payload.changeId);
        if (change === undefined) break;
        change.preview = {
          deploymentId: event.payload.deploymentId,
          url: event.payload.aliasUrl ?? event.payload.url,
          down: false,
        };
        break;
      }
      case "PreviewTornDown": {
        for (const change of this.changes.values())
          if (change.preview?.deploymentId === event.payload.deploymentId)
            change.preview.down = true;
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
