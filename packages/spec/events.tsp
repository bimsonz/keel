import "@typespec/http";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";
import "./agents.tsp";

namespace Keel;

// The event catalogue (docs/domain/events.md) as published in `EventRecord.payload`:
// one model per event, named as the event, each mirroring the JSON form of its
// schema in `packages/core/src/domain/<context>/events.ts`. The conformance test
// `packages/tooling/test/event-catalogue.test.ts` keeps the two equal.
//
// Shapes the API already publishes are reused where core's match them exactly
// (`MFP.FootprintEntry`, `Move`, `Scope`, the id scalars). Where they differ, an
// `Event*` model carries core's shape and the published one keeps its own:
// `EventProposition` (subject a key, not any string; `_tag` citations, not `kind`;
// no default strength), `EventAnchor` (a commit SHA, not any 4+ characters),
// `EventSubjectKey` and `EventNeighbour` (no length cap on a subject key),
// `EventContradiction` (through the proposition), `EventPrecedentRef` (`decidedAt`
// in epoch milliseconds, not a date-time), `EventNextAction` (a non-empty title,
// no `notBefore`) and `EventDerivedEffect` (Keel's derivation record, a union by method).

// ─── Shared shapes ──────────────────────────────────────────────────────────

/** A point in time, as milliseconds since the Unix epoch: how events carry time. */
scalar Instant extends float64;

/** A subject key as events carry it: the API's `SubjectKey` without its length cap. */
@pattern("^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
scalar EventSubjectKey extends string;

/** A code symbol pinned to a commit. */
model EventAnchor {
  @minLength(1)
  path: string;

  symbol?: string;
  commit: CommitSha;
}

/** A numbered session message. */
model EventMessageCitation {
  _tag: "message";
  session: SessionId;
  seq: integer;
}

model EventAnchorCitation {
  _tag: "anchor";
  anchor: EventAnchor;
}

/** An MFP record, by id. */
model EventRecordCitation {
  _tag: "record";

  @minLength(1)
  id: string;
}

/** What a claim rests on: a numbered session message, a code anchor, or an MFP record. */
union EventCitation {
  message: EventMessageCitation,
  anchor: EventAnchorCitation,
  record: EventRecordCitation,
}

/** A typed statement about a subject: a premise a change relies on, or an effect it causes. */
model EventProposition {
  subject: EventSubjectKey;
  predicate: MFP.Predicate;
  relation: MFP.Relation;

  /** Read on the predicate's lattice, as in `MFP.Proposition.value`. */
  value: string | float64 | boolean;

  /** The unit of a `bound` value, e.g. `ms`. */
  unit?: string;

  /** `;`-separated `key:value` pairs, e.g. `env:prod|staging;tenant:t1`. Absent means everywhere. */
  scope?: string;

  anchors?: EventAnchor[];
  gloss?: string;

  /** The holder's declared kind of reliance, not a confidence. */
  strength?: "must" | "should";

  cites?: EventCitation[];
}

/** What an agent can do next, attached to every bounce. */
model EventNextAction {
  /** `call` an operation, `wait` and retry, `read` something first, or `escalate` to a person. */
  kind: "call" | "wait" | "read" | "escalate";

  @minLength(1)
  title: string;

  /** The operation to call, for `call` and `read`. */
  operationId?: string;

  /** Arguments to pass to it, pre-filled. */
  args?: Record<unknown>;
}

union EntityKind {
  agent: "agent",
  session: "session",
  change: "change",
  subject: "subject",
  sketch: "sketch",
  workspace: "workspace",
  conflict: "conflict",
  probe: "probe",
  guard: "guard",
  verdict: "verdict",
  batch: "batch",
  candidate: "candidate",
  project: "project",

  /** The Trunk DO's promotion state, keyed by project (`trunk:<projectId>`). */
  trunk: "trunk",

  decision: "decision",
  tenet: "tenet",
  escalation: "escalation",
  deployment: "deployment",

  /** A user's tenancy events (`user:<userId>`), committed from Better Auth's after-hooks. */
  user: "user",

  /** An org's tenancy events (`org:<orgId>`), committed from Better Auth's after-hooks. */
  org: "org",
}

/** An entity a Durable Object owns. */
model EntityRef {
  kind: EntityKind;
  id: string;
}

// ─── Coordination ───────────────────────────────────────────────────────────

union ChangeOrigin {
  agent: "agent",
  auditor: "auditor",
  operator: "operator",
}

union ParkReason {
  awaitingRuling: "awaiting-ruling",
  leaseLapsed: "lease-lapsed",
}

/** Another change near this one. Footprint overlap is exposure: it never opens a conflict. */
model EventNeighbour {
  changeId: ChangeId;
  goal: string;
  subjects: EventSubjectKey[];
  overlap: "subject" | "footprint";
}

/** A premise and the proposition contradicting it: one change's premise (or a tenet) against another change's premise or effect. */
model EventContradiction {
  premise: EventProposition;
  with: EventProposition;

  /** The change or tenet holding the premise. */
  holder: string;

  /** Whether `with` is a premise or an effect. Always set by Keel; absent (older events) reads as an effect. */
  withRole?: "premise" | "effect";
}

/** A move resting on one of the preflight's contradictions, by its index in that list. */
model EventContradictionBasis {
  _tag: "contradiction";

  @minValue(0)
  index: integer;
}

/** A move resting on a precedent in scope. */
model EventPrecedentBasis {
  _tag: "precedent";
  decisionId: DecisionId;
}

/** What a suggested move rests on: a contradiction in the same preflight, or a precedent. */
union EventMoveBasis {
  contradiction: EventContradictionBasis,
  precedent: EventPrecedentBasis,
}

model EventPrecedentRef {
  decisionId: DecisionId;
  summary: string;
  decidedAt: Instant;
  scope?: string;
}

/** Found by a deterministic extractor: a ruling, never proof (an extractor executes nothing), with no probability. */
model EventExtractedEffect {
  proposition: EventProposition;
  method: "extractor";
  evidenceClass: "ruling";

  @minItems(1)
  anchors: EventAnchor[];

  declared: boolean;

  /** A premise or tenet this effect contradicts, by reference. */
  contradicts?: string;
}

/** Answered by a decision model: opinion, always with its probability. */
model EventDecisionModelEffect {
  proposition: EventProposition;
  method: "clef";
  evidenceClass: "opinion";

  @minValue(0)
  @maxValue(1)
  p: float64;

  @minItems(1)
  anchors: EventAnchor[];

  declared: boolean;

  /** A premise or tenet this effect contradicts, by reference. */
  contradicts?: string;
}

/** Proposed by a code model: opinion, with its probability when the model gave one. */
model EventCodeModelEffect {
  proposition: EventProposition;
  method: "code-model";
  evidenceClass: "opinion";

  @minValue(0)
  @maxValue(1)
  p?: float64;

  @minItems(1)
  anchors: EventAnchor[];

  declared: boolean;

  /** A premise or tenet this effect contradicts, by reference. */
  contradicts?: string;
}

/** What a change alters, as Keel derived it from the diff: the method fixes the evidence class and the probability. */
union EventDerivedEffect {
  extracted: EventExtractedEffect,
  decisionModel: EventDecisionModelEffect,
  codeModel: EventCodeModelEffect,
}

union DriftClass {
  footprint: "footprint",
  undeclaredEffect: "undeclared-effect",
  silentRetraction: "silent-retraction",
}

model Drift {
  class: DriftClass;
  severity: "low" | "medium" | "high";
  detail: string;
}

model IntentDeclared {
  _tag: "IntentDeclared";
  changeId: ChangeId;
  agentId: AgentId;

  /** The run of the agent that declared the change, when its token named one: the run that holds it. */
  run?: RunRef;
  origin: ChangeOrigin;
  sketchId?: SketchId;
  revision: integer;

  @minLength(1)
  goal: string;

  footprint: MFP.FootprintEntry[];
  premises: EventProposition[];
  declaredEffects?: EventProposition[];
  leaseId: LeaseId;
}

model PreflightIssued {
  _tag: "PreflightIssued";
  changeId: ChangeId;
  revision: integer;
  neighbours: EventNeighbour[];
  contradictions: EventContradiction[];
  precedents: EventPrecedentRef[];
  suggestedMove: Move;

  /** What the move rests on. Absent exactly when the move is `proceed`. */
  basis?: EventMoveBasis;

  /** The live changes with the same intent, in the order the live index gave them, never ranked. Absent when there are none. */
  alternatives?: ChangeId[];
}

model IntentRevised {
  _tag: "IntentRevised";
  changeId: ChangeId;
  revision: integer;
  goal?: string;
  footprint?: MFP.FootprintEntry[];
  premisesAdded: EventProposition[];
  premisesRetracted: EventProposition[];
  declaredEffects?: EventProposition[];
}

/** Declared → Working: the pool granted a workspace, or the promoted sketch's workspace was reassigned. */
model ChangeStarted {
  _tag: "ChangeStarted";
  changeId: ChangeId;
  workspaceId: WorkspaceId;

  /** The workspace's head when granted: the change's base. Always set; optional only so older events still decode. */
  baseSha?: CommitSha;
}

model PremiseRelied {
  _tag: "PremiseRelied";
  subjectId: SubjectId;
  changeId: ChangeId;
  premise: EventProposition;
}

model ChangeSubmitted {
  _tag: "ChangeSubmitted";
  changeId: ChangeId;
  revision: integer;
  commitSha: CommitSha;
  workspaceId: WorkspaceId;

  /** The change's base when it was submitted: the base the submission is judged against. Always set when the change has one; optional only so older events still decode. */
  baseSha?: CommitSha;
}

/** The agent rebased its workspace onto `to`: the change's base moves from `from`, and nothing else changes. */
model ChangeRebased {
  _tag: "ChangeRebased";
  changeId: ChangeId;
  from: CommitSha;
  to: CommitSha;
}

model PrecheckStarted {
  _tag: "PrecheckStarted";
  changeId: ChangeId;
  revision: integer;
  instanceId: string;
}

model EffectsDerived {
  _tag: "EffectsDerived";
  changeId: ChangeId;
  revision: integer;
  effects: EventDerivedEffect[];
  derivationRef: string;
}

model DriftDetected {
  _tag: "DriftDetected";
  changeId: ChangeId;
  revision: integer;
  drift: Drift[];
}

model ChangeDrifted {
  _tag: "ChangeDrifted";
  changeId: ChangeId;
  revision: integer;
  blocking: Drift[];
}

/** What a proven conflict on a predicate does (ADR 0005): block holds the change for a ruling; advise warns; annotate only records. */
union PredicatePolicy {
  block: "block",
  advise: "advise",
  annotate: "annotate",
}

/** A project's predicate policy as composed for one change. A predicate left out is advise. */
model EventPredicatePolicies {
  freshness?: PredicatePolicy;
  cardinality?: PredicatePolicy;
  ordering?: PredicatePolicy;
  consistency?: PredicatePolicy;
  shape?: PredicatePolicy;
  presence?: PredicatePolicy;
  authority?: PredicatePolicy;
  purity?: PredicatePolicy;
  idempotent?: PredicatePolicy;
  bound?: PredicatePolicy;
  invariant?: PredicatePolicy;
}

model PlanCompiled {
  _tag: "PlanCompiled";
  changeId: ChangeId;
  revision: integer;
  planHash: ContentHash;

  /** How many steps the plan has. */
  steps: integer;

  costEstimate: float64;

  /** The predicate policy compiled for the change; the Change DO applies it to a proven conflict. */
  predicatePolicy?: EventPredicatePolicies;
}

model ChangeQueued {
  _tag: "ChangeQueued";
  changeId: ChangeId;
  laneId: string;

  /** The plan the change was verified under: its PlanCompiled's hash. Optional only so older events still decode. */
  planHash?: ContentHash;
}

model ChangeBatched {
  _tag: "ChangeBatched";
  changeId: ChangeId;
  batchId: BatchId;
}

model ChangeRequeued {
  _tag: "ChangeRequeued";
  changeId: ChangeId;
  batchId: BatchId;
  reason: "infra-failure" | "bisection" | "invalidated" | "co-member-failed" | "textual" | "interaction";

  /** The plan the change was verified under, so the Lane re-adds it from this event alone. Optional only so older events still decode. */
  planHash?: ContentHash;
}

model ChangeLanded {
  _tag: "ChangeLanded";
  changeId: ChangeId;
  commitSha: CommitSha;
  trunkSha: CommitSha;
  candidateId: CandidateId;
  proofId: string;
}

/** The change went back to its agent for exactly one cause: the verdict that failed it, the conflict proven against it under `block`, or the promotion that declined its batch because the push was refused. */
model ChangeBounced {
  _tag: "ChangeBounced";
  changeId: ChangeId;

  /** The verdict that failed the change. Exactly one of `verdictId`, `conflictId` and `declined` is set. */
  verdictId?: VerdictId;

  /** The conflict proven against the change under a `block` policy. Exactly one of `verdictId`, `conflictId` and `declined` is set. */
  conflictId?: ConflictId;

  /** The batch promotion declined, and why its push was refused. Exactly one of `verdictId`, `conflictId` and `declined` is set. */
  declined?: {
    batchId: BatchId;
    reason: PushRefusedReason;
  };

  reasons: string[];

  /** Always set, never empty; optional only so events committed before it was added still decode. */
  nextActions?: EventNextAction[];
}

/** A conflict proven against the change under `advise` or `annotate`: recorded on the change, which stays where it is. Annotate notifies no one. */
model ConflictNoted {
  _tag: "ConflictNoted";
  changeId: ChangeId;
  conflictId: ConflictId;
  predicate: MFP.Predicate;
  policy: "advise" | "annotate";

  /** The proof's evidence, as the Change DO refers to it (`probe:<probeId>`). */
  @minLength(1)
  evidenceRef?: string;

  /** Set for `advise` only: read the conflict, revise, resolve. */
  nextActions?: EventNextAction[];
}

/** Another live change was declared with the same intent as `changeId`: their declared effects make the same claims. A notice for `changeId`'s agent, committed on the project. Keel shows alternatives to each other and never picks one. */
model AlternativeDeclared {
  _tag: "AlternativeDeclared";
  projectId: ProjectId;
  changeId: ChangeId;
  alternativeId: ChangeId;

  /** Compare the two (read the other change, read what is near your own), rebase, or withdraw. */
  nextActions: EventNextAction[];
}

/** A change with the same intent as `changeId` landed. A notice for `changeId`'s agent, committed on the project. */
model AlternativeLanded {
  _tag: "AlternativeLanded";
  projectId: ProjectId;
  changeId: ChangeId;
  landedChangeId: ChangeId;

  /** Compare the two (read the landed change, read what is near your own), rebase, or withdraw. */
  nextActions: EventNextAction[];
}

model ChangeParked {
  _tag: "ChangeParked";
  changeId: ChangeId;
  reason: ParkReason;
  escalationId?: EscalationId;
}

model ChangeResumed {
  _tag: "ChangeResumed";
  changeId: ChangeId;
  decisionId: DecisionId;
}

model ChangeAdopted {
  _tag: "ChangeAdopted";
  changeId: ChangeId;
  previousAgentId: AgentId;
  agentId: AgentId;

  /** The adopter's run, which holds the change from here; absent when the adopter's token named none. */
  run?: RunRef;

  leaseId: LeaseId;
  briefRef: string;
}

model ChangeWithdrawn {
  _tag: "ChangeWithdrawn";
  changeId: ChangeId;
  by: string;
  reason?: string;
}

model ChangeSuperseded {
  _tag: "ChangeSuperseded";
  changeId: ChangeId;
  by: ChangeId;
  decisionId?: DecisionId;
}

model LeaseLapsed {
  _tag: "LeaseLapsed";
  changeId: ChangeId;
  leaseId: LeaseId;
  renewedAt: Instant;
}

model SubjectMinted {
  _tag: "SubjectMinted";
  subjectId: SubjectId;
  key: EventSubjectKey;
  anchors: EventAnchor[];
  gloss: string;
  mintedBy: "scan" | "clef" | "agent";
}

model PremiseSuspected {
  _tag: "PremiseSuspected";
  subjectId: SubjectId;
  changeId: ChangeId;
  premise: EventProposition;
  cause: {
    changeId: ChangeId;
    effect: EventProposition;
  };
}

model PremiseReaffirmed {
  _tag: "PremiseReaffirmed";
  subjectId: SubjectId;
  changeId: ChangeId;
  premise: EventProposition;
}

model SketchOpened {
  _tag: "SketchOpened";
  sketchId: SketchId;
  agentId: AgentId;
  workspaceId: WorkspaceId;
  expiresAt: Instant;
}

model SketchPromoted {
  _tag: "SketchPromoted";
  sketchId: SketchId;
  changeId: ChangeId;
}

model SketchExpired {
  _tag: "SketchExpired";
  sketchId: SketchId;
}

model SketchDiscarded {
  _tag: "SketchDiscarded";
  sketchId: SketchId;
  by: string;
}

model WorkspaceForked {
  _tag: "WorkspaceForked";
  workspaceId: WorkspaceId;
  repo: string;
  sourceRepo: string;
}

model WorkspaceGranted {
  _tag: "WorkspaceGranted";
  workspaceId: WorkspaceId;
  holder: ChangeId | SketchId;
  expiresAt: Instant;

  /** The workspace's head when granted: the change's base. */
  baseSha: CommitSha;
}

/** A promoted sketch's workspace passes to the change it became. */
model WorkspaceReassigned {
  _tag: "WorkspaceReassigned";
  workspaceId: WorkspaceId;
  sketchId: SketchId;
  changeId: ChangeId;
}

model WorkspacePushed {
  _tag: "WorkspacePushed";
  workspaceId: WorkspaceId;
  ref: string;
  sha: CommitSha;
}

model WorkspaceCollected {
  _tag: "WorkspaceCollected";
  workspaceId: WorkspaceId;
  reason: "landed" | "withdrawn" | "expired";
}

// ─── Identity ───────────────────────────────────────────────────────────────

model AgentEnrolled {
  _tag: "AgentEnrolled";
  agentId: AgentId;
  projectId: ProjectId;

  @minLength(1)
  name: string;

  kind: AgentKind;
  scopes: RecordedScope[];

  /** The namespace the agent works in: its project's. Optional only so agents enrolled before tenancy still decode. */
  org?: NamespaceId;

  /** The user who minted the agent's credential: its sponsor, accountable for it. */
  sponsor?: UserId;
}

/** An Ed25519 public key, as a JWK. */
model Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";

  @minLength(1)
  x: string;
}

/** A P-256 public key, as a JWK: what a hardware key store holds. */
model P256Jwk {
  kty: "EC";
  crv: "P-256";

  @minLength(1)
  x: string;

  @minLength(1)
  y: string;
}

/** A public key an agent may sign with. */
union PublicJwk {
  Ed25519Jwk,
  P256Jwk,
}

/** A key as an agent presented it, with the RFC 7638 thumbprint Keel computed for it. */
model PresentedKey {
  @pattern("^[A-Za-z0-9_-]{43}$")
  jkt: string;

  jwk: PublicJwk;
}

/** An agent signed itself up with a key: no person, no project. Its id and handle are made from that key. */
model AgentSignedUp {
  _tag: "AgentSignedUp";
  agentId: AgentId;
  handle: Handle;

  /** What the agent calls itself: a label, never an address. */
  @minLength(1)
  name?: string;

  key: PresentedKey;
}

model AgentSuspended {
  _tag: "AgentSuspended";
  agentId: AgentId;
  reason: string;
  by: string;
}

model AgentReinstated {
  _tag: "AgentReinstated";
  agentId: AgentId;
  by: string;
}

model AgentRevoked {
  _tag: "AgentRevoked";
  agentId: AgentId;
  revocationEpoch: integer;
  by: string;
}

/**
 * A person stands behind the agent: a link that carries no rights and needs
 * no org. The agent asked for it and the person approved it.
 */
model AgentSponsored {
  _tag: "AgentSponsored";
  agentId: AgentId;
  sponsor: UserId;
}

/** The link ended. `by` is whoever ended it: the sponsor, or the agent itself. */
model AgentUnsponsored {
  _tag: "AgentUnsponsored";
  agentId: AgentId;
  sponsor: UserId;
  by: string;
}

// Tenancy. Better Auth's tables in D1 are identity's source of truth;
// its after-hooks commit these for the feed and the audit, one per row-state
// change, keyed `user:<userId>` or `org:<orgId>`. No event carries an email.

/** A member's role in an org: each includes the one below it. */
union Role {
  owner: "owner",
  maintainer: "maintainer",
  member: "member",
}

/** A user's handle or an org's name: one segment of `/<org>/<project>`. */
@pattern("^[a-z0-9](?:-?[a-z0-9]){0,38}$")
scalar Handle extends string;

model UserSignedUp {
  _tag: "UserSignedUp";
  userId: UserId;

  /** Absent until the user chooses one. */
  handle?: Handle;
}

model OrgCreated {
  _tag: "OrgCreated";
  orgId: OrgId;
  name: Handle;

  /** A user's personal org, created on sign-up and named by its handle. */
  personal: boolean;

  by: UserId;
}

/**
 * A user joined an org (`to` alone), left it (`from` alone), or changed role.
 * At least one of `from` and `to` is set, and they differ.
 */
model MembershipChanged {
  _tag: "MembershipChanged";
  orgId: OrgId;
  userId: UserId;
  from?: Role;
  to?: Role;

  /** Absent when the user acted alone, e.g. accepting an invitation. */
  by?: UserId;
}

model UserSuspended {
  _tag: "UserSuspended";
  userId: UserId;
  reason: string;
  by: UserId;
}

model UserReinstated {
  _tag: "UserReinstated";
  userId: UserId;
  by: UserId;
}

model OrgSuspended {
  _tag: "OrgSuspended";
  orgId: OrgId;
  reason: string;
  by: UserId;
}

model OrgReinstated {
  _tag: "OrgReinstated";
  orgId: OrgId;
  by: UserId;
}

/** An org and everything it owned are gone: its projects, repos, R2 prefix, objects and rows. */
model OrgDeleted {
  _tag: "OrgDeleted";
  orgId: OrgId;
}

// ─── Verification ───────────────────────────────────────────────────────────

/** A party to a conflict: a change, or a tenet. */
union Party {
  ChangeId,
  TenetId,
}

/**
 * One combination of changes evaluated together, or `A-noop`: the premise
 * holder's world with the premised behaviour removed. A probe that passes there
 * does not test the premise, so it is never admitted.
 */
union World {
  trunk: "trunk",
  a: "A",
  b: "B",
  ab: "AB",
  aNoop: "A-noop",
}

model ConflictSuspected {
  _tag: "ConflictSuspected";
  conflictId: ConflictId;
  kind: ConflictKind;
  parties: Party[];
  subjectId?: SubjectId;

  /** The subject's key, which addresses its Subject DO. Only with `subjectId`; absent on older events. */
  subjectKey?: EventSubjectKey;

  predicate?: MFP.Predicate;

  /** Absent means `fallout`; `opinion` is a decision model's suspicion, which only a probe or a person settles. */
  origin?: "fallout" | "opinion";

  /** The premise at stake, and its holder. Without it and `effect`, no probe is drafted: the conflict escalates as unprovable. */
  premise?: SuspectPremise;

  /** The effect against the premise, and the change making it. */
  effect?: SuspectEffect;
}

/** The premise a semantic conflict puts at stake, and the change holding it. */
model SuspectPremise {
  holder: ChangeId;
  proposition: EventProposition;
}

/** The effect that contradicts the premise, and the change making it. */
model SuspectEffect {
  changeId: ChangeId;
  proposition: EventProposition;

  /** How the effect is known, as fallout judged it. Absent on older events. */
  evidence?: SuspectEvidence;
}

/**
 * How a suspect effect is known. With no `method` it is the agent's own claim: `declared` is true and the class is
 * `testimony`. With a method Keel derived it, and the method fixes the class: `extractor` is a `ruling`, `clef` and
 * `code-model` are `opinion`; `declared` then says whether the agent's declared effects spoke for it. Core refuses any
 * other combination.
 */
model SuspectEvidence {
  declared: boolean;
  method?: "extractor" | "clef" | "code-model";
  evidenceClass: "proof" | "ruling" | "testimony" | "opinion";
}

model ProbeDrafted {
  _tag: "ProbeDrafted";
  probeId: ProbeId;
  conflictId: ConflictId;
  attempts: integer;
  bundleHash: ContentHash;
}

model ProbeRan {
  _tag: "ProbeRan";
  probeId: ProbeId;
  conflictId: ConflictId;
  world: World;
  run: integer;
  outcome: "pass" | "fail" | "n/a";
  resultRef: string;
}

/** A project suite's cell in a conflict's world matrix: a fact of a conflict whose probe was drafted, which stays in the state it is in. An n/a cell says why. */
model WorldCheckRan {
  _tag: "WorldCheckRan";
  conflictId: ConflictId;
  world: World;

  /** `suite:trunk`, the project's suite on trunk, or `suite:<changeId>`, a change's own. */
  @pattern("^suite:(?:trunk|chg_[0-9A-HJKMNP-TV-Z]{26})$")
  check: string;

  @minValue(1)
  @maxValue(3)
  run: integer;

  outcome: "pass" | "fail" | "n/a";
  counts?: WorldCheckCounts;

  @minLength(1)
  reason?: string;
}

model WorldCheckCounts {
  @minValue(0) passed: integer;
  @minValue(0) failed: integer;
  @minValue(0) skipped: integer;
}

model ProbeDiscarded {
  _tag: "ProbeDiscarded";
  probeId: ProbeId;
  reason: "non-discriminating" | "unstable" | "draft-failed";

  /** Always set (optional only so older events decode): a probe whose drafts all failed begins with this event. */
  conflictId?: ConflictId;

  /**
   * Why no draft was admitted to calibrate, with `draft-failed` only: the model
   * abstained, the repairs ran out, a run of the matrix never completed, the
   * conflict names no premise and effect to draft against, a party submitted no
   * commit to build a world from, a party is gone, or the worlds could not be
   * built. `schema` and `truncated` (a reply that did not fit the slots' schema,
   * or was cut at the token limit) are repaired now: nothing emits them, and
   * they stay so older events decode.
   */
  detail?:
    | "schema"
    | "truncated"
    | "abstained"
    | "repairs-exhausted"
    | "incomplete"
    | "no-propositions"
    | "no-submission"
    | "party-gone"
    | "worlds-unbuildable";
}

model ConflictProven {
  _tag: "ConflictProven";
  conflictId: ConflictId;
  evidence:
    | {
        _tag: "probe";
        probeId: ProbeId;
      }
    | {
        _tag: "guard";
        guardId: GuardId;
      }
    | {
        _tag: "merge-refused";
        batchId: BatchId;
      }
    | {
        _tag: "interaction";
        batchId: BatchId;
      };
}

model ConflictDismissed {
  _tag: "ConflictDismissed";
  conflictId: ConflictId;
  evidence: string;
}

model ConflictEscalated {
  _tag: "ConflictEscalated";
  conflictId: ConflictId;
  escalationId: EscalationId;
  reason: "human-class" | "unprovable";
}

model ConflictResolved {
  _tag: "ConflictResolved";
  conflictId: ConflictId;
  move: Move;
  decisionId?: DecisionId;
}

model GuardAdmitted {
  _tag: "GuardAdmitted";
  guardId: GuardId;
  probeId: ProbeId;
  conflictId: ConflictId;
  runs: integer;
}

model GuardRetired {
  _tag: "GuardRetired";
  guardId: GuardId;
  decisionId: DecisionId;
}

/** Against a batch's candidate at the Lane DO, or at Precheck against the change itself: a change, or a batch and its candidate. */
model GuardFailed {
  _tag: "GuardFailed";
  guardId: GuardId;
  batchId?: BatchId;
  candidateId?: CandidateId;
  changeId?: ChangeId;
  world: World;
}

model VerdictIssued {
  _tag: "VerdictIssued";
  verdictId: VerdictId;
  subject: ChangeId | BatchId;
  outcome: VerdictOutcome;
  evidence: string[];

  /** The plan the verdict was reached under. Absent means no plan, never a fabricated hash. */
  planHash?: ContentHash;

  /** False when the project's verification is off and the plan was not run. Absent means true. */
  verified?: boolean;

  /** The remedy, named by the issuer; the Change DO copies it onto ChangeBounced. */
  nextActions?: EventNextAction[];
}

/** One answer a person can give, with what choosing it does. A ruling names it by `id`. */
model EscalationOption {
  @minLength(1)
  id: string;

  label: string;
  consequence: string;
}

/** What kind of question a person is asked to rule on. */
union EscalationCategory {
  "permission-semantics",
  "destructive-migration",
  "ambiguous-requirement",
  "unprovable-conflict",
  "overrule-request",
  "frozen-trunk",
}

/** One piece of evidence put before the person, by class. */
model EscalationEvidence {
  class: "proof" | "ruling" | "testimony" | "opinion";

  @minLength(1)
  summary: string;

  ref?: string;
}

model EscalationRaised {
  _tag: "EscalationRaised";
  escalationId: EscalationId;

  @minLength(1)
  question: string;

  /** At least two, with unique ids. */
  options: EscalationOption[];

  about: EntityRef;
  category: EscalationCategory;
  evidence: EscalationEvidence[];
  precedents: DecisionId[];

  /** The option suggested to the person: one of `options`, never applied on a timeout. */
  @minLength(1)
  default: string;
}

model EscalationWithdrawn {
  _tag: "EscalationWithdrawn";
  escalationId: EscalationId;
  reason: string;
}

/**
 * The person asked first has had thirty minutes and the escalation is still
 * open: its namespace's maintainers are asked too. Committed once. Nothing is
 * reassigned, and the person asked first may still answer.
 */
model EscalationWidened {
  _tag: "EscalationWidened";
  escalationId: EscalationId;
}

// ─── Integration ────────────────────────────────────────────────────────────

/** Where a step runs: 0 pure git inside a Durable Object, 1 a throwaway isolate, 2 a container. */
union Tier {
  0,
  1,
  2,
}

/**
 * Who a failed batch is blamed on: one member, a refused composition
 * (`textual`), every subset passing while the union fails (`interaction`), the
 * infrastructure (`infra`), or nobody yet (`unattributed`).
 */
union BatchAttribution {
  ChangeId,
  "textual",
  "interaction",
  "infra",
  "unattributed",
}

model BatchFormed {
  _tag: "BatchFormed";
  batchId: BatchId;
  laneId: string;
  members: ChangeId[];
  base: CommitSha;
  attempt: integer;
  chainEpoch: integer;

  /** Optional only so events from before it was added still decode; the Lane always sets it. */
  projectId?: ProjectId;

  /** Changes the batch was verified on top of that trunk does not hold yet (its speculation chain). */
  predecessors?: ChangeId[];
}

model CandidateAssembled {
  _tag: "CandidateAssembled";
  candidateId: CandidateId;
  batchId: BatchId;
  treeSha: CommitSha;
  composer: "gitcore" | "mergebox";
  tier: Tier;
  tierReason: string;
}

model VerificationStarted {
  _tag: "VerificationStarted";
  candidateId: CandidateId;
  batchId: BatchId;
  instanceId: string;
  planHash: ContentHash;
}

model BatchVerified {
  _tag: "BatchVerified";
  batchId: BatchId;
  candidateId: CandidateId;
  verdictId: VerdictId;

  /** What the Trunk DO needs to promote the batch: optional only so older events still decode. */
  members?: ChangeId[];

  base?: CommitSha;
  predecessors?: ChangeId[];

  /** Carried unchanged from the batch's `VerdictIssued.verified`. Absent means true. */
  verified?: boolean;
}

model BatchFailed {
  _tag: "BatchFailed";
  batchId: BatchId;
  candidateId?: CandidateId;
  verdictId: VerdictId;
  attribution: BatchAttribution;
}

model CandidateBisected {
  _tag: "CandidateBisected";
  candidateId: CandidateId;
  batchId: BatchId;
  into: BatchId[];
}

model CandidateInvalidated {
  _tag: "CandidateInvalidated";
  candidateId: CandidateId;
  batchId: BatchId;
  reason: "head-moved";
}

model CandidatePromoted {
  _tag: "CandidatePromoted";
  candidateId: CandidateId;
  batchId: BatchId;
  trunkSha: CommitSha;
}

/** One member's commit in a group's composed chain on trunk. */
model MemberCommit {
  changeId: ChangeId;
  commitSha: CommitSha;
}

/** How one member landed: its commit on trunk, the candidate it was verified in, and its batch's proof. */
model MemberLanding {
  changeId: ChangeId;
  commitSha: CommitSha;
  candidateId: CandidateId;
  proofId: string;
}

model TrunkAdvanced {
  _tag: "TrunkAdvanced";
  projectId: ProjectId;
  from: CommitSha;
  to: CommitSha;
  groupId: string;

  /** Every member of the group, in group order, each with its own landing. */
  landings: MemberLanding[];

  /** False when any batch in the group was unverified; absent means every one was verified. */
  verified?: boolean;

  /** Trunk's height after this advance: TrunkInitialized is height 0, and each advance adds 1. */
  @minValue(1)
  height?: integer;
}

/** Why Artifacts would not take a promotion's push: the pack is larger than one request may carry, or it would take the repo past its size quota. */
union PushRefusedReason {
  "pack-too-large",
  "repo-bytes-quota",
}

model PromotionDeclined {
  _tag: "PromotionDeclined";
  projectId: ProjectId;
  batchId: BatchId;

  /** `frozen`: the batch was in the group a freeze stopped, and the operator's resume drops it. `pack-too-large` and `repo-bytes-quota`: the group's push was refused, and trunk did not move. */
  reason: "commutation-failed" | "frozen" | "pack-too-large" | "repo-bytes-quota";

  /** The members to verify again. Empty when a refused push bounces them instead. */
  reverify: ChangeId[];

  /** What the members' agents can do; always set when a push was refused. */
  nextActions?: EventNextAction[];
}

/** Why promotion froze: the head moved under the flush, a recompose disagreed with the recorded SHA, or the read-back head was neither the old nor the composed one. */
union PromotionFrozenReason {
  headMoved: "head-moved",
  recomposeMismatch: "recompose-mismatch",
  readbackMismatch: "readback-mismatch",
}

model PromotionFrozen {
  _tag: "PromotionFrozen";
  projectId: ProjectId;
  groupId: string;
  expected: CommitSha;
  observed: CommitSha;

  /** Always set by the Trunk; optional only so an older event still decodes. */
  reason?: PromotionFrozenReason;
}

model PromotionResumed {
  _tag: "PromotionResumed";
  projectId: ProjectId;
  by: string;

  /** The head the operator confirms trunk is at; optional only so older events still decode. */
  head?: CommitSha;
}

/** A project was created: its trunk, staging, mirror and pool exist, and trunk has its first head. */
model ProjectCreated {
  _tag: "ProjectCreated";
  projectId: ProjectId;
  name: string;
  by: string;

  /** The project this one was forked from, when it is a fork. */
  forkedFrom?: ProjectId;
}

/** A project and its repos are gone, deleted by an owner of its org or with the org. */
model ProjectDeleted {
  _tag: "ProjectDeleted";
  projectId: ProjectId;
  by: UserId;
}

/** One setting an operator changed: its name, and its JSON value before and after. */
model ProjectSettingChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** An operator changed the project's settings: every change is audited, e.g. turning verification off. */
model ProjectSettingsChanged {
  _tag: "ProjectSettingsChanged";
  projectId: ProjectId;
  changes: ProjectSettingChange[];
  by: string;
}

/** An empty project: Keel wrote trunk's first commit itself. */
model TrunkOriginEmpty {
  kind: "empty";
}

/** A public Git repository, imported once. `commit` is trunk's first head. */
model TrunkOriginImported {
  kind: "imported";

  @minLength(1)
  url: string;

  /** The upstream branch that came, by its full ref name. */
  @minLength(1)
  ref: string;

  commit: CommitSha;
}

/** Another project's trunk, forked. `commit` is trunk's first head. */
model TrunkOriginForked {
  kind: "forked";
  project: ProjectId;
  commit: CommitSha;
}

/** A template. `commit` is trunk's first head. */
model TrunkOriginTemplate {
  kind: "template";

  @minLength(1)
  name: string;

  commit: CommitSha;
}

/** Where a project's trunk started, kept for good. Told apart by `kind`. */
union TrunkOrigin {
  empty: TrunkOriginEmpty,
  imported: TrunkOriginImported,
  forked: TrunkOriginForked,
  template: TrunkOriginTemplate,
}

/** The trunk's first known head, from the project's start. Nothing promotes before it. */
model TrunkInitialized {
  _tag: "TrunkInitialized";
  projectId: ProjectId;
  head: CommitSha;
  by: string;

  /** Where that head came from; absent on a trunk initialized before origins were kept. */
  origin?: TrunkOrigin;
}

/** The write-ahead log entry (ADR 0003): the group about to be pushed, written before the compose. */
model PromotionStarted {
  _tag: "PromotionStarted";
  projectId: ProjectId;
  groupId: string;
  old: CommitSha;
  members: ChangeId[];
  batches: BatchId[];
  proofIds: string[];
  committerTime: Instant;
}

/** The group's composed commit, recorded before the first push: every retry pushes this SHA. */
model PromotionComposed {
  _tag: "PromotionComposed";
  projectId: ProjectId;
  groupId: string;
  sha: CommitSha;

  /** Each member's commit in the composed chain, in group order: the commits the members land as. */
  commits: MemberCommit[];
}

model AuditCompleted {
  _tag: "AuditCompleted";
  projectId: ProjectId;
  head: CommitSha;
  outcome: "green" | "red";
  suspects: ChangeId[];
  runRef: string;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

model RulingGiven {
  _tag: "RulingGiven";
  escalationId: EscalationId;

  /** The id of the option chosen. */
  @minLength(1)
  option: string;

  by: string;
  rationale?: string;
}

model DecisionRecorded {
  _tag: "DecisionRecorded";
  decisionId: DecisionId;
  escalationId: EscalationId;

  /** The id of the option the ruling chose. */
  @minLength(1)
  option: string;

  /** The chosen option's label. */
  summary: string;

  scope?: string;
  evidence: string[];
  alternatives: {
    option: string;
    reasonRejected: string;
  }[];
}

model DecisionSuperseded {
  _tag: "DecisionSuperseded";
  decisionId: DecisionId;
  by: DecisionId;
}

model DecisionOverruled {
  _tag: "DecisionOverruled";
  decisionId: DecisionId;
  by: DecisionId;
  requestedBy: ChangeId;
}

model PrecedentSurfaced {
  _tag: "PrecedentSurfaced";
  decisionId: DecisionId;
  changeId: ChangeId;
}

model PrecedentFollowed {
  _tag: "PrecedentFollowed";
  decisionId: DecisionId;
  changeId: ChangeId;
}

model PrecedentDistinguished {
  _tag: "PrecedentDistinguished";
  decisionId: DecisionId;
  changeId: ChangeId;
  distinction: string;
}

model OverruleRequested {
  _tag: "OverruleRequested";
  decisionId: DecisionId;
  changeId: ChangeId;
  argument: string;
}

model TenetEstablished {
  _tag: "TenetEstablished";
  tenetId: TenetId;
  subjectId: SubjectId;
  predicate: MFP.Predicate;
  value: string | float64 | boolean;
  changeId: ChangeId;

  /** At least one: a tenet is a landed effect backed by a guard. */
  @minItems(1)
  guardIds: GuardId[];
}

model TenetContested {
  _tag: "TenetContested";
  tenetId: TenetId;
  conflictId: ConflictId;
}

model TenetReaffirmed {
  _tag: "TenetReaffirmed";
  tenetId: TenetId;
  conflictId: ConflictId;
}

/**
 * A tenet trunk no longer holds: `changeId` landed against it. `conflictId` is
 * the conflict that contested it. `decisionId` is present when a ruling
 * retracted it; without one, the conflict was proven and the project's policy
 * for the predicate let the change land (advise or annotate).
 */
model TenetRetracted {
  _tag: "TenetRetracted";
  tenetId: TenetId;
  changeId: ChangeId;
  conflictId: ConflictId;
  decisionId?: DecisionId;
}

model TenetSuperseded {
  _tag: "TenetSuperseded";
  tenetId: TenetId;
  by: TenetId;
}

model SessionOpened {
  _tag: "SessionOpened";
  sessionId: SessionId;
  agentId: AgentId;
  harness?: string;
  `model`?: string;

  /** The user who sponsors the agent, from its enrolment, when it has one. */
  sponsor?: UserId;
}

model MessagesCaptured {
  _tag: "MessagesCaptured";
  sessionId: SessionId;
  fromSeq: integer;
  toSeq: integer;
  bundleRef: string;
}

model SessionRedacted {
  _tag: "SessionRedacted";
  sessionId: SessionId;
  ranges: {
    fromSeq: integer;
    toSeq: integer;
  }[];
  reason: string;
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/** Who hosts a deploy target. */
union DeployProvider {
  cloudflare: "cloudflare",
}

/** A deploy target's name, unique in its project: what a repo's `.keel/deploy` gives. */
@pattern("^[a-z0-9](?:-?[a-z0-9]){0,38}$")
scalar DeployTargetName extends string;

/** A Cloudflare account's id. */
@pattern("^[0-9a-f]{32}$")
scalar CloudflareAccountId extends string;

/**
 * A place a project deploys to: a provider, the account there and a reference
 * to the credential that reaches it. It names the credential and never holds it.
 */
model DeployTarget {
  name: DeployTargetName;
  provider: DeployProvider;
  accountId: CloudflareAccountId;
  credential: CredentialId;
}

/** An owner set one of the project's deploy targets, new or in place of the one of that name. */
model DeployTargetSet {
  _tag: "DeployTargetSet";
  projectId: ProjectId;
  target: DeployTarget;
  by: UserId;
}

/** An owner removed one of the project's deploy targets. */
model DeployTargetCleared {
  _tag: "DeployTargetCleared";
  projectId: ProjectId;
  name: DeployTargetName;
  by: UserId;
}

model PreviewDeployed {
  _tag: "PreviewDeployed";
  deploymentId: DeploymentId;
  world: string;
  target: DeployTargetName;
  provider: DeployProvider;
  url: string;
}

model PreviewTornDown {
  _tag: "PreviewTornDown";
  deploymentId: DeploymentId;
}

model DeploymentPromoted {
  _tag: "DeploymentPromoted";
  deploymentId: DeploymentId;
  trunkSha: CommitSha;
  target: DeployTargetName;
  provider: DeployProvider;
  stage: string;
}

model DeploymentRolledBack {
  _tag: "DeploymentRolledBack";
  deploymentId: DeploymentId;
  to: string;
  reason: string;
}

// ─── The catalogue ──────────────────────────────────────────────────────────

/** Any event in the catalogue. `_tag` names it. */
union KeelEvent {
  // Identity
  AgentEnrolled,
  AgentSignedUp,
  AgentSuspended,
  AgentReinstated,
  AgentRevoked,
  AgentSponsored,
  AgentUnsponsored,
  UserSignedUp,
  OrgCreated,
  MembershipChanged,
  UserSuspended,
  UserReinstated,
  OrgSuspended,
  OrgReinstated,
  OrgDeleted,

  // Coordination
  IntentDeclared,
  PreflightIssued,
  IntentRevised,
  ChangeStarted,
  PremiseRelied,
  ChangeSubmitted,
  ChangeRebased,
  PrecheckStarted,
  EffectsDerived,
  DriftDetected,
  ChangeDrifted,
  PlanCompiled,
  ChangeQueued,
  ChangeBatched,
  ChangeRequeued,
  ChangeLanded,
  ChangeBounced,
  ConflictNoted,
  AlternativeDeclared,
  AlternativeLanded,
  ChangeParked,
  ChangeResumed,
  ChangeAdopted,
  ChangeWithdrawn,
  ChangeSuperseded,
  LeaseLapsed,
  SubjectMinted,
  PremiseSuspected,
  PremiseReaffirmed,
  SketchOpened,
  SketchPromoted,
  SketchExpired,
  SketchDiscarded,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspaceReassigned,
  WorkspacePushed,
  WorkspaceCollected,

  // Verification
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  WorldCheckRan,
  ProbeDiscarded,
  ConflictProven,
  ConflictDismissed,
  ConflictEscalated,
  ConflictResolved,
  GuardAdmitted,
  GuardRetired,
  GuardFailed,
  VerdictIssued,
  EscalationRaised,
  EscalationWithdrawn,
  EscalationWidened,

  // Integration
  BatchFormed,
  CandidateAssembled,
  VerificationStarted,
  BatchVerified,
  BatchFailed,
  CandidateBisected,
  CandidateInvalidated,
  CandidatePromoted,
  TrunkAdvanced,
  PromotionDeclined,
  PromotionFrozen,
  PromotionResumed,
  TrunkInitialized,
  PromotionStarted,
  PromotionComposed,
  AuditCompleted,
  ProjectCreated,
  ProjectDeleted,
  ProjectSettingsChanged,

  // Memory
  RulingGiven,
  DecisionRecorded,
  DecisionSuperseded,
  DecisionOverruled,
  PrecedentSurfaced,
  PrecedentFollowed,
  PrecedentDistinguished,
  OverruleRequested,
  TenetEstablished,
  TenetContested,
  TenetReaffirmed,
  TenetRetracted,
  TenetSuperseded,
  SessionOpened,
  MessagesCaptured,
  SessionRedacted,

  // Delivery
  DeployTargetSet,
  DeployTargetCleared,
  PreviewDeployed,
  PreviewTornDown,
  DeploymentPromoted,
  DeploymentRolledBack,
}
