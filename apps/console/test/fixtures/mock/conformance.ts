// Checks a log against the catalogue and the state machines
// (docs/domain/state-machines.md in the Keel repository, and the machines
// themselves in packages/core/src/domain): known event names, the entity
// each event belongs to, gap-free `seq`, causation that points backwards,
// only legal transitions, and a probe admitted or discarded exactly when
// its world matrix says so. The mock is held to this so the console is
// never built against a story Keel could not tell.

import { EVENT_TYPES, type EntityKind, type EventType } from "../../../src/contract/envelope.ts";
import type {
  AnyEvent,
  ConflictKind,
  ConflictProof,
  ProbeOutcome,
  ProbeWorld,
} from "../../../src/contract/events.ts";
import type { ScriptedEvent } from "./scripted.ts";

interface Rule {
  kind: EntityKind;
  /** The payload field holding the entity's id. */
  idField: string;
  /** States the entity may be in. `null` means it must not exist yet. Omitted: it need only exist. */
  from?: readonly string[] | null;
  /** The state it moves to. Omitted: the event is a fact and changes nothing. */
  to?: string;
  /** The rule is skipped when the payload has no such field. */
  optional?: boolean;
  /** The field holds a guard's id. A guard is no entity of its own: it names the probe admitted under it. */
  guard?: boolean;
}

const AGENT_OWNED = ["declared", "working", "drifted", "bounced"] as const;
const WITHDRAWABLE = [
  "declared",
  "working",
  "submitted",
  "deriving",
  "drifted",
  "verifying",
  "queued",
  "bounced",
  "parked",
] as const;

const change = (from: readonly string[] | null | undefined, to?: string): Rule => ({
  kind: "change",
  idField: "changeId",
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

/** The first rule whose field the payload has names the entity the envelope must carry. */
const RULES: Record<EventType, Rule[]> = {
  AgentEnrolled: [{ kind: "agent", idField: "agentId", from: null, to: "active" }],
  AgentSuspended: [{ kind: "agent", idField: "agentId", from: ["active"], to: "suspended" }],
  AgentReinstated: [{ kind: "agent", idField: "agentId", from: ["suspended"], to: "active" }],
  AgentRevoked: [
    { kind: "agent", idField: "agentId", from: ["active", "suspended"], to: "revoked" },
  ],
  UserSignedUp: [{ kind: "user", idField: "userId", from: null, to: "active" }],
  UserSuspended: [{ kind: "user", idField: "userId", from: ["active"], to: "suspended" }],
  UserReinstated: [{ kind: "user", idField: "userId", from: ["suspended"], to: "active" }],
  OrgCreated: [{ kind: "org", idField: "orgId", from: null, to: "active" }],
  MembershipChanged: [{ kind: "org", idField: "orgId", from: ["active"] }],
  OrgSuspended: [{ kind: "org", idField: "orgId", from: ["active"], to: "suspended" }],
  OrgReinstated: [{ kind: "org", idField: "orgId", from: ["suspended"], to: "active" }],
  OrgDeleted: [{ kind: "org", idField: "orgId", from: ["active", "suspended"], to: "deleted" }],

  IntentDeclared: [change(null, "declared")],
  ChangeStarted: [change(["declared"], "working")],
  PreflightIssued: [change(undefined)],
  IntentRevised: [change(["working", "drifted", "bounced"], "working")],
  PremiseRelied: [
    { kind: "subject", idField: "subjectId" },
    { kind: "change", idField: "changeId", from: ["declared", "working"] },
  ],
  ChangeSubmitted: [change(["working", "bounced"], "submitted")],
  ChangeRebased: [change(["working", "bounced"])],
  PrecheckStarted: [change(["submitted"], "deriving")],
  EffectsDerived: [change(["deriving"])],
  DriftDetected: [change(["deriving"])],
  ChangeDrifted: [change(["deriving"], "drifted")],
  PlanCompiled: [change(["deriving"], "verifying")],
  ChangeQueued: [change(["verifying"], "queued")],
  ChangeBatched: [change(["queued"], "integrating")],
  ChangeRequeued: [change(["integrating"], "queued")],
  ChangeLanded: [change(["integrating"], "landed")],
  ChangeBounced: [change(["deriving", "verifying", "integrating", "parked"], "bounced")],
  ConflictNoted: [change([...WITHDRAWABLE, "integrating"])],
  ChangeParked: [change(["verifying", ...AGENT_OWNED], "parked")],
  ChangeResumed: [change(["parked"], "verifying")],
  ChangeAdopted: [change(["parked"], "working")],
  ChangeWithdrawn: [change(WITHDRAWABLE, "withdrawn")],
  ChangeSuperseded: [change(WITHDRAWABLE, "superseded")],
  LeaseLapsed: [change(undefined)],

  SubjectMinted: [{ kind: "subject", idField: "subjectId", from: null, to: "minted" }],
  PremiseSuspected: [{ kind: "subject", idField: "subjectId" }],
  PremiseReaffirmed: [{ kind: "subject", idField: "subjectId" }],

  SketchOpened: [{ kind: "sketch", idField: "sketchId", from: null, to: "open" }],
  // The change it becomes starts with its own ChangeStarted.
  SketchPromoted: [{ kind: "sketch", idField: "sketchId", from: ["open"], to: "promoted" }],
  SketchExpired: [{ kind: "sketch", idField: "sketchId", from: ["open"], to: "expired" }],
  SketchDiscarded: [{ kind: "sketch", idField: "sketchId", from: ["open"], to: "discarded" }],
  WorkspaceForked: [{ kind: "workspace", idField: "workspaceId", from: null, to: "ready" }],
  WorkspaceGranted: [{ kind: "workspace", idField: "workspaceId", from: ["ready"], to: "granted" }],
  WorkspaceReassigned: [{ kind: "workspace", idField: "workspaceId", from: ["granted"] }],
  WorkspacePushed: [{ kind: "workspace", idField: "workspaceId", from: ["granted"] }],
  WorkspaceCollected: [
    { kind: "workspace", idField: "workspaceId", from: ["ready", "granted"], to: "collected" },
  ],

  ConflictSuspected: [{ kind: "conflict", idField: "conflictId", from: null, to: "suspected" }],
  ProbeDrafted: [
    { kind: "probe", idField: "probeId", from: null, to: "calibrating" },
    { kind: "conflict", idField: "conflictId", from: ["suspected"], to: "probing" },
  ],
  ProbeRan: [
    { kind: "probe", idField: "probeId", from: ["calibrating"] },
    { kind: "conflict", idField: "conflictId", from: ["probing"] },
  ],
  // A fact of the conflict whose matrix it fills, while that conflict is Probing.
  WorldCheckRan: [{ kind: "conflict", idField: "conflictId", from: ["probing"] }],
  // With `draft-failed` it is the probe's first and only event: see `rulesFor`.
  ProbeDiscarded: [
    { kind: "probe", idField: "probeId", from: ["calibrating"], to: "discarded" },
    { kind: "conflict", idField: "conflictId", from: ["probing"] },
  ],
  // By a probe: of a conflict that is Probing. By anything else: of one still Suspected. See `rulesFor`.
  ConflictProven: [{ kind: "conflict", idField: "conflictId", from: ["probing"], to: "proven" }],
  ConflictDismissed: [
    { kind: "conflict", idField: "conflictId", from: ["suspected", "probing"], to: "dismissed" },
  ],
  // Unprovable: from Suspected or Probing. Human-class: only once Proven. See `rulesFor`.
  ConflictEscalated: [
    { kind: "conflict", idField: "conflictId", from: ["proven"], to: "escalated" },
  ],
  // From Proven, or from Escalated once a decision is named. See `rulesFor`.
  ConflictResolved: [{ kind: "conflict", idField: "conflictId", from: ["proven"], to: "resolved" }],
  // The probe's own Calibrating → Admitted. From here the admitted probe is the guard, named by `guardId`.
  GuardAdmitted: [
    { kind: "probe", idField: "probeId", from: ["calibrating"], to: "admitted" },
    { kind: "conflict", idField: "conflictId", from: ["probing"] },
  ],
  GuardRetired: [
    { kind: "probe", idField: "guardId", guard: true, from: ["admitted"], to: "retired" },
  ],
  // A fact of the change whose plan it failed in, or of the batch whose candidate it failed in.
  GuardFailed: [
    { kind: "change", idField: "changeId", optional: true },
    { kind: "batch", idField: "batchId", optional: true },
    { kind: "probe", idField: "guardId", guard: true, from: ["admitted"] },
  ],
  VerdictIssued: [{ kind: "verdict", idField: "verdictId", from: null, to: "issued" }],
  EscalationRaised: [{ kind: "escalation", idField: "escalationId", from: null, to: "open" }],
  EscalationWithdrawn: [
    { kind: "escalation", idField: "escalationId", from: ["open"], to: "withdrawn" },
  ],

  BatchFormed: [{ kind: "batch", idField: "batchId", from: null, to: "forming" }],
  CandidateAssembled: [
    { kind: "candidate", idField: "candidateId", from: null, to: "assembled" },
    { kind: "batch", idField: "batchId", from: ["forming"], to: "assembled" },
  ],
  VerificationStarted: [
    { kind: "candidate", idField: "candidateId", from: ["assembled"], to: "verifying" },
    { kind: "batch", idField: "batchId", from: ["assembled"], to: "verifying" },
  ],
  BatchVerified: [{ kind: "batch", idField: "batchId", from: ["verifying"], to: "green" }],
  BatchFailed: [{ kind: "batch", idField: "batchId", from: ["forming", "verifying"], to: "red" }],
  CandidateBisected: [
    { kind: "candidate", idField: "candidateId" },
    { kind: "batch", idField: "batchId", from: ["red"], to: "bisected" },
  ],
  CandidateInvalidated: [
    { kind: "candidate", idField: "candidateId" },
    { kind: "batch", idField: "batchId", from: ["green"], to: "invalidated" },
  ],
  CandidatePromoted: [
    { kind: "candidate", idField: "candidateId", from: ["verifying"], to: "promoted" },
    { kind: "batch", idField: "batchId", from: ["green"], to: "promoted" },
  ],
  ProjectCreated: [{ kind: "project", idField: "projectId", from: null, to: "created" }],
  ProjectDeleted: [{ kind: "project", idField: "projectId", from: ["created"], to: "deleted" }],
  ProjectSettingsChanged: [{ kind: "project", idField: "projectId", from: ["created"] }],
  // The Trunk DO's promotion machine. Debouncing has no event of its own, so it reads as idle here.
  TrunkInitialized: [{ kind: "trunk", idField: "projectId", from: null, to: "idle" }],
  PromotionStarted: [{ kind: "trunk", idField: "projectId", from: ["idle"], to: "promoting" }],
  PromotionComposed: [{ kind: "trunk", idField: "projectId", from: ["promoting"] }],
  TrunkAdvanced: [{ kind: "trunk", idField: "projectId", from: ["promoting"], to: "idle" }],
  PromotionDeclined: [{ kind: "trunk", idField: "projectId", from: ["idle", "frozen"] }],
  PromotionFrozen: [
    { kind: "trunk", idField: "projectId", from: ["idle", "promoting"], to: "frozen" },
  ],
  PromotionResumed: [{ kind: "trunk", idField: "projectId", from: ["frozen"], to: "idle" }],
  AuditCompleted: [{ kind: "trunk", idField: "projectId", from: ["idle", "promoting", "frozen"] }],

  RulingGiven: [{ kind: "escalation", idField: "escalationId", from: ["open"], to: "ruled" }],
  DecisionRecorded: [{ kind: "decision", idField: "decisionId", from: null, to: "active" }],
  DecisionSuperseded: [
    { kind: "decision", idField: "decisionId", from: ["active"], to: "superseded" },
  ],
  DecisionOverruled: [
    { kind: "decision", idField: "decisionId", from: ["active"], to: "overruled" },
  ],
  PrecedentSurfaced: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  PrecedentFollowed: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  PrecedentDistinguished: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  OverruleRequested: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  TenetEstablished: [{ kind: "tenet", idField: "tenetId", from: null, to: "established" }],
  TenetContested: [{ kind: "tenet", idField: "tenetId", from: ["established"], to: "contested" }],
  TenetReaffirmed: [{ kind: "tenet", idField: "tenetId", from: ["contested"], to: "established" }],
  TenetRetracted: [{ kind: "tenet", idField: "tenetId", from: ["contested"], to: "retracted" }],
  TenetSuperseded: [{ kind: "tenet", idField: "tenetId", from: ["established"], to: "superseded" }],
  SessionOpened: [{ kind: "session", idField: "sessionId", from: null, to: "open" }],
  MessagesCaptured: [{ kind: "session", idField: "sessionId", from: ["open"] }],
  SessionRedacted: [{ kind: "session", idField: "sessionId", from: ["open"] }],

  PreviewDeployed: [{ kind: "deployment", idField: "deploymentId", from: null, to: "live" }],
  PreviewTornDown: [
    { kind: "deployment", idField: "deploymentId", from: ["live"], to: "torn-down" },
  ],
  DeploymentPromoted: [{ kind: "deployment", idField: "deploymentId" }],
  DeploymentRolledBack: [{ kind: "deployment", idField: "deploymentId" }],
};

/** The proof that settles each kind of conflict with no probe. */
const PROVES: Record<Exclude<ConflictProof["_tag"], "probe">, ConflictKind> = {
  "merge-refused": "textual",
  guard: "precedent",
  interaction: "interaction",
};

const conflict = (from: readonly string[], to: string): Rule[] => [
  { kind: "conflict", idField: "conflictId", from, to },
];

/** The rules for one event. A few transitions turn on the payload, as the machines do. */
function rulesFor(event: AnyEvent): Rule[] {
  switch (event.type) {
    case "ProbeDiscarded":
      // Three drafts failed: the probe begins and ends here, and its conflict was never Probing.
      return event.payload.reason === "draft-failed"
        ? [
            { kind: "probe", idField: "probeId", from: null, to: "discarded" },
            { kind: "conflict", idField: "conflictId", from: ["suspected"] },
          ]
        : RULES.ProbeDiscarded;
    case "ConflictProven":
      return event.payload.evidence._tag === "probe"
        ? RULES.ConflictProven
        : conflict(["suspected"], "proven");
    case "ConflictEscalated":
      return event.payload.reason === "unprovable"
        ? conflict(["suspected", "probing"], "escalated")
        : RULES.ConflictEscalated;
    case "ConflictResolved":
      return event.payload.decisionId === undefined
        ? RULES.ConflictResolved
        : conflict(["proven", "escalated"], "resolved");
    default:
      return RULES[event.type];
  }
}

interface Cell {
  world: ProbeWorld;
  run: number;
  outcome: ProbeOutcome;
}

/** How many complete runs must all discriminate before a probe is admitted. */
const ADMISSION_RUNS = 3;

/**
 * Keel's admission rule, from the cells of the world matrix. A run is complete once the probe has answered
 * on trunk, in A, in A+B and in A-noop; it discriminates when it passes on trunk (or does not apply), passes
 * in A, fails in A+B and fails in A-noop. B is recorded and does not decide. A probe is admitted when at
 * least three complete runs all discriminate, discarded as soon as one complete run does not, and pending
 * otherwise.
 */
export function admission(
  cells: readonly Cell[],
): "admitted" | "pending" | "non-discriminating" | "unstable" {
  const runs = new Map<number, Partial<Record<ProbeWorld, ProbeOutcome>>>();
  for (const cell of cells)
    runs.set(cell.run, { ...runs.get(cell.run), [cell.world]: cell.outcome });
  const done = [...runs.values()].filter(
    (run) =>
      run.trunk !== undefined &&
      run.A !== undefined &&
      run.AB !== undefined &&
      run["A-noop"] !== undefined,
  );
  const good = done.filter(
    (run) =>
      run.trunk !== "fail" && run.A === "pass" && run.AB === "fail" && run["A-noop"] === "fail",
  ).length;
  if (good < done.length) return good === 0 ? "non-discriminating" : "unstable";
  return done.length >= ADMISSION_RUNS ? "admitted" : "pending";
}

const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Entities with no creating event in the catalogue yet; they are known from the first event that names one. */
const IMPLICIT: ReadonlySet<EntityKind> = new Set<EntityKind>(["deployment"]);

function field(payload: object, name: string): string | undefined {
  const value: unknown = Object.entries(payload).find(([key]) => key === name)?.[1];
  return typeof value === "string" ? value : undefined;
}

/** Every way `events` breaks the contract, in log order. An empty list means it conforms. */
export function checkLog(events: readonly ScriptedEvent[]): string[] {
  const problems: string[] = [];
  const states = new Map<string, string>();
  const seqs = new Map<string, number>();
  const seen = new Set<string>();
  /** Each guard's probe, from its admission on. */
  const guards = new Map<string, string>();
  const cells = new Map<string, Cell[]>();
  const kinds = new Map<string, ConflictKind>();
  /** The entity a rule is about: its field's value, or for a guard the probe admitted under that name. */
  const subjectOf = (rule: Rule, payload: object): string | undefined => {
    const named = field(payload, rule.idField);
    return rule.guard === true && named !== undefined
      ? (guards.get(named) ?? `never admitted as ${named}`)
      : named;
  };

  events.forEach((event, index) => {
    const where = `#${index} ${event.type}`;
    if (!KNOWN.has(event.type)) {
      problems.push(`${where}: not a catalogue event`);
      return;
    }
    const rules = rulesFor(event);
    const owner = rules.find((rule) => subjectOf(rule, event.payload) !== undefined) ?? rules[0];
    if (owner !== undefined) {
      const ownerId = subjectOf(owner, event.payload);
      if (event.entity.kind !== owner.kind || event.entity.id !== ownerId) {
        problems.push(
          `${where}: entity is ${event.entity.kind}:${event.entity.id}, expected ${owner.kind}:${ownerId ?? "?"}`,
        );
      }
    }

    // What the machines check beyond a from-state.
    switch (event.type) {
      case "ConflictSuspected":
        kinds.set(event.payload.conflictId, event.payload.kind);
        break;
      case "ProbeRan": {
        const known = cells.get(event.payload.probeId) ?? [];
        const decided = admission(known);
        if (decided !== "pending")
          problems.push(
            `${where}: the matrix was already decided (${decided}), so no further cell is recorded`,
          );
        if (
          known.some((cell) => cell.world === event.payload.world && cell.run === event.payload.run)
        ) {
          problems.push(
            `${where}: ${event.payload.world} run ${event.payload.run} was already recorded`,
          );
        }
        cells.set(event.payload.probeId, [
          ...known,
          { world: event.payload.world, run: event.payload.run, outcome: event.payload.outcome },
        ]);
        break;
      }
      case "GuardAdmitted": {
        const decided = admission(cells.get(event.payload.probeId) ?? []);
        if (decided !== "admitted")
          problems.push(`${where}: the matrix does not admit this probe (${decided})`);
        guards.set(event.payload.guardId, event.payload.probeId);
        break;
      }
      case "ProbeDiscarded": {
        if (event.payload.reason === "draft-failed") break;
        const decided = admission(cells.get(event.payload.probeId) ?? []);
        if (decided !== event.payload.reason)
          problems.push(
            `${where}: discarded as ${event.payload.reason}, and the matrix says ${decided}`,
          );
        break;
      }
      case "ConflictProven": {
        const proof = event.payload.evidence;
        if (proof._tag === "probe") {
          if (states.get(`probe:${proof.probeId}`) !== "admitted")
            problems.push(`${where}: its probe was not admitted`);
        } else if (PROVES[proof._tag] !== kinds.get(event.payload.conflictId)) {
          problems.push(
            `${where}: ${proof._tag} does not prove a ${kinds.get(event.payload.conflictId) ?? "?"} conflict`,
          );
        }
        break;
      }
      case "GuardFailed":
        if ((event.payload.changeId === undefined) === (event.payload.batchId === undefined)) {
          problems.push(`${where}: it is a fact of a change or of a batch, one and not both`);
        }
        break;
      default:
        break;
    }

    const entityKey = `${event.entity.kind}:${event.entity.id}`;
    const expectedSeq = (seqs.get(entityKey) ?? 0) + 1;
    if (event.seq !== expectedSeq)
      problems.push(`${where}: seq ${event.seq} on ${entityKey}, expected ${expectedSeq}`);
    seqs.set(entityKey, event.seq);

    if (event.causation !== undefined && !seen.has(event.causation)) {
      problems.push(`${where}: causation ${event.causation} is not an earlier event`);
    }
    seen.add(event.eventId);

    for (const rule of rules) {
      const id = subjectOf(rule, event.payload);
      if (id === undefined) {
        if (rule.optional !== true) problems.push(`${where}: payload has no ${rule.idField}`);
        continue;
      }
      const key = `${rule.kind}:${id}`;
      const current = states.get(key);
      if (rule.from === null) {
        if (current !== undefined) problems.push(`${where}: ${key} already exists (${current})`);
      } else if (current === undefined) {
        if (IMPLICIT.has(rule.kind)) states.set(key, "known");
        else problems.push(`${where}: ${key} does not exist yet`);
      } else if (rule.from !== undefined && !rule.from.includes(current)) {
        problems.push(`${where}: ${key} is ${current}, which this event cannot follow`);
      }
      if (rule.to !== undefined) states.set(key, rule.to);
    }
  });
  return problems;
}

/** The state each entity ends in, keyed `kind:id`. */
export function finalStates(events: readonly AnyEvent[]): Map<string, string> {
  const states = new Map<string, string>();
  const guards = new Map<string, string>();
  for (const event of events) {
    if (event.type === "GuardAdmitted") guards.set(event.payload.guardId, event.payload.probeId);
    for (const rule of rulesFor(event)) {
      const named = field(event.payload, rule.idField);
      const id = rule.guard === true && named !== undefined ? guards.get(named) : named;
      if (id !== undefined && rule.to !== undefined) states.set(`${rule.kind}:${id}`, rule.to);
    }
  }
  return states;
}
