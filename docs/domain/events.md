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
| `affected[]` | Entity refs (`{kind, id}`) whose state this event changes or invalidates, beyond `entity` itself. A subscriber learns what the event released without re-querying |
| `notified[]` | Subscriber refs the emitter delivered this event to, computed at commit time from its subscription table (e.g. `agent:agt_…`, `lane:<project>:<lane>`, `trunk:<project>`, `workflow:Precheck`) |
| `payload` | The fields listed for each event below |

**One transition, one event.** An entity's transition is triggered by a command or by another entity's event. Either way the entity commits exactly one event of its own, named for the transition, with `causation` set when an event caused it. Events that record a fact without changing their entity's lifecycle (`DriftDetected`, `GuardFailed`, `PreflightIssued`) are called out as such.

**Entity kinds:** `agent`, `session`, `change`, `subject`, `sketch`, `workspace`, `conflict`, `probe`, `guard`, `verdict`, `batch`, `candidate`, `project`, `decision`, `tenet`, `escalation`, `deployment`.

**ID prefixes.** From the API contract: `agt_ ses_ chg_ wsp_ sk_ sub_ cnd_ vrd_ cfl_ dec_ prb_`. Added here for entities the API does not yet expose: `evt_` (event), `bat_` (batch), `grd_` (guard), `tnt_` (tenet), `lse_` (lease), `esc_` (escalation), `dpl_` (deployment).

---

## identity

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `AgentEnrolled` | identity (operator command) | `agentId, name, kind: interactive\|hosted\|human, scopes[]` | — | Projector | Catalog row created |
| `AgentSuspended` | identity (operator command) | `agentId, reason, by` | the agent's open changes | the agent's AgentSession DO, Projector | Token exchange and every call refused until reinstated; its leases stop renewing |
| `AgentReinstated` | identity (operator command) | `agentId, by` | — | the agent's AgentSession DO, Projector | Calls accepted again |
| `AgentRevoked` | identity (operator command) | `agentId, revocationEpoch, by` | the agent's open changes, its leases | the agent's AgentSession DO, Projector | Revocation epoch bumped, so every token minted before it is rejected; its changes park for adoption |

## coordination

### Changes

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `IntentDeclared` | Change DO | `changeId, agentId, revision: 1, goal, footprint, premises[], leaseId` | each Subject relied on | Subject DOs relied on, the agent | The change is subscribed to each subject it relies on ("relying is subscribing"); preflight runs |
| `PreflightIssued` | Change DO (fact) | `changeId, revision, neighbours[], contradictions[], precedents[], suggestedMove` | — | the agent | The agent sees overlap, contradictions, precedents and a Move before writing code |
| `IntentRevised` | Change DO | `changeId, revision, goal?, footprint?, premisesAdded[], premisesRetracted[]` | Subjects whose premises changed | Subject DOs touched, the agent | Subscriptions follow the premises; preflight re-runs |
| `PremiseRelied` | Subject DO | `subjectId, changeId, premise: {predicate, relation, value, scope}` | — | the change's agent | The holder is notified of later fallout on this subject |
| `ChangeSubmitted` | Change DO | `changeId, revision, commitSha, workspaceId` | — | `workflow:Precheck`, the change's lane | **Starts Precheck.** The authoritative signal: push events only observe |
| `PrecheckStarted` | Change DO | `changeId, revision, instanceId` | — | Projector | The console follows the instance |
| `EffectsDerived` | Change DO (recorded from Precheck) | `changeId, revision, effects[], derivationRef` | Subjects altered | Subject DOs altered | Fallout runs on each altered subject; `derivationRef` points at the MFP derivation record |
| `DriftDetected` | Change DO (fact) | `changeId, revision, drift: [{class: footprint\|undeclared-effect\|silent-retraction, severity, detail}]` | — | the agent | Footprint drift is a notice; an undeclared effect is a notice that blocks only if proof-class; a silent retraction opens a Conflict |
| `ChangeDrifted` | Change DO | `changeId, revision, blocking: drift[]` | — | the agent | The agent must declare or revise before the change continues |
| `PlanCompiled` | Change DO (recorded from Precheck) | `changeId, revision, planHash, steps, costEstimate` | — | Projector | The Verification Plan runs |
| `ChangeQueued` | Change DO | `changeId, laneId` | the lane | Lane DO | The lane enqueues the change for batching |
| `ChangeBatched` | Change DO | `changeId, batchId` | — | the agent | Caused by `BatchFormed` |
| `ChangeRequeued` | Change DO | `changeId, batchId, reason: infra-failure\|bisection\|invalidated` | the lane | Lane DO | Re-enters the lane with no blame |
| `ChangeLanded` | Change DO | `changeId, commitSha, trunkSha, candidateId, proofId` | Subjects altered, the workspace | Subject DOs, the agent, WorkspacePool DO, Projector | Caused by `TrunkAdvanced`. Trailers and the MFP note are written; tenets are established; the workspace is collected; `Deployer` promotion begins |
| `ChangeBounced` | Change DO | `changeId, verdictId, reasons[], nextActions[]` | — | the agent | The agent fixes and resubmits |
| `ChangeParked` | Change DO | `changeId, reason: awaiting-ruling\|lease-lapsed, escalationId?` | — | the agent | Waits for a ruling, or for adoption |
| `ChangeResumed` | Change DO | `changeId, decisionId` | — | the agent | Caused by `RulingGiven`; verification continues |
| `ChangeAdopted` | Change DO | `changeId, previousAgentId, agentId, leaseId, briefRef` | the previous lease | both agents | Re-leased under the same Change-Id with a cold-start brief |
| `ChangeWithdrawn` | Change DO | `changeId, by, reason?` | the workspace, subscriptions | Subject DOs relied on, Lane DO, WorkspacePool DO | Subscriptions dropped; workspace collected |
| `ChangeSuperseded` | Change DO | `changeId, by: changeId` | the workspace, subscriptions | Subject DOs relied on, Lane DO, WorkspacePool DO | An alternative landed instead |
| `LeaseLapsed` | Change DO | `changeId, leaseId, renewedAt` | — | the agent | Raised by the lease's deadline alarm, 15 minutes after the last renewal. Parks the change if it is in a state the agent owns |

### Subjects and premises

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `PremiseSuspected` | Subject DO | `subjectId, changeId (holder), premise, cause: {changeId, effect}` | the holder's change | the holder's agent | Fallout's *suspect* outcome: the holder re-affirms or revises |
| `PremiseReaffirmed` | Subject DO | `subjectId, changeId, premise` | — | Projector | The suspicion is cleared |

### Sketches and workspaces

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `SketchOpened` | WorkspacePool DO | `sketchId, agentId, workspaceId, expiresAt` | the workspace | the agent | No intent, no preflight, no integration |
| `SketchPromoted` | WorkspacePool DO | `sketchId, changeId` | — | the agent | `declare --from-sketch`: the workspace carries over to the new change |
| `SketchExpired` | WorkspacePool DO | `sketchId` | the workspace | the agent | Raised by the TTL deadline alarm; the workspace is collected |
| `SketchDiscarded` | WorkspacePool DO | `sketchId, by` | the workspace | — | The agent dropped the idea |
| `WorkspaceForked` | WorkspacePool DO | `workspaceId, repo, sourceRepo` | — | — | Translated at the queue doorway from Artifacts' `repo.forked`. The fork joins the ready pool |
| `WorkspaceGranted` | WorkspacePool DO | `workspaceId, changeId\|sketchId, expiresAt` | — | the change or sketch, the agent | Handed out exactly once, with a write token shown once |
| `WorkspacePushed` | WorkspacePool DO (fact) | `workspaceId, ref, sha` | — | the change's agent | Translated from Artifacts' `pushed`. Observes plain-git agents; never authoritative |
| `WorkspaceCollected` | WorkspacePool DO | `workspaceId, reason: landed\|withdrawn\|expired` | — | — | The repo is deleted |

## verification

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `ConflictSuspected` | Subject DO | `conflictId, kind: textual\|footprint\|semantic\|precedent, parties: (changeId\|tenetId)[], subjectId, predicate` | each party | the parties' agents | A probe is drafted, unless the kind is proven directly (a refused merge, a failing guard) |
| `ProbeDrafted` | Subject DO | `probeId, conflictId, attempt (≤3), bundleHash` | — | — | The world matrix runs the probe in A, B and A+B |
| `ProbeDiscarded` | Subject DO | `probeId, reason: non-discriminating\|unstable\|draft-failed` | the conflict | — | A non-discriminating probe dismisses the conflict; three failed drafts make it unprovable |
| `ConflictProven` | Subject DO | `conflictId, evidence: {probeId\|guardId\|mergeRefusal}` | each party | the parties' agents, the lane | The change bounces with evidence, or escalates if human-class |
| `ConflictDismissed` | Subject DO | `conflictId, evidence` | each party | the parties' agents | The dismissal is recorded as evidence |
| `ConflictEscalated` | Subject DO | `conflictId, escalationId, reason: human-class\|unprovable` | each party | the escalation inbox | The parties park until a ruling |
| `ConflictResolved` | Subject DO | `conflictId, move, decisionId?` | each party | the parties' agents | The chosen Move applies |
| `GuardAdmitted` | Subject DO | `guardId, probeId, conflictId, runs: 3` | the guard repo | the parties' agents | The probe passed on trunk, passed in the premise-holder's world, failed in the combined world, three times. It now guards trunk |
| `GuardRetired` | Subject DO | `guardId, decisionId` | the guard repo | — | Only a superseding Decision retires a guard |
| `GuardFailed` | Lane DO (fact) | `guardId, batchId, candidateId, world` | the batch | — | Proof against the candidate; feeds its verdict |
| `VerdictIssued` | Change DO or Lane DO | `verdictId, subject: changeId\|batchId, outcome: land\|bounce\|park\|hold\|supersede, evidence[], planHash` | the change or batch | the agent(s) | Every step result is part of the evidence |
| `EscalationRaised` | Subject DO or Change DO | `escalationId, question, options[], consequences[], about: entity ref` | — | the escalation inbox | A person is asked; the default is *hold* |

## integration

A **Batch** is a set of Changes verified together; its **Candidate** is the composed tree for one attempt.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `BatchFormed` | Lane DO | `batchId, laneId, members: changeId[], base, attempt, chainEpoch` | each member change | member Change DOs, `workflow:KeelVerify` | **Starts KeelVerify.** Never contains two changes with an open suspected conflict or opposite effects on one subject |
| `CandidateAssembled` | Lane DO | `candidateId, batchId, treeSha, composer: gitcore\|mergebox, tier, tierReason` | — | Projector | The candidate is bundled to R2 |
| `VerificationStarted` | Lane DO | `candidateId, batchId, instanceId, planHash` | — | Projector | The union of the members' plans runs across the tiers |
| `BatchVerified` | Lane DO | `batchId, candidateId, verdictId` | — | Trunk DO | **Trunk promotion debounces.** Late results are fenced on `(batchId, attempt, chainEpoch)` |
| `BatchFailed` | Lane DO | `batchId, candidateId, verdictId, attribution: changeId\|interaction\|infra` | each member change | member Change DOs | Flake rerun, then attribution, then bisection; an interaction failure opens a semantic Conflict |
| `CandidateBisected` | Lane DO | `candidateId, batchId, into: batchId[]` | each member change | member Change DOs | Leave-one-out or a 4-way split |
| `CandidateInvalidated` | Lane DO | `candidateId, batchId, reason: head-moved` | each member change | member Change DOs | The commutation rule failed; only the intersection is re-verified |
| `CandidatePromoted` | Lane DO | `candidateId, batchId, trunkSha` | — | — | Caused by `TrunkAdvanced` |
| `TrunkAdvanced` | Trunk DO | `projectId, from, to, groupId, members: changeId[], proofIds[]` | each member change | member Change DOs, member lanes, the Auditor, Projector | Each member lands. The Auditor runs the full suite on the new head |
| `PromotionFrozen` | Trunk DO | `projectId, groupId, expected, observed` | — | the escalation inbox | Trunk's head was neither the old nor the new SHA; a person is alerted |
| `PromotionResumed` | Trunk DO | `projectId, by` | — | Projector | An operator released the freeze |

## memory

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `RulingGiven` | Subject DO or Change DO | `escalationId, option, by, rationale?` | the parties | parked changes, waiting Workflows | Resumes Workflows through `sendEvent` |
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

Third-party events never enter the catalogue directly. The queue doorway decodes each one with Effect Schema and translates it into a Keel event, or drops it.

| Source | External event | Becomes |
|---|---|---|
| Artifacts (account lifecycle, via the `artifacts-events` queue) | `repo.forked` | `WorkspaceForked` |
| Artifacts (namespace push trigger) | `pushed` | `WorkspacePushed` (an observation only; `submit` is authoritative) |

## Subscriptions, in one place

- An agent subscribes to a subject by relying on it.
- Lanes subscribe to change events; the Trunk DO subscribes to `BatchVerified`; the WorkspacePool DO to `WorkspaceForked`; the Auditor to `TrunkAdvanced`.
- `ChangeSubmitted` starts Precheck; `BatchFormed` starts KeelVerify; `RulingGiven` resumes a waiting Workflow through `sendEvent`.
- Every outbox flush nudges the Projector, which drains the operation log and sleeps: the one sanctioned exception to "nothing polls".
