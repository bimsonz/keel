# Event catalogue

Every state change in Keel is an event: a fact, named as a past-tense verb, committed in the same `transactionSync` as the state it describes, in the outbox of the Durable Object that owns that state. The outbox fans each event out to subscribed DOs (RPC), the operation log (K2, then the R2 archive) and Queues ([ADR 0009](../adr/0009-event-driven-outbox.md)). Nothing polls.

Events are **facts**. Claims (what an agent intends, relies on or decided, and what Keel derived) are MFP records, which cite events but are not events.

Terms are in [CONTEXT.md](../../CONTEXT.md); each entity's lifecycle is in [state-machines.md](state-machines.md).

## Envelope

Every event has the same envelope:

| Field | Meaning |
|---|---|
| `eventId` | `evt_<ULID>`. Unique across Keel |
| `type` | The event name, e.g. `ChangeSubmitted` |
| `entity` | `{kind, id}`: the entity whose state changed. Its owning DO emitted the event |
| `seq` | Per-entity sequence number, gap-free. Replaying an entity's events in `seq` order rebuilds its state |
| `at` | When the transaction committed |
| `dedupeKey` | Stable across retries of the same cause, so a redelivered command or event is a no-op |
| `causation` | Optional. The `eventId` that triggered this transition, when another entity's event did |
| `project` | Optional. The project the emitting entity belongs to. Every Keel DO sets it; the Projector numbers what each project creates (`#n`, `D-n`, `G-n`, `C-n`, `E-n`, `P-n`) by it |
| `actor` | Optional. The principal whose command caused the event: `agent:<agentId>` or `operator:<name>`. Absent when the platform caused it (Precheck, an alarm, a reaction, the Lane landing a change). An agent is never notified of an event it caused |
| `affected[]` | Entity refs (`{kind, id}`) whose state this event changes or invalidates, beyond `entity` itself. A subscriber learns what the event released without re-querying |
| `notified[]` | Subscriber refs the emitter delivered this event to, computed at commit time from its subscription table (e.g. `agent:agt_…`, `lane:<project>:<lane>`, `trunk:<project>`, `workflow:Precheck`) |
| `payload` | The fields listed for each event below |

**One transition, one event.** An entity's transition is triggered by a command or by another entity's event. Either way the entity commits exactly one event of its own, named for the transition, with `causation` set when an event caused it. Events that record a fact without changing their entity's lifecycle (`DriftDetected`, `GuardFailed`, `PreflightIssued`) are called out as such.

**Entity kinds:** `agent`, `session`, `change`, `subject`, `sketch`, `workspace`, `conflict`, `probe`, `guard`, `verdict`, `batch`, `candidate`, `project`, `trunk`, `decision`, `tenet`, `escalation`, `deployment`.

**ID prefixes.** From the API contract: `agt_ ses_ chg_ wsp_ sk_ sub_ cnd_ vrd_ cfl_ dec_ prb_`. Added here for entities the API does not yet expose: `evt_` (event), `bat_` (batch), `grd_` (guard), `tnt_` (tenet), `lse_` (lease), `esc_` (escalation), `dpl_` (deployment).

---

## identity

The AgentSession DO (`agent:<id>`) is the source of truth for an agent. D1's `AgentDirectory` is a projected index of it (client-credential hash → agent), fed from these events.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `AgentEnrolled` | AgentSession DO (operator command) | `agentId, projectId, name, kind: interactive\|hosted\|human\|synthetic, scopes[], onBehalfOf?` (the sponsor, a `scheme:value` address) | — | Projector | Catalog row created |
| `AgentSuspended` | AgentSession DO (operator command) | `agentId, reason, by` | the agent's open changes | the agent's AgentSession DO, Projector | Token exchange and every call refused until reinstated; its leases stop renewing |
| `AgentReinstated` | AgentSession DO (operator command) | `agentId, by` | — | the agent's AgentSession DO, Projector | Calls accepted again |
| `AgentRevoked` | AgentSession DO (operator command) | `agentId, revocationEpoch, by` | the agent's open changes, its leases | the agent's AgentSession DO, Projector | Revocation epoch bumped, so every token minted before it is rejected; its changes park for adoption |

## coordination

### Changes

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `IntentDeclared` | Change DO | `changeId, agentId, origin: agent\|auditor\|operator, sketchId?, revision: 1, goal, footprint, premises[], leaseId` | each Subject relied on | Subject DOs relied on, the agent | The change is subscribed to each subject it relies on ("relying is subscribing"); preflight runs. `origin: auditor` marks the Auditor's auto-revert, a platform-authored change that lands like any other |
| `PreflightIssued` | Change DO (fact) | `changeId, revision, neighbours[], contradictions[], precedents[], suggestedMove` | — | the agent | The agent sees overlap, contradictions, precedents and a Move before writing code. Footprint overlap is *exposure* and appears only in `neighbours`: proximity never opens a conflict |
| `ChangeStarted` | Change DO | `changeId, workspaceId, baseSha` | — | the agent | Caused by `WorkspaceGranted` or `SketchPromoted`: Declared → Working, in that workspace. `baseSha` is the workspace's head at grant, the base Precheck diffs against |
| `IntentRevised` | Change DO | `changeId, revision, goal?, footprint?, premisesAdded[], premisesRetracted[]` | Subjects whose premises changed | Subject DOs touched, the agent | Subscriptions follow the premises; preflight re-runs |
| `PremiseRelied` | Subject DO | `subjectId, changeId, premise: {predicate, relation, value, scope}` | — | the change's agent | The Subject DO's reaction to a change's `rely`, which the Change DO commits as `IntentRevised {premisesAdded: [premise]}`. The holder is notified of later fallout on this subject |
| `ChangeSubmitted` | Change DO | `changeId, revision, commitSha, workspaceId` | — | `workflow:Precheck`, the change's lane | **Starts Precheck.** The authoritative signal: push events only observe |
| `PrecheckStarted` | Change DO | `changeId, revision, instanceId` | — | Projector | The console follows the instance |
| `EffectsDerived` | Change DO (recorded from Precheck) | `changeId, revision, effects[], derivationRef`; each effect is `{proposition, method, evidenceClass, p?, anchors (≥ 1), declared, contradicts?}` | Subjects altered | Subject DOs altered | Fallout runs on each altered subject; `derivationRef` points at Keel's derivation record. The method fixes the class: `extractor` is a ruling with no `p`; `clef` is opinion with `p` in [0, 1]; `code-model` is opinion with an optional `p`. No derived effect is proof or testimony |
| `DriftDetected` | Change DO (fact) | `changeId, revision, drift: [{class: footprint\|undeclared-effect\|silent-retraction, severity, detail}]` | — | the agent | Footprint drift is a notice; an undeclared effect is a notice that blocks only if proof-class; a silent retraction opens a Conflict |
| `ChangeDrifted` | Change DO | `changeId, revision, blocking: drift[]` | — | the agent | The agent must declare or revise before the change continues |
| `PlanCompiled` | Change DO (recorded from Precheck) | `changeId, revision, planHash, steps, costEstimate` | — | Projector | The Verification Plan runs |
| `ChangeQueued` | Change DO | `changeId, laneId` | the lane | Lane DO | The lane enqueues the change for batching |
| `ChangeBatched` | Change DO | `changeId, batchId` | — | the agent | Caused by `BatchFormed` |
| `ChangeRequeued` | Change DO | `changeId, batchId, reason: infra-failure\|bisection\|invalidated` | the lane | Lane DO | Re-enters the lane with no blame |
| `ChangeLanded` | Change DO | `changeId, commitSha, trunkSha, candidateId, proofId` | Subjects altered, the workspace | Subject DOs, the agent, WorkspacePool DO, Projector | Caused by `TrunkAdvanced`. Trailers and the MFP note are written; tenets are established; the workspace is collected; `Deployer` promotion begins |
| `ChangeBounced` | Change DO | `changeId, verdictId, reasons[], nextActions[]` | — | the agent | The agent fixes and resubmits. `nextActions` is never empty |
| `ChangeParked` | Change DO | `changeId, reason: awaiting-ruling\|lease-lapsed, escalationId?` | — | the agent | Waits for a ruling, or for adoption |
| `ChangeResumed` | Change DO | `changeId, decisionId` | — | the agent | Caused by `RulingGiven`; verification continues |
| `ChangeAdopted` | Change DO | `changeId, previousAgentId, agentId, leaseId, briefRef` | the previous lease | both agents | Re-leased under the same Change-Id with a cold-start brief |
| `ChangeWithdrawn` | Change DO | `changeId, by, reason?` | the workspace, subscriptions | Subject DOs relied on, Lane DO, WorkspacePool DO | Subscriptions dropped; workspace collected |
| `ChangeSuperseded` | Change DO | `changeId, by: changeId, decisionId?` | the workspace, subscriptions | Subject DOs relied on, Lane DO, WorkspacePool DO | An alternative landed instead: by a ruling, or by policy, when the alternative retracting a tenet loses automatically (then caused by the winner's `ChangeLanded`) |
| `LeaseLapsed` | Change DO | `changeId, leaseId, renewedAt` | — | the agent | Raised by the lease's deadline alarm, 15 minutes after the last renewal. Parks the change if it is in a state the agent owns |

### Subjects and premises

The Project DO (`project:<id>`) holds the subject registry (keys, aliases, anchors), so minting is replayable; each Subject DO holds that subject's premises, tenets and decisions.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `SubjectMinted` | Project DO | `subjectId, key, anchors[], gloss, mintedBy: scan\|clef\|agent` | — | Projector | Normalisation found no existing subject for a proposition; the new subject joins the registry |
| `PremiseSuspected` | Subject DO | `subjectId, changeId (holder), premise, cause: {changeId, effect}` | the holder's change | the holder's agent | Fallout's *suspect* outcome: the holder re-affirms or revises |
| `PremiseReaffirmed` | Subject DO | `subjectId, changeId, premise` | — | Projector | The suspicion is cleared |

### Sketches and workspaces

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `SketchOpened` | WorkspacePool DO | `sketchId, agentId, workspaceId, expiresAt` | the workspace | the agent | No intent, no preflight, no integration |
| `SketchPromoted` | WorkspacePool DO | `sketchId, changeId` | — | the agent | `declare --from-sketch`: the workspace carries over to the new change |
| `SketchExpired` | WorkspacePool DO | `sketchId` | the workspace | the agent | Raised by the TTL deadline alarm; the workspace is collected |
| `SketchDiscarded` | WorkspacePool DO | `sketchId, by` | the workspace | — | The agent dropped the idea |
| `WorkspaceForked` | WorkspacePool DO | `workspaceId, repo, sourceRepo` | — | — | Emitted when the pool's own fork call resolves; a fork is ready at once (spike S2). The fork joins the ready pool |
| `WorkspaceGranted` | WorkspacePool DO | `workspaceId, changeId\|sketchId, expiresAt, baseSha` | — | the change or sketch, the agent | Handed out exactly once; a retried grant for the same holder re-mints the write token, which is never stored or carried in the event. `baseSha` is the workspace's head at grant time, the change's base |
| `WorkspaceReassigned` | WorkspacePool DO | `workspaceId, sketchId, changeId` | — | the agent | `declare --from-sketch`: the promoted sketch's workspace passes to the change it became, in the same transaction as `SketchPromoted`. Once, and never to a third holder |
| `WorkspacePushed` | WorkspacePool DO (fact) | `workspaceId, ref, sha` | — | the change's agent | Translated from Artifacts' `pushed` by the PushObserved Workflow, for branch updates only. Observes plain-git agents; never authoritative |
| `WorkspaceCollected` | WorkspacePool DO | `workspaceId, reason: landed\|withdrawn\|expired` | — | — | The repo is deleted |

## verification

**Conflicts are owned by kind.** The Subject DO owns `semantic` and `precedent` conflicts. `textual` (a refused merge) and `interaction` (every subset of a batch passes, the union fails) conflicts have no subject, so the Lane DO owns them. A conflict's probes, guards and escalations belong to the DO that owns the conflict; "Subject DO" below means "the conflict's owner" for those events.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `ConflictSuspected` | Subject DO or Lane DO (by kind) | `conflictId, kind: textual\|semantic\|precedent\|interaction, parties: (changeId\|tenetId)[], subjectId?, predicate?, origin?: fallout\|opinion` (subject present for `semantic` and `precedent`; absent `origin` is `fallout`) | each party | the parties' agents | A probe is drafted, unless the kind is proven directly (a refused merge, a failing guard, a union that fails while every subset passes). An `opinion` suspicion is a decision model's: no lattice comparison dismisses it, only its probe or a person |
| `ProbeDrafted` | Subject DO | `probeId, conflictId, attempts (≤3), bundleHash` | — | — | The probe entity begins here, for a Suspected conflict with no probe, which moves to Probing. The world matrix runs it on trunk, in A, B and A+B, and in A-noop |
| `WorldCheckRan` | Subject DO (fact) | `conflictId, world: trunk\|A\|B\|AB\|A-noop, check: suite:<changeId>, run: 1..3, outcome: pass\|fail\|n/a, counts?: {passed, failed, skipped}, reason?` (`reason` required for n/a) | — | Projector | One cell of the world matrix filled by a project's suite rather than the probe. The conflict stays Probing; the same cell again commits nothing, and a different answer for it is refused |
| `ProbeRan` | Subject DO (fact) | `probeId, conflictId, world: trunk\|A\|B\|AB\|A-noop, run: 1..3, outcome: pass\|fail\|n/a, resultRef` | — | Projector | One cell of the world matrix. `A-noop` is the premise-holder's world with the premised behaviour removed, built from the probe template's recipe. Admission is computed from these, and Conflict Theatre fills the matrix from them |
| `ProbeDiscarded` | Subject DO | `probeId, reason: non-discriminating\|unstable\|draft-failed, conflictId` | the conflict | — | A non-discriminating probe dismisses the conflict; an unstable one, or three failed drafts, make it unprovable. With `draft-failed` it is the probe's first and only event |
| `ConflictProven` | Subject DO | `conflictId, evidence: {probeId\|guardId\|mergeRefusal\|interaction: batchId}` | each party | the parties' agents, the lane | The change bounces with evidence, or escalates if human-class. Proof without a probe matches the kind: a refused merge proves a textual conflict, a failing guard a precedent one, a failing union an interaction one |
| `ConflictDismissed` | Subject DO | `conflictId, evidence` | each party | the parties' agents | The dismissal is recorded as evidence: `lattice:compatible\|refines` (the domain's own comparison of the premise and the effect) or `probe:<probeId>:non-discriminating` |
| `ConflictEscalated` | Subject DO | `conflictId, escalationId, reason: human-class\|unprovable` | each party | the escalation inbox | The parties park until a ruling |
| `ConflictResolved` | Subject DO | `conflictId, move, decisionId?` | each party | the parties' agents | The chosen Move applies |
| `GuardAdmitted` | Subject DO | `guardId, probeId, conflictId, runs: 3` | the guard repo | the parties' agents | Computed from `ProbeRan`: the probe passed on trunk (or did not apply), passed in the premise-holder's world, failed in the combined world and failed in A-noop, three times. It now guards trunk |
| `GuardRetired` | Subject DO | `guardId, decisionId` | the guard repo | — | Only a superseding Decision retires a guard |
| `GuardFailed` | Lane DO or Change DO (fact) | `guardId, batchId?, candidateId?, changeId?, world` (a change, or a batch and its candidate) | the batch, or the change | — | Proof against the candidate, or at Precheck against the change itself; feeds its verdict |
| `VerdictIssued` | Change DO or Lane DO | `verdictId, subject: changeId\|batchId, outcome: land\|bounce\|park\|hold\|supersede, evidence[], planHash?, verified?` | the change or batch | the agent(s) | Every step result is part of the evidence. `planHash` always resolves to a plan; it is absent only for a Precheck refusal, a ruling-class verdict reached before any plan was compiled. `verified: false` when the project's verification is off and the plan was not run; absent means true |
| `EscalationRaised` | the raising DO | `escalationId, question, options[], consequences[], about: entity ref` | — | the escalation inbox | A person is asked; the default while open is *hold* |
| `EscalationWithdrawn` | the raising DO | `escalationId, reason` | — | the escalation inbox | Its subject was resolved some other way before a ruling |

## integration

A **Batch** is a set of Changes verified together; its **Candidate** is the composed tree for one attempt.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `BatchFormed` | Lane DO | `batchId, laneId, members: changeId[], base, attempt, chainEpoch, projectId, predecessors: changeId[]` | each member change | member Change DOs, `workflow:KeelVerify` | **Starts KeelVerify.** Never contains two changes with an open suspected conflict or opposite effects on one subject |
| `CandidateAssembled` | Lane DO | `candidateId, batchId, treeSha, composer: gitcore\|mergebox, tier, tierReason` | — | Projector | The candidate is bundled to R2 |
| `VerificationStarted` | Lane DO | `candidateId, batchId, instanceId, planHash` | — | Projector | The union of the members' plans runs across the tiers |
| `BatchVerified` | Lane DO | `batchId, candidateId, verdictId, members: changeId[], base, predecessors: changeId[], verified?` | — | Trunk DO | **Trunk promotion debounces.** `verified` is the batch verdict's, carried unchanged into the Trunk DO's queue and WAL entry. Late results are fenced on `(batchId, attempt, chainEpoch)`; a fenced result is never retried. The Trunk DO records the event it receives and folds it into its state |
| `BatchFailed` | Lane DO | `batchId, candidateId?, verdictId, attribution: changeId\|textual\|interaction\|infra\|unattributed` | each member change | member Change DOs | Flake rerun, then attribution, then bisection. `textual`: GitCore and MergeBox both refused to compose, a proven textual conflict. `interaction`: every subset passes and the union fails, an interaction conflict. Both are owned by the Lane DO. `unattributed`: a failure of several members that attribution could not pin; only it is bisected |
| `CandidateBisected` | Lane DO | `candidateId, batchId, into: batchId[]` | each member change | member Change DOs | Leave-one-out or a 4-way split |
| `CandidateInvalidated` | Lane DO | `candidateId, batchId, reason: head-moved` | each member change | member Change DOs | Caused by `PromotionDeclined`; only the intersection is re-verified |
| `CandidatePromoted` | Lane DO | `candidateId, batchId, trunkSha` | — | — | Caused by `TrunkAdvanced` |
| `ProjectCreated` | Project DO (`project:<id>`) | `projectId, name, by` | — | Projector | The project exists; its trunk, lanes and subject registry are keyed by `projectId` from here on. The trunk still waits for `TrunkInitialized` |
| `ProjectSettingsChanged` | Project DO (`project:<id>`) | `projectId, changes: [{field, from, to}], by` | — | Projector | An operator changed the project's settings; each changed field is recorded with its value before and after, so a switch such as turning verification off is audited |
| `TrunkInitialized` | Trunk DO | `projectId, head, by` | — | Projector | The trunk's first known head, from the project's seed or an operator. Nothing is queued or promoted before it |
| `PromotionStarted` | Trunk DO | `projectId, groupId, old, members: changeId[], batches: batchId[], proofIds[], committerTime` | — | Projector | The write-ahead log entry ([ADR 0003](../adr/0003-trunk-single-writer-wal.md)), committed with the batches' declines. Resolved by exactly one `TrunkAdvanced` or `PromotionFrozen` |
| `PromotionComposed` | Trunk DO | `projectId, groupId, sha` | — | — | The group's composed commit, recorded before the first push. Every retry pushes this SHA; a recompose that differs freezes promotion instead |
| `TrunkAdvanced` | Trunk DO | `projectId, from, to, groupId, members: changeId[], proofIds[], verified?, height?` | each member change | member Change DOs, member lanes, the Auditor, Projector | Each member lands. The Auditor runs the full suite on the new head. `verified: false` when any batch in the group was unverified; absent when every one was. `height` is trunk's height after the advance: `TrunkInitialized` is 0, and each advance adds 1; a resume keeps it |
| `PromotionDeclined` | Trunk DO | `projectId, batchId, reason: commutation-failed\|frozen, reverify: changeId[]` | the batch | the batch's Lane DO | Trunk moved since the batch was verified and the commutation rule fails for it; or (`frozen`) the batch was in the group a freeze stopped, and the operator's resume drops it |
| `PromotionFrozen` | Trunk DO | `projectId, groupId, expected, observed` | — | the escalation inbox | Trunk's head was neither the old nor the new SHA; a person is alerted |
| `PromotionResumed` | Trunk DO | `projectId, by, head` | — | Projector | An operator released the freeze, confirming trunk's head |
| `AuditCompleted` | Trunk DO (fact) | `projectId, head, outcome: green\|red, suspects: changeId[], runRef` | — | Projector, the escalation inbox when red | The Auditor's full-suite run on a new head (Tier 2). On red it bisects across commutation-promoted commits and declares a revert change with `origin: auditor` |

## memory

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `RulingGiven` | the escalation's raising DO | `escalationId, option, by, rationale?` | the parties | parked changes, waiting Workflows | Resumes Workflows through `sendEvent` |
| `DecisionRecorded` | Subject DO | `decisionId, escalationId, scope, evidence[], alternatives: [{option, reasonRejected}]` | subjects in scope | Projector | Becomes a precedent for later changes |
| `DecisionSuperseded` | Subject DO | `decisionId, by: decisionId` | subjects in scope | Projector | — |
| `DecisionOverruled` | Subject DO | `decisionId, by: decisionId, requestedBy: changeId` | subjects in scope | Projector | — |
| `PrecedentSurfaced` | Subject DO (fact) | `decisionId, changeId` | — | the change's agent | Shown in preflight as dated, scoped evidence |
| `PrecedentFollowed` | Subject DO | `decisionId, changeId` | — | Projector | Stance recorded |
| `PrecedentDistinguished` | Subject DO | `decisionId, changeId, distinction` | — | Projector | Stance recorded |
| `OverruleRequested` | Subject DO | `decisionId, changeId, argument` | — | the escalation inbox | Raises an escalation |
| `TenetEstablished` | Subject DO | `tenetId, subjectId, predicate, value, changeId, guardIds[]` | — | relying changes' agents | Caused by a change landing with a guarded effect |
| `TenetContested` | Subject DO | `tenetId, conflictId` | — | relying changes' agents | A change's effect contradicts it |
| `TenetReaffirmed` | Subject DO | `tenetId, conflictId` | — | relying changes' agents | The contest was dismissed or resolved in the tenet's favour |
| `TenetRetracted` | Subject DO | `tenetId, changeId, decisionId` | — | relying changes' agents | A ruled change removed the belief |
| `TenetSuperseded` | Subject DO | `tenetId, by: tenetId` | — | relying changes' agents | — |
| `SessionOpened` | AgentSession DO | `sessionId, agentId, harness?, model?` | — | Projector | Session messages are captured against this ID |
| `MessagesCaptured` | AgentSession DO | `sessionId, fromSeq, toSeq, bundleRef` | — | Projector | Messages are immutable and addressed by number |
| `SessionRedacted` | AgentSession DO | `sessionId, ranges[], reason` | — | Projector | Citations into redacted ranges resolve to a redaction marker |

## delivery

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `PreviewDeployed` | Change DO or Lane DO | `deploymentId, world, adapter, url` | — | the agent(s), Projector | A preview is a World, so probes can target it live |
| `PreviewTornDown` | Change DO or Lane DO | `deploymentId` | — | Projector | On land or withdrawal |
| `DeploymentPromoted` | Trunk DO | `deploymentId, trunkSha, adapter, stage` | — | Projector | e.g. 10% then 100% |
| `DeploymentRolledBack` | Trunk DO | `deploymentId, to, reason` | — | the escalation inbox, Projector | — |

---

## External events

Third-party events never enter the catalogue directly. Each is decoded with Effect Schema at its doorway and translated into a Keel event, or dropped.

| Source | External event | Becomes |
|---|---|---|
| Artifacts, through a namespace-wide `triggers.events` rule (one per workspace namespace) starting the PushObserved Workflow | `cf.artifacts.repo.pushed` | `WorkspacePushed` for a branch update; tags, notes and deletions are dropped. An observation only: `submit` is authoritative |

Forks are not observed this way: the account's Artifacts lifecycle subscription is not Keel's to hold on a shared account, and namespace triggers do not fire on forks. The WorkspacePool DO emits `WorkspaceForked` itself (spike S2).

## Subscriptions, in one place

- An agent subscribes to a subject by relying on it.
- Lanes subscribe to change events; the Trunk DO subscribes to `BatchVerified`; the Auditor to `TrunkAdvanced`.
- `ChangeSubmitted` starts Precheck; `BatchFormed` starts KeelVerify; `RulingGiven` resumes a waiting Workflow through `sendEvent`.
- Every outbox flush nudges the Projector, which drains the operation log and sleeps: the one sanctioned exception to "nothing polls".
