# State machines

Each entity below is owned by one Durable Object, which is its source of truth. Every transition commits the new state and exactly one event (see [events.md](events.md)) in one `transactionSync`. A transition is triggered by a **command** (an API call or a Workflow step calling the owning DO) or by **another entity's event**, in which case the new event's `causation` names it.

Each machine reaches **exactly one terminal state** per run, and replaying an entity's events in `seq` order rebuilds its state. These two properties are property-tested in the domain tier.

Terms are in [CONTEXT.md](../../CONTEXT.md).

---

## Change

Owner: Change DO (`change:<ULID>`).

```mermaid
stateDiagram-v2
  [*] --> Declared: IntentDeclared
  Declared --> Working: WorkspaceGranted
  Working --> Working: IntentRevised / PremiseRelied
  Working --> Submitted: ChangeSubmitted
  Submitted --> Deriving: PrecheckStarted
  Deriving --> Drifted: ChangeDrifted
  Deriving --> Bounced: ChangeBounced
  Deriving --> Verifying: PlanCompiled
  Drifted --> Working: IntentRevised
  Verifying --> Queued: ChangeQueued
  Verifying --> Bounced: ChangeBounced
  Verifying --> Parked: ChangeParked
  Queued --> Integrating: ChangeBatched
  Integrating --> Queued: ChangeRequeued
  Integrating --> Bounced: ChangeBounced
  Integrating --> Landed: ChangeLanded
  Bounced --> Working: IntentRevised
  Bounced --> Submitted: ChangeSubmitted
  Parked --> Verifying: ChangeResumed
  Parked --> Bounced: ChangeBounced
  Parked --> Working: ChangeAdopted
  Landed --> [*]
  Withdrawn --> [*]
  Superseded --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Declared | `declare` | Scope `agent:work` | `IntentDeclared` (lease issued), then `PreflightIssued` |
| Declared | Working | WorkspacePool grants a workspace | — | `WorkspaceGranted` (pool), recorded on the change |
| Working | Working | `revise` / `rely` | Valid lease; `If-Match` on the current revision | `IntentRevised` / `PremiseRelied` |
| Working, Bounced | Submitted | `submit {changeId, commitSha}` | Valid lease; the commit is in the change's workspace | `ChangeSubmitted` |
| Submitted | Deriving | Precheck instance created | — | `PrecheckStarted` |
| Deriving | Bounced | Precheck: a protected or guard path is touched | — | `ChangeBounced` |
| Deriving | Drifted | Precheck: drift needs the agent (an undeclared proof-class effect) | — | `ChangeDrifted` |
| Deriving | Verifying | Precheck: effects derived, drift classified, plan compiled | — | `EffectsDerived`, `DriftDetected`, then `PlanCompiled` |
| Drifted, Bounced | Working | `revise` | Valid lease | `IntentRevised` |
| Verifying | Queued | The plan's pre-queue steps pass and no Proven conflict is open | — | `ChangeQueued` |
| Verifying | Bounced | A conflict is proven against the change, or a guard fails | — | `ChangeBounced` |
| Verifying | Parked | A human-class conflict or step | — | `ChangeParked {reason: awaiting-ruling}` |
| Queued | Integrating | Caused by `BatchFormed` | — | `ChangeBatched` |
| Integrating | Queued | Caused by `BatchFailed` (infra), `CandidateBisected` or `CandidateInvalidated` | Two infra failures requeue with no blame | `ChangeRequeued` |
| Integrating | Bounced | Caused by `BatchFailed` attributed to this change | — | `ChangeBounced` |
| Integrating | Landed | Caused by `TrunkAdvanced` | No open Proven conflict, no failing guard, no unresolved high-severity drift | `ChangeLanded` |
| Parked | Verifying | Caused by `RulingGiven` | — | `ChangeResumed` |
| Parked | Bounced | Caused by `RulingGiven` choosing to bounce | — | `ChangeBounced` |
| Parked (lease lapsed) | Working | `adopt` by another agent | — | `ChangeAdopted` (new lease, old one fenced) |
| Declared, Working, Drifted, Bounced | Parked | The lease's deadline alarm | The lease lapsed: 15 minutes since `renewedAt` | `LeaseLapsed`, then `ChangeParked {reason: lease-lapsed}` |
| any but Integrating and terminal | Withdrawn | `abandon` | Valid lease, or `operator` | `ChangeWithdrawn` |
| any but Integrating and terminal | Superseded | A ruling chooses an alternative that landed | — | `ChangeSuperseded` |

**Terminal:** Landed, Withdrawn, Superseded.

**Invariants**
- Trunk advances only through the Trunk DO; no agent ever holds a trunk token.
- A change cannot land with an open Proven conflict, a failing guard, or unresolved high-severity drift.
- Effects used in any verdict are derived by Keel, never taken from the agent.
- A lapse parks only the states the agent owns. In Integrating the change belongs to its batch, so withdrawal waits until the batch resolves.
- Every landed change has an Intent revision, a Session link and a Verdict with evidence.

---

## Lease

Owner: Change DO. A Lease is a permit to act on a Change, carrying a server-minted fencing token (`lse_…`). It is never exclusive over files.

```mermaid
stateDiagram-v2
  [*] --> Active: IntentDeclared / ChangeAdopted
  Active --> Active: any authorised call (renewal)
  Active --> Lapsed: LeaseLapsed
  Lapsed --> Superseded: ChangeAdopted
  Active --> Released: change reaches a terminal state
  Released --> [*]
  Superseded --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Active | `declare` or `adopt` | — | `IntentDeclared` / `ChangeAdopted` carry the `leaseId` |
| Active | Active | Any MCP or REST call on the change, or the agent's hook | The call carries this `leaseId` | none: `renewedAt` is state, not an event |
| Active | Lapsed | The deadline alarm at `renewedAt + 15 min` | No renewal since | `LeaseLapsed` |
| Lapsed | Superseded | `adopt` | — | `ChangeAdopted` (the new lease's token fences the old) |
| Active | Released | The change lands, is withdrawn or is superseded | — | the change's terminal event |

**Terminal:** Released, Superseded.

**Invariants**
- Every mutating call on a change carries its `leaseId`; a call with a stale token is refused with next actions. "No lease" is never permission.
- Whether a lease has lapsed is computed on read; the alarm only makes the lapse visible as an event. It is a deadline, never a polling loop.

---

## Conflict

Owner: Subject DO (`subj:<project>:<key>`). Kinds: textual, footprint, semantic, precedent.

```mermaid
stateDiagram-v2
  [*] --> Suspected: ConflictSuspected
  Suspected --> Probing: ProbeDrafted
  Suspected --> Proven: ConflictProven
  Suspected --> Dismissed: ConflictDismissed
  Probing --> Probing: ProbeDrafted (repair, ≤3)
  Probing --> Proven: ConflictProven
  Probing --> Dismissed: ConflictDismissed
  Probing --> Escalated: ConflictEscalated
  Proven --> Resolved: ConflictResolved
  Proven --> Escalated: ConflictEscalated
  Escalated --> Resolved: ConflictResolved
  Resolved --> [*]
  Dismissed --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Suspected | Fallout: a same-key contradiction with intersecting scope, or a silent retraction; or a batch interaction failure | Proximity alone never opens a conflict | `ConflictSuspected` |
| Suspected | Proven | A refused merge (textual) or a failing guard (precedent): proof without a probe | — | `ConflictProven` |
| Suspected | Dismissed | A deterministic lattice comparison shows the propositions are compatible (a ruling) | — | `ConflictDismissed` |
| Suspected | Probing | A probe is drafted | — | `ProbeDrafted` |
| Probing | Proven | The probe discriminates | It passes on trunk (or does not apply), passes in the premise-holder's world, fails in the combined world, three runs in a row | `ConflictProven` |
| Probing | Dismissed | The probe gives the same answer in every world | — | `ProbeDiscarded`, then `ConflictDismissed` |
| Probing | Escalated | Three drafts fail: the conflict is unprovable | — | `ConflictEscalated {reason: unprovable}` |
| Proven | Escalated | The conflict is human-class | Permission semantics, destructive migrations, ambiguous requirements | `ConflictEscalated {reason: human-class}` |
| Proven | Resolved | A Move is applied (bounce, sequence, yield, merge, distinguish…) | — | `ConflictResolved` |
| Escalated | Resolved | Caused by `RulingGiven` | — | `ConflictResolved` (with `decisionId`) |

**Terminal:** Resolved, Dismissed.

**Invariants**
- Only proof or a ruling moves a conflict to Proven or Dismissed. An unprovable conflict is opinion, and it escalates rather than blocking.
- A dismissal is recorded as evidence, so the same alarm is not raised again on the same facts.

---

## Probe → Guard

Owner: Subject DO. A Probe is drafted for one conflict; if it proves the disagreement it is admitted as a Guard in the guard repo, which agents cannot write to.

```mermaid
stateDiagram-v2
  [*] --> Drafting
  Drafting --> Drafting: repair attempt (≤3)
  Drafting --> Calibrating: ProbeDrafted
  Drafting --> Discarded: ProbeDiscarded (draft-failed)
  Calibrating --> Admitted: GuardAdmitted
  Calibrating --> Discarded: ProbeDiscarded
  Admitted --> Retired: GuardRetired
  Discarded --> [*]
  Retired --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Drafting | `ConflictSuspected` needs a probe | — | none: drafting is a `PlatformFunction` call inside a step |
| Drafting | Drafting | The draft fails to compile or run; deterministic error text drives a repair | Attempts ≤ 3 | none |
| Drafting | Calibrating | A draft compiles and runs | — | `ProbeDrafted` |
| Drafting | Discarded | Three attempts failed | — | `ProbeDiscarded {reason: draft-failed}` |
| Calibrating | Admitted | The world matrix shows discrimination | Passes on trunk (or does not apply), passes in the premise-holder's world, fails in the combined world, stable over 3 runs | `GuardAdmitted` |
| Calibrating | Discarded | Not discriminating, or unstable | — | `ProbeDiscarded` |
| Admitted | Retired | A superseding Decision | — | `GuardRetired` |

**Terminal:** Discarded, Retired. (An admitted Guard stays Admitted, guarding trunk, until a Decision retires it.)

**Invariants**
- A drafted probe is opinion until it discriminates.
- Only guards block on behalf of past decisions; a change whose diff touches guard paths is refused at Precheck.

---

## Candidate

Owner: Lane DO (`lane:<project>:<id>`). A **Batch** is a set of Changes verified together; its **Candidate** is the tree composed for one attempt. They are one-to-one per attempt, so the batch events are the candidate's transitions. Promotion onto trunk belongs to the Trunk DO (below).

```mermaid
stateDiagram-v2
  [*] --> Forming: BatchFormed
  Forming --> Assembled: CandidateAssembled
  Assembled --> Verifying: VerificationStarted
  Verifying --> Green: BatchVerified
  Verifying --> Red: BatchFailed
  Red --> Bisected: CandidateBisected
  Green --> Promoted: CandidatePromoted
  Green --> Invalidated: CandidateInvalidated
  Promoted --> [*]
  Invalidated --> [*]
  Bisected --> [*]
  Red --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Forming | The lane forms a batch | N = clamp(ln 0.8 / ln(1−p), 1, 16); no two members with an open suspected conflict or opposite effects on one subject; risky changes alone; speculation ≤ 4 deep | `BatchFormed` |
| Forming | Assembled | GitCore composes the tree (Tier 0), or MergeBox when GitCore refuses (Tier 2) | — | `CandidateAssembled` (with tier and reason) |
| Assembled | Verifying | KeelVerify instance created | — | `VerificationStarted` |
| Verifying | Green | The union of the members' plans passes | Results fenced on `(batchId, attempt, chainEpoch)` | `BatchVerified` |
| Verifying | Red | A step fails after a flake rerun | — | `BatchFailed` (with attribution) |
| Red | Bisected | More than one member, and the failure is not yet attributed | — | `CandidateBisected` (new batches) |
| Green | Promoted | Caused by `TrunkAdvanced` | — | `CandidatePromoted` |
| Green | Invalidated | Trunk moved and the commutation rule fails | — | `CandidateInvalidated` |

**Terminal:** Promoted, Invalidated, Bisected, Red (a single attributed member, which bounces).

**Invariants**
- A batch that GitCore and MergeBox both refuse to compose is a proven textual conflict.
- Every step records its tier and the reason it was chosen. An escalation to a higher tier is sticky and visible.

### Promotion (Trunk DO)

Owner: Trunk DO (`trunk:<project>`), the one writer of trunk ([ADR 0003](../adr/0003-trunk-single-writer-wal.md)).

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Debouncing: BatchVerified arrives
  Debouncing --> Promoting: debounce deadline (~100 ms)
  Promoting --> Promoting: head still old → retry same SHA
  Promoting --> Idle: TrunkAdvanced
  Promoting --> Frozen: PromotionFrozen
  Frozen --> Idle: PromotionResumed
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| Idle | Debouncing | A `BatchVerified` arrives | — | none: the debounce alarm is armed (a named debounce) |
| Debouncing | Promoting | The debounce deadline fires | The commutation rule (C1–C6) holds for every member of the group | none: the WAL entry `PendingGroup {old, members, committerTime}` is written |
| Promoting | Promoting | Read-back shows the head is still `old` | — | none: the push is retried with the same SHA |
| Promoting | Idle | Read-back shows the head is `new` | — | `TrunkAdvanced` |
| Promoting | Frozen | Read-back shows any other head | — | `PromotionFrozen` |
| Frozen | Idle | An operator releases the freeze | Scope `operator` | `PromotionResumed` |

**Invariants**
- The compose is deterministic, so a retry produces the same SHA.
- Artifacts' own compare-and-swap, if it exists, is a second fence and never the only one.

---

## Decision

Owner: Subject DO. A Decision is a recorded ruling. Later changes meet it as a Precedent and record a Stance.

```mermaid
stateDiagram-v2
  [*] --> Active: DecisionRecorded
  Active --> Superseded: DecisionSuperseded
  Active --> Overruled: DecisionOverruled
  Superseded --> [*]
  Overruled --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Active | Caused by `RulingGiven` on an escalation | — | `DecisionRecorded` |
| Active | Superseded | A later decision with the same or wider scope | — | `DecisionSuperseded` |
| Active | Overruled | `OverruleRequested`, escalated, and ruled in favour | — | `DecisionOverruled` |

**Stances** do not change a Decision's state; each is a fact about a change: `PrecedentSurfaced` (preflight showed it), then `PrecedentFollowed`, `PrecedentDistinguished` or `OverruleRequested`.

**Terminal:** Superseded, Overruled.

**Invariants**
- A precedent never blocks by itself; only guards do. A Decision carries its date, scope, evidence and the alternatives it rejected.

---

## Tenet

Owner: Subject DO. A Tenet is a belief trunk currently holds: an effect that has landed and is backed by at least one guard.

```mermaid
stateDiagram-v2
  [*] --> Established: TenetEstablished
  Established --> Contested: TenetContested
  Contested --> Established: TenetReaffirmed
  Contested --> Retracted: TenetRetracted
  Established --> Superseded: TenetSuperseded
  Retracted --> [*]
  Superseded --> [*]
```

| From | To | Trigger | Guard | Event |
|---|---|---|---|---|
| — | Established | Caused by `ChangeLanded` | The landed effect is backed by at least one admitted guard | `TenetEstablished` |
| Established | Contested | A change's effect contradicts the tenet | — | `ConflictSuspected` (tenet as party), then `TenetContested` |
| Contested | Established | The conflict is dismissed or resolved in the tenet's favour | — | `TenetReaffirmed` |
| Contested | Retracted | A ruled change lands that removes the belief | A ruling, never opinion | `TenetRetracted` |
| Established | Superseded | A new tenet on the same `(subject, predicate)` replaces it | — | `TenetSuperseded` |

**Terminal:** Retracted, Superseded.

**Invariants**
- New code that calls a symbol carrying a tenet is subscribed to that tenet automatically (an implied premise).

---

## Agent

Owner: identity. Kinds: interactive, hosted, human.

```mermaid
stateDiagram-v2
  [*] --> Active: AgentEnrolled
  Active --> Suspended: AgentSuspended
  Suspended --> Active: AgentReinstated
  Active --> Revoked: AgentRevoked
  Suspended --> Revoked: AgentRevoked
  Revoked --> [*]
```

**Terminal:** Revoked. Revocation bumps the agent's revocation epoch, so every token minted before it fails verification.

**Invariant:** declaration fidelity routes review; it never judges the agent.

---

## Sketch

Owner: WorkspacePool DO.

```mermaid
stateDiagram-v2
  [*] --> Open: SketchOpened
  Open --> Promoted: SketchPromoted
  Open --> Expired: SketchExpired
  Open --> Discarded: SketchDiscarded
  Promoted --> [*]
  Expired --> [*]
  Discarded --> [*]
```

**Terminal:** Promoted, Expired, Discarded. A sketch has no intent, no preflight and no integration; `SketchExpired` is raised by its TTL deadline alarm.

---

## Workspace

Owner: WorkspacePool DO. A Workspace is the throwaway Artifacts repo a Change or Sketch is worked in.

```mermaid
stateDiagram-v2
  [*] --> Ready: WorkspaceForked
  Ready --> Granted: WorkspaceGranted
  Granted --> Collected: WorkspaceCollected
  Ready --> Collected: WorkspaceCollected
  Collected --> [*]
```

**Terminal:** Collected.

**Invariants**
- A ready workspace is handed out exactly once.
- Fork readiness comes from the `repo.forked` event, never from polling.
