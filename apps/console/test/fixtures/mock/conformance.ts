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
import type { EventPredicatePolicies, Predicate } from "../../../src/contract/keel/index.ts";
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
  AgentSignedUp: [{ kind: "agent", idField: "agentId", from: null, to: "active" }],
  AgentSuspended: [{ kind: "agent", idField: "agentId", from: ["active"], to: "suspended" }],
  AgentReinstated: [{ kind: "agent", idField: "agentId", from: ["suspended"], to: "active" }],
  AgentRevoked: [
    { kind: "agent", idField: "agentId", from: ["active", "suspended"], to: "revoked" },
  ],
  AgentSponsored: [{ kind: "agent", idField: "agentId", from: ["active", "suspended"] }],
  AgentUnsponsored: [{ kind: "agent", idField: "agentId", from: ["active"] }],
  AgentInvited: [{ kind: "org", idField: "namespace" }],
  AgentJoinedNamespace: [{ kind: "org", idField: "namespace" }],
  AgentLeftNamespace: [{ kind: "org", idField: "namespace" }],
  AgentInvitedToProject: [{ kind: "project", idField: "projectId" }],
  AgentJoinedProject: [{ kind: "project", idField: "projectId" }],
  AgentLeftProject: [{ kind: "project", idField: "projectId" }],
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
  // By its verdict. By a conflict: only before it is in a batch. By a declined batch: only from in it. See `rulesFor`.
  ChangeBounced: [change(["deriving", "verifying", "queued", "integrating", "parked"], "bounced")],
  ConflictNoted: [change([...WITHDRAWABLE, "integrating"])],
  AlternativeDeclared: [{ kind: "project", idField: "projectId", from: ["created"] }],
  AlternativeLanded: [{ kind: "project", idField: "projectId", from: ["created"] }],
  ChangeParked: [change(["verifying", ...AGENT_OWNED], "parked")],
  ChangeResumed: [change(["parked"], "verifying")],
  ChangeAdopted: [change(["parked"], "working")],
  ChangeWithdrawn: [change(WITHDRAWABLE, "withdrawn")],
  ChangeSuperseded: [change(WITHDRAWABLE, "superseded")],
  LeaseLapsed: [change(undefined)],

  SubjectMinted: [{ kind: "subject", idField: "subjectId", from: null, to: "minted" }],
  PremiseSuspected: [{ kind: "subject", idField: "subjectId" }],
  PremiseReaffirmed: [{ kind: "subject", idField: "subjectId" }],

  WorkspaceForked: [{ kind: "workspace", idField: "workspaceId", from: null, to: "ready" }],
  WorkspaceGranted: [{ kind: "workspace", idField: "workspaceId", from: ["ready"], to: "granted" }],
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
  // Keel resolves a conflict only by the decision of a ruling on the question it was put to a person in.
  ConflictResolved: [
    { kind: "conflict", idField: "conflictId", from: ["escalated"], to: "resolved" },
  ],
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
  EscalationWidened: [{ kind: "escalation", idField: "escalationId", from: ["open"] }],

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
  // Keel commits a precedent it surfaced to a change, and a change's distinguishing itself from one, on the
  // change: the decision is named, and must stand.
  PrecedentSurfaced: [
    change(undefined),
    { kind: "decision", idField: "decisionId", from: ["active"] },
  ],
  PrecedentFollowed: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  PrecedentDistinguished: [
    change(undefined),
    { kind: "decision", idField: "decisionId", from: ["active"] },
  ],
  OverruleRequested: [{ kind: "decision", idField: "decisionId", from: ["active"] }],
  TenetEstablished: [{ kind: "tenet", idField: "tenetId", from: null, to: "established" }],
  TenetContested: [{ kind: "tenet", idField: "tenetId", from: ["established"], to: "contested" }],
  TenetReaffirmed: [{ kind: "tenet", idField: "tenetId", from: ["contested"], to: "established" }],
  TenetRetracted: [{ kind: "tenet", idField: "tenetId", from: ["contested"], to: "retracted" }],
  TenetSuperseded: [{ kind: "tenet", idField: "tenetId", from: ["established"], to: "superseded" }],
  SessionOpened: [{ kind: "session", idField: "sessionId", from: null, to: "open" }],
  MessagesCaptured: [{ kind: "session", idField: "sessionId", from: ["open"] }],
  SessionRedacted: [{ kind: "session", idField: "sessionId", from: ["open"] }],

  CredentialStored: [{ kind: "org", idField: "namespaceId" }],
  CredentialRemoved: [{ kind: "org", idField: "namespaceId" }],
  DeployTargetSet: [{ kind: "project", idField: "projectId", from: ["created"] }],
  DeployTargetCleared: [{ kind: "project", idField: "projectId", from: ["created"] }],
  // Keel commits a candidate's preview on each of its member changes: the preview is known from the first.
  PreviewDeployed: [change(undefined), { kind: "deployment", idField: "deploymentId", to: "live" }],
  PreviewTornDown: [
    { kind: "deployment", idField: "deploymentId", from: ["live"], to: "torn-down" },
  ],
  DeploymentPromoted: [{ kind: "deployment", idField: "deploymentId" }],
  DeploymentRolledBack: [{ kind: "deployment", idField: "deploymentId" }],
  DeliveryRefused: [{ kind: "project", idField: "projectId", from: ["created"] }],
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
    case "ChangeBounced":
      // A ruling goes against a change only while it waits for that ruling.
      if (event.payload.decisionId !== undefined) return [change(["parked"], "bounced")];
      if (event.payload.conflictId !== undefined)
        return [change(["deriving", "verifying", "queued"], "bounced")];
      return event.payload.declined === undefined
        ? RULES.ChangeBounced
        : [change(["integrating"], "bounced")];
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
  /** What Keel applies a proof by: each conflict's sides and predicate, how it was proven, and each change's latest plan. */
  const sides = new Map<string, { parties: readonly string[]; predicate?: Predicate }>();
  const proofs = new Map<string, ConflictProof>();
  const policies = new Map<string, EventPredicatePolicies>();
  /** The changes each decision's resolution went against. */
  const ruledAgainst = new Map<string, readonly string[]>();
  /** Every way a proof's mark on a change (a bounce or a note) disagrees with the conflict it names. */
  const againstProof = (changeId: string, conflictId: string): string[] => {
    const wrong: string[] = [];
    if (!proofs.has(conflictId)) wrong.push(`${conflictId} was not proven`);
    if (sides.get(conflictId)?.parties.includes(changeId) !== true)
      wrong.push(`${changeId} is not one of ${conflictId}'s sides`);
    return wrong;
  };
  /** The policy a change applies to a proof on a conflict: its latest plan's for the predicate, and `advise` when silent. */
  const policyOn = (changeId: string, conflictId: string): string => {
    const predicate = sides.get(conflictId)?.predicate;
    return (predicate === undefined ? undefined : policies.get(changeId)?.[predicate]) ?? "advise";
  };
  /** What each change says it will do, as the set of claims its declared effects make. */
  const claims = new Map<string, string>();
  const ENDED: ReadonlySet<string> = new Set(["landed", "withdrawn", "superseded"]);
  const live = (changeId: string): boolean => {
    const state = states.get(`change:${changeId}`);
    return state !== undefined && !ENDED.has(state);
  };
  /**
   * Every way two changes are not alternatives, as Keel means it: one change, or declared effects that do not
   * make the same claims, as non-empty sets. Keel also reads an ordering named from either end as one claim,
   * which this check does not.
   */
  const notAlternatives = (changeId: string, other: string): string[] => {
    if (changeId === other) return [`${changeId} is not an alternative to itself`];
    const mine = claims.get(changeId) ?? "";
    return mine !== "" && mine === claims.get(other)
      ? []
      : [`${other} does not have the same intent as ${changeId}`];
  };
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
        sides.set(event.payload.conflictId, {
          parties: event.payload.parties,
          ...(event.payload.predicate === undefined ? {} : { predicate: event.payload.predicate }),
        });
        break;
      case "IntentDeclared":
      case "IntentRevised":
        if (event.payload.declaredEffects !== undefined)
          claims.set(
            event.payload.changeId,
            [
              ...new Set(
                event.payload.declaredEffects.map((effect) =>
                  JSON.stringify([
                    effect.subject,
                    effect.predicate,
                    effect.relation,
                    effect.value,
                    effect.unit ?? null,
                    effect.scope ?? null,
                  ]),
                ),
              ),
            ]
              .toSorted()
              .join("\n"),
          );
        break;
      case "PreflightIssued": {
        const { changeId, alternatives } = event.payload;
        if (alternatives === undefined) break;
        // Keel copies them onto the preflight only when there are some.
        if (alternatives.length === 0)
          problems.push(`${where}: it lists no alternatives, and says so`);
        for (const other of alternatives) {
          for (const wrong of notAlternatives(changeId, other)) problems.push(`${where}: ${wrong}`);
          if (!live(other)) problems.push(`${where}: ${other} is not a live change`);
        }
        break;
      }
      case "AlternativeDeclared": {
        const { changeId, alternativeId, nextActions } = event.payload;
        for (const wrong of notAlternatives(changeId, alternativeId))
          problems.push(`${where}: ${wrong}`);
        for (const id of [changeId, alternativeId])
          if (!live(id)) problems.push(`${where}: ${id} is not a live change`);
        if (nextActions.length === 0) problems.push(`${where}: it names no way forward`);
        break;
      }
      case "AlternativeLanded": {
        const { changeId, landedChangeId, nextActions } = event.payload;
        for (const wrong of notAlternatives(changeId, landedChangeId))
          problems.push(`${where}: ${wrong}`);
        if (states.get(`change:${landedChangeId}`) !== "landed")
          problems.push(`${where}: ${landedChangeId} has not landed`);
        if (!live(changeId)) problems.push(`${where}: ${changeId} is not a live change`);
        if (nextActions.length === 0) problems.push(`${where}: it names no way forward`);
        break;
      }
      case "PlanCompiled":
        // The latest plan's policy replaces the last one's, and a plan that says nothing leaves none.
        if (event.payload.predicatePolicy === undefined) policies.delete(event.payload.changeId);
        else policies.set(event.payload.changeId, event.payload.predicatePolicy);
        break;
      case "ChangeBounced": {
        const { changeId, verdictId, conflictId, declined, decisionId } = event.payload;
        if (
          [verdictId, conflictId, declined, decisionId].filter((cause) => cause !== undefined)
            .length !== 1
        )
          problems.push(
            `${where}: a bounce names exactly one cause: its verdict, its conflict, its declined batch or the decision that went against it`,
          );
        if (verdictId !== undefined && states.get(`verdict:${verdictId}`) !== "issued")
          problems.push(`${where}: verdict ${verdictId} was not issued`);
        // A ruling bounces the parties its conflict's resolution went against, and no other change.
        if (decisionId !== undefined && ruledAgainst.get(decisionId)?.includes(changeId) !== true)
          problems.push(`${where}: no resolution by ${decisionId} went against ${changeId}`);
        if (conflictId === undefined) break;
        for (const wrong of againstProof(changeId, conflictId)) problems.push(`${where}: ${wrong}`);
        if (policyOn(changeId, conflictId) !== "block")
          problems.push(
            `${where}: the change's plan does not block on the conflict's predicate (${policyOn(changeId, conflictId)})`,
          );
        break;
      }
      case "ConflictResolved": {
        const { conflictId, decisionId, against } = event.payload;
        if (decisionId === undefined)
          problems.push(`${where}: Keel resolves a conflict only by a ruling's decision`);
        if (against === undefined) break;
        if (decisionId === undefined || against.length === 0)
          problems.push(
            `${where}: a resolution goes against a party only by a decision, and never against none`,
          );
        else ruledAgainst.set(decisionId, against);
        for (const changeId of against)
          if (sides.get(conflictId)?.parties.includes(changeId) !== true)
            problems.push(`${where}: ${changeId} is not one of ${conflictId}'s sides`);
        break;
      }
      case "ConflictNoted": {
        const { changeId, conflictId, policy, evidenceRef, nextActions } = event.payload;
        for (const wrong of againstProof(changeId, conflictId)) problems.push(`${where}: ${wrong}`);
        if (policyOn(changeId, conflictId) !== policy)
          problems.push(
            `${where}: noted as ${policy}, and the change's plan says ${policyOn(changeId, conflictId)}`,
          );
        const proof = proofs.get(conflictId);
        const expected = proof?._tag === "probe" ? `probe:${proof.probeId}` : undefined;
        if (evidenceRef !== expected)
          problems.push(
            `${where}: its evidence is ${evidenceRef ?? "none"}, and the proof's is ${expected ?? "none"}`,
          );
        if ((nextActions !== undefined) !== (policy === "advise"))
          problems.push(`${where}: only an advised change is told its ways forward`);
        break;
      }
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
        proofs.set(event.payload.conflictId, proof);
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
