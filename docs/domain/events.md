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
| `actor` | Optional. The principal whose command caused the event: `agent:<agentId>` or `user:<userId>`. Events committed before users existed name a person as `operator:<name>`; that form is read, and encoded again as it was, and nothing writes it: a command is by a `CommandActor`, which has only the first two forms, and a commit takes no other. Absent when the platform caused it (Precheck, an alarm, a reaction, the Lane landing a change). An agent is never notified of an event it caused |
| `run` | Optional. The run of the agent whose command caused the event, as `{id, label?}`: one agent has any number of runs at once, and each event says which. Copied from the commit beside `actor`. Absent when the actor is a user or the platform, and for an agent's token that names no run. |
| `affected[]` | Entity refs (`{kind, id}`) whose state this event changes or invalidates, beyond `entity` itself. A subscriber learns what the event released without re-querying |
| `notified[]` | Subscriber refs the emitter delivered this event to, computed at commit time from its subscription table (e.g. `agent:agt_…`, `lane:<project>:<lane>`, `trunk:<project>`, `workflow:Precheck`) |
| `payload` | The fields listed for each event below |

**One transition, one event.** An entity's transition is triggered by a command or by another entity's event. Either way the entity commits exactly one event of its own, named for the transition, with `causation` set when an event caused it. Events that record a fact without changing their entity's lifecycle (`DriftDetected`, `GuardFailed`, `PreflightIssued`) are called out as such.

**Entity kinds:** `agent`, `session`, `change`, `subject`, `workspace`, `conflict`, `probe`, `guard`, `verdict`, `batch`, `candidate`, `project`, `trunk`, `decision`, `tenet`, `escalation`, `deployment`.

**ID prefixes.** From the API contract: `agt_ ses_ chg_ wsp_ sk_ sub_ cnd_ vrd_ cfl_ dec_ prb_`. Added here for entities the API does not yet expose: `evt_` (event), `bat_` (batch), `grd_` (guard), `tnt_` (tenet), `lse_` (lease), `esc_` (escalation), `dpl_` (deployment), `crd_` (a credential in an org's store: a reference, never the secret).

---

## identity

The AgentSession DO (`agent:<id>`) is the source of truth for an agent. D1's `AgentDirectory` is a projected index of it (client-credential hash → agent), fed from these events.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `AgentEnrolled` | AgentSession DO (operator command) | `agentId, projectId, name, kind: interactive\|hosted\|human\|synthetic, scopes[], org?: NamespaceId` (the id of the namespace the agent works in, an org's or a person's own. The field keeps the name it has in every log and in every AgentSession object's state, where `Agent.org` holds the same id; everything that only passes it along calls it `namespace`. It goes when enrolment does, once every agent signs up by key), `sponsor?: UserId` (the user who minted the credential; optional only for agents enrolled before tenancy) | — | Projector | Catalog row created |
| `AgentSignedUp` | AgentSession DO (the agent's own sign-up) | `agentId, handle, name?, key: { jkt, jwk }` (the id and the handle are made from the key; no project, no person) | — | Projector | The directory row, the agent's key and its namespace of kind `agent` are written before the sign-up answers; public, as a person's username is |
| `AgentSuspended` | AgentSession DO (operator command) | `agentId, reason, by` | the agent's open changes | the agent's AgentSession DO, Projector | Token exchange and every call refused until reinstated; its leases stop renewing |
| `AgentReinstated` | AgentSession DO (operator command) | `agentId, by` | — | the agent's AgentSession DO, Projector | Calls accepted again |
| `AgentRevoked` | AgentSession DO (operator command) | `agentId, revocationEpoch, by` | the agent's open changes, its leases | the agent's AgentSession DO, Projector | Revocation epoch bumped, so every token minted before it is rejected; its changes park for adoption |
| `AgentSponsored` | AgentSession DO (a person's approval of the agent's own ask) | `agentId, sponsor: UserId` | the user | the agent's AgentSession DO, Projector | The person stands behind the agent: its questions go to them, and they may pause it. No right changes |
| `AgentUnsponsored` | AgentSession DO (the sponsor, or the agent itself) | `agentId, sponsor: UserId, by` | the user | the agent's AgentSession DO, Projector | Nobody stands behind the agent. Ending the link while the agent is paused commits `AgentReinstated` first |
| `AgentInvited` | the namespace's object, `ns:<id>`, on `org:<namespaceId>` (a member's invitation) | `namespace, agentId, by: UserId, scopes` (`agent:read`, or that and `agent:work`) | the agent, the user | the agent's AgentSession DO, Projector | Nothing yet: an invitation gives the agent no standing until it accepts. Its row is written to `namespace_agents` as `invited` before the invitation answers |
| `AgentJoinedNamespace` | the namespace's object (the agent's own acceptance) | `namespace, agentId` (no person: anyone may read it) | the agent | Projector | The agent stands in the namespace: a token that names one of its projects reads and works there within the invitation's scopes, for as long as the member who invited it is a member. That member answers for it and is asked first |
| `AgentLeftNamespace` | the namespace's object (the agent, the member who invited it, or a maintainer) | `namespace, agentId, by, reason` (`declined`, `left`, `withdrawn`, `removed`) | the agent | the agent's AgentSession DO (unless it ended it itself), Projector | The agent has no standing in the namespace from its next request. It keeps its account and its own namespace, and may be invited again |
| `AgentInvitedToProject` | the Project DO, on `project:<id>` (the invitation of the person whose namespace the project is in) | `projectId, namespace, agentId, by: UserId, scopes` (`agent:read`, or that and `agent:work`) | the agent, the user | the agent's AgentSession DO, Projector | Nothing yet: an invitation gives the agent no standing until it accepts. Its row is written to `project_agents` as `invited` before the invitation answers |
| `AgentJoinedProject` | the Project DO (the agent's own acceptance) | `projectId, namespace, agentId` (no person: whoever reads the project may read it) | the agent | Projector | The agent stands on that one project and on nothing else of the namespace: a token that names it reads and works there within the invitation's scopes. The person who invited it answers for it and is asked first |
| `AgentLeftProject` | the Project DO (the agent, or the person who invited it) | `projectId, namespace, agentId, by, reason` (`declined`, `left`, `withdrawn`, `removed`) | the agent | the agent's AgentSession DO (unless it ended it itself), Projector | The agent has no standing on the project from its next request. It keeps its account and its own namespace, and may be invited again |

Tenancy events ([tenancy.md](tenancy.md)). Better Auth's tables in D1 are identity's source of truth; its after-hooks commit these through a Queue, one per row-state change, idempotent by the envelope's key, keyed `user:<userId>` or `org:<orgId>`. They are for the feed and the audit: `authorize` never reads them. None carries an email address.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `UserSignedUp` | Better Auth's after-hook (`user:<userId>`) | `userId, handle?` | — | instance audit | — |
| `OrgCreated` | Better Auth's after-hook (`org:<orgId>`) | `orgId, name: Handle, by: UserId` | — | Projector | A person's own namespace is no org and has no such event; an older event's `personal` is read and dropped |
| `MembershipChanged` | Better Auth's after-hook (`org:<orgId>`) | `orgId, userId, from?: Role, to?: Role, by?: UserId` (at least one of `from` and `to`, and they differ) | the agents the user sponsored there, when the membership ended | Projector | Ending a membership revokes every live agent the user sponsored in the org (`revokedBy`) |
| `UserSuspended` | Whoever runs the instance, outside the product (`user:<userId>`); nothing commits it yet | `userId, reason, by: UserId` | — | instance audit | Every request of the user is refused, and so is every request of the agents it sponsors |
| `UserReinstated` | Whoever runs the instance, outside the product (`user:<userId>`); nothing commits it yet | `userId, by: UserId` | — | instance audit | Requests accepted again |
| `OrgSuspended` | Whoever runs the instance, outside the product (`org:<orgId>`); nothing commits it yet | `orgId, reason, by: UserId` | — | Projector | Members are told the org is suspended; everyone else gets not-found |
| `OrgReinstated` | Whoever runs the instance, outside the product (`org:<orgId>`); nothing commits it yet | `orgId, by: UserId` | — | Projector | Requests accepted again |
| `OrgDeleted` | Better Auth's after-hook (`org:<orgId>`), owner | `orgId` | the org's projects | Projector | Its repos, R2 prefix, objects and rows are deleted |

## coordination

### Changes

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `IntentDeclared` | Change DO | `changeId, agentId, run?, origin: agent\|auditor\|operator, revision: 1, goal, footprint, premises[], leaseId` | each Subject relied on | Subject DOs relied on, the agent | The change is subscribed to each subject it relies on ("relying is subscribing"); preflight runs. `origin: auditor` marks the Auditor's auto-revert, a platform-authored change that lands like any other |
| `PreflightIssued` | Change DO (fact) | `changeId, revision, neighbours[], contradictions[{premise, with, holder, withRole?}], precedents[], suggestedMove, basis?, alternatives?: changeId[]` (the live changes with the same intent, in the live index's order, never ranked; absent when there are none, and the Move never reads them) | — | the agent | The agent sees overlap, contradictions, precedents and a Move before writing code, with what the Move rests on (`basis`: a contradiction by index, or a precedent; absent for `proceed`). Footprint overlap is *exposure* and appears only in `neighbours`: proximity never opens a conflict |
| `ChangeStarted` | Change DO | `changeId, workspaceId, baseSha` | — | the agent | Caused by `WorkspaceGranted`: Declared → Working, in that workspace. `baseSha` is the workspace's head at grant, the base Precheck diffs against |
| `IntentRevised` | Change DO | `changeId, revision, goal?, footprint?, premisesAdded[], premisesRetracted[]` | Subjects whose premises changed | Subject DOs touched, the agent | Subscriptions follow the premises; preflight re-runs |
| `PremiseRelied` | Subject DO | `subjectId, changeId, premise: {predicate, relation, value, scope}` | — | the change's agent | The Subject DO's reaction to a change's `rely`, which the Change DO commits as `IntentRevised {premisesAdded: [premise]}`. The holder is notified of later fallout on this subject |
| `ChangeSubmitted` | Change DO | `changeId, revision, commitSha, workspaceId, baseSha?` (the base the submission is judged against) | — | `workflow:Precheck`, the change's lane | **Starts Precheck.** The authoritative signal: push events only observe |
| `ChangeRebased` | Change DO | `changeId, from, to` | — | Projector | The agent rebased its workspace (after a textual bounce, say): the change's base moves from `from` to `to`, and nothing else changes |
| `PrecheckStarted` | Change DO | `changeId, revision, instanceId` | — | Projector | The console follows the instance |
| `EffectsDerived` | Change DO (recorded from Precheck) | `changeId, revision, effects[], derivationRef`; each effect is `{proposition, method, evidenceClass, p?, anchors (≥ 1), declared, contradicts?}` | Subjects altered | Subject DOs altered | Committed on its own, at most once per Precheck pass and only while the change is Deriving, before the pass classifies drift or compiles a plan: it is on the log whether the change then drifts or compiles. A change resubmitted at the same revision starts a new pass, whose derivation replaces the earlier one. Fallout runs on each altered subject; `derivationRef` points at Keel's derivation record. The method fixes the class: `extractor` is a ruling with no `p`; `clef` is opinion with `p` in [0, 1]; `code-model` is opinion with an optional `p`. No derived effect is proof or testimony |
| `DriftDetected` | Change DO (fact) | `changeId, revision, drift: [{class: footprint\|undeclared-effect\|silent-retraction, severity, detail}]` | — | the agent | Footprint drift is a notice; an undeclared effect is a notice that blocks only if proof-class; a silent retraction opens a Conflict |
| `ChangeDrifted` | Change DO | `changeId, revision, blocking: drift[]` | — | the agent | The agent must declare or revise before the change continues |
| `PlanCompiled` | Change DO (recorded from Precheck) | `changeId, revision, planHash, steps, costEstimate, predicatePolicy?` (per predicate `block`, `advise` or `annotate`, as compiled for the change; absent is `advise`) | — | Projector | The Verification Plan runs |
| `ChangeQueued` | Change DO | `changeId, laneId, planHash?` (the plan the change was last compiled to; always set by `decideChange` once a plan is compiled) | the lane | Lane DO | The lane enqueues the change for batching |
| `ChangeBatched` | Change DO | `changeId, batchId` | — | the agent | Caused by `BatchFormed` |
| `ChangeRequeued` | Change DO | `changeId, batchId, reason: infra-failure\|bisection\|invalidated\|co-member-failed\|textual\|interaction, planHash?` (as on `ChangeQueued`, so the lane re-adds the change from this event alone) | the lane | Lane DO | Re-enters the lane with no blame; after `textual` or `interaction` it runs alone in its next batch |
| `ChangeLanded` | Change DO | `changeId, commitSha, trunkSha, candidateId, proofId` | Subjects altered, the workspace | Subject DOs, the agent, WorkspacePool DO, Projector | Caused by `TrunkAdvanced`, copied from the change's landing: `commitSha` is its commit on trunk (the one carrying its trailers), not the commit it was submitted as; `trunkSha` is the advance's `to`. Trailers and the MFP note are written; tenets are established; the workspace is collected; `Deployer` promotion begins |
| `ChangeBounced` | Change DO | `changeId, verdictId?, conflictId?, declined?: {batchId, reason: pack-too-large\|repo-bytes-quota}, decisionId?, reasons[], nextActions[]` (exactly one cause: the verdict that failed it; a conflict proven against it under `block`, which bounces only from Deriving, Verifying or Queued; the batch promotion declined because its push was refused, which bounces only its own members, from Integrating; or the decision of a ruling that went against it, which bounces it only while it is Parked awaiting that ruling) | — | the agent | The agent fixes and resubmits; after a ruling against it, it revises its intent so that it no longer contradicts what was ruled, or withdraws. `nextActions` is never empty |
| `ConflictNoted` | Change DO | `changeId, conflictId, predicate, policy: advise\|annotate, evidenceRef?, nextActions?` (advise only: read the conflict, revise, resolve) | — | the agent, under `advise` only | Nothing moves: the change stays where it is. `annotate` notifies no one |
| `AlternativeDeclared` | Project DO (`project:<id>`, fact) | `projectId, changeId, alternativeId, nextActions` (read the other change, read what is near your own, rebase, withdraw) | `change:<changeId>` | `changeId`'s agent | Nothing moves. A live change learns that another was declared with the same intent: their declared effects make the same claims (`areAlternatives`). Keel shows alternatives to each other and never picks one |
| `AlternativeLanded` | Project DO (`project:<id>`, fact) | `projectId, changeId, landedChangeId, nextActions` (as on `AlternativeDeclared`) | `change:<changeId>` | `changeId`'s agent | Nothing moves. A live change learns that a change with the same intent landed; its agent compares, rebases or withdraws, as it chooses |
| `ChangeParked` | Change DO | `changeId, reason: awaiting-ruling\|lease-lapsed, escalationId?` | — | the agent, its lane | Waits for a ruling, or for adoption. Awaiting a ruling, its lane drops it from the queue until it resumes. A change that already waits for a ruling is parked again when that ruling comes while another of its conflicts is with a person: the event then names the escalation it waits on from there, and nothing else moves |
| `ChangeResumed` | Change DO | `changeId, decisionId` | — | the agent, its lane | Caused by the `ConflictResolved` that carries its escalation's decision; the change returns to where it was parked from, and from Queued its lane takes it back at the front |
| `ChangeAdopted` | Change DO | `changeId, previousAgentId, agentId, run?, leaseId, briefRef` | the previous lease | both agents | Re-leased under the same Change-Id with a cold-start brief |
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

### Workspaces

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `WorkspaceForked` | WorkspacePool DO | `workspaceId, repo, sourceRepo` | — | — | Emitted when the pool's own fork call resolves; a fork is ready at once (spike S2). The fork joins the ready pool |
| `WorkspaceGranted` | WorkspacePool DO | `workspaceId, holder: changeId, expiresAt, baseSha` | — | the change, the agent | Handed out exactly once; a retried grant for the same holder re-mints the write token, which is never stored or carried in the event. `baseSha` is the workspace's head at grant time, the change's base |
| `WorkspacePushed` | WorkspacePool DO (fact) | `workspaceId, ref, sha` | — | the change's agent | Translated from Artifacts' `pushed` by the PushObserved Workflow, for branch updates only. Observes plain-git agents; never authoritative |
| `WorkspaceCollected` | WorkspacePool DO | `workspaceId, reason: landed\|withdrawn\|expired` | — | — | The repo is deleted |

## verification

**Conflicts are owned by kind.** The Subject DO owns `semantic` and `precedent` conflicts. `textual` (a refused merge) and `interaction` (every subset of a batch passes, the union fails) conflicts have no subject, so the Lane DO owns them. A conflict's probes, guards and escalations belong to the DO that owns the conflict; "Subject DO" below means "the conflict's owner" for those events.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `ConflictSuspected` | Subject DO or Lane DO (by kind) | `conflictId, kind: textual\|semantic\|precedent\|interaction, parties: (changeId\|tenetId)[], subjectId?, subjectKey?, predicate?, origin?: fallout\|opinion, premise?: {holder, proposition}, effect?: {changeId, proposition, evidence?: {declared, method?: extractor\|clef\|code-model, evidenceClass}}` (subject present for `semantic` and `precedent`; `subjectKey` is that subject's key, given only with it, and addresses its Subject DO; absent `origin` is `fallout`; a probe is drafted only when both `premise` and `effect` are named, else the conflict escalates as unprovable; `evidence` says how the effect is known, as fallout judged it: with no `method` it is the agent's own claim, declared and `testimony`, and with one Keel derived it, an `extractor`'s a `ruling` and a model's an `opinion`, `declared` then saying whether the agent's declared effects spoke for it; any other combination is refused, and older events have none) | each party | the parties' agents | A probe is drafted, unless the kind is proven directly (a refused merge, a failing guard, a union that fails while every subset passes). An `opinion` suspicion is a decision model's: no lattice comparison dismisses it, only its probe or a person |
| `ProbeDrafted` | Subject DO | `probeId, conflictId, attempts (≤4: the first draft and three repairs), bundleHash` | — | — | The probe entity begins here, for a Suspected conflict with no probe, which moves to Probing. The world matrix runs it on trunk, in A, B and A+B, and in A-noop |
| `WorldCheckRan` | Subject DO (fact) | `conflictId, world: trunk\|A\|B\|AB\|A-noop, check: suite:trunk\|suite:<changeId>, run: 1..3, outcome: pass\|fail\|n/a, counts?: {passed, failed, skipped}, reason?` (`reason` required for n/a) | — | Projector | One cell of the world matrix filled by a project's suite rather than the probe. It is recorded once the conflict's probe was drafted, also after that probe has decided, and the conflict stays in the state it is in; the same cell again commits nothing, and a different answer for it is refused |
| `ProbeRan` | Subject DO (fact) | `probeId, conflictId, world: trunk\|A\|B\|AB\|A-noop, run: 1..3, outcome: pass\|fail\|n/a, resultRef` | — | Projector | One cell of the world matrix. `A-noop` is the premise-holder's world with the premised behaviour removed, built from the probe template's recipe. Admission is computed from these, and Conflict Theatre fills the matrix from them |
| `ProbeDiscarded` | Subject DO | `probeId, reason: non-discriminating\|unstable\|draft-failed\|run-failed, conflictId, detail?: schema\|truncated\|abstained\|repairs-exhausted\|incomplete\|no-propositions\|no-submission\|party-gone\|worlds-unbuildable` (only with `draft-failed`; nothing emits `schema` or `truncated` any more) | the conflict | — | A non-discriminating probe dismisses the conflict; an unstable one, three failed drafts, or a run that ended before the matrix was complete (`run-failed`) make it unprovable. With `draft-failed` it is the probe's first and only event |
| `ConflictProven` | Subject DO | `conflictId, evidence: {probeId\|guardId\|mergeRefusal\|interaction: batchId}` | each party | the parties' agents, the lane | The change bounces with evidence, or escalates if human-class. Proof without a probe matches the kind: a refused merge proves a textual conflict, a failing guard a precedent one, a failing union an interaction one |
| `ConflictDismissed` | Subject DO | `conflictId, evidence` | each party | the parties' agents | The dismissal is recorded as evidence: `lattice:compatible\|refines` (the domain's own comparison of the premise and the effect) or `probe:<probeId>:non-discriminating` |
| `ConflictEscalated` | Subject DO | `conflictId, escalationId, reason: human-class\|unprovable` | each party | the escalation inbox | The parties park until a ruling |
| `ConflictResolved` | Subject DO | `conflictId, move, decisionId?, against?: changeId[]` (`against` only with a decision, never empty, and only parties of the conflict: the changes the ruling went against) | each party | the parties' agents | The chosen Move applies. A party named in `against` bounces by the decision; every other party resumes |
| `GuardAdmitted` | Subject DO | `guardId, probeId, conflictId, runs: 3` | the guard repo | the parties' agents | Computed from `ProbeRan`: the probe passed on trunk (or did not apply), passed in the premise-holder's world, failed in the combined world and failed in A-noop, three times. It now guards trunk |
| `GuardRetired` | Subject DO | `guardId, decisionId` | the guard repo | — | Only a superseding Decision retires a guard |
| `GuardFailed` | Lane DO or Change DO (fact) | `guardId, batchId?, candidateId?, changeId?, world` (a change, or a batch and its candidate) | the batch, or the change | — | Proof against the candidate, or at Precheck against the change itself; feeds its verdict |
| `VerdictIssued` | Change DO or Lane DO | `verdictId, subject: changeId\|batchId, outcome: land\|bounce\|park\|hold\|supersede, evidence[], planHash?, verified?, nextActions?` | the change or batch | the agent(s) | Every step result is part of the evidence. `planHash` always resolves to a plan; it is absent only for a Precheck refusal, a ruling-class verdict reached before any plan was compiled. `verified: false` when the project's verification is off and the plan was not run; absent means true. `nextActions` is the remedy, set by the issuer that knows it (the Lane for a refused composition or bundle, KeelVerify for a failing test); the Change DO copies it onto `ChangeBounced` and uses its own default only when it is absent |
| `EscalationRaised` | the namespace object (`ns:<namespaceId>`) | `escalationId, question, options: [{id, label, consequence}] (≥ 2, unique ids), about: entity ref, category, evidence: [{class, summary, ref?}], precedents: decisionId[], default: option id` | what it is about, its namespace (`org`), and the user asked first (`user`) when there is one. The entity kind `org` names the namespace whatever its kind, a person's or an agent's own as often as an org's: the name is known debt, kept because renaming a kind in stored events means rewriting every log | Projector | A person is asked: the user named first at once, the namespace's maintainers after thirty minutes (a rule of the list; nothing is reassigned). While open, its owner holds. The default is a suggestion, never applied on a timeout. `category` is `permission-semantics`, `destructive-migration`, `ambiguous-requirement`, `unprovable-conflict`, `overrule-request` or `frozen-trunk`; Mission Control groups the evidence by class |
| `EscalationWithdrawn` | the namespace object | `escalationId, reason` | — | the escalation inbox | Its subject was resolved some other way before a ruling |
| `EscalationWidened` | the namespace object (its own deadline, thirty minutes after the raising) | `escalationId` | what the escalation is about, its namespace, the user asked first | Projector | The user asked first has had thirty minutes and the escalation is still open: its namespace's maintainers are asked too. Committed once, and only for an escalation that named a user to ask first. The list's rule stays the clock's, so a late deadline never hides a question; the event is what a maintainer's open inbox hears. Nothing is reassigned: the user asked first may still answer |

## integration

A **Batch** is a set of Changes verified together; its **Candidate** is the composed tree for one attempt.

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `BatchFormed` | Lane DO | `batchId, laneId, members: changeId[], base, attempt, chainEpoch, projectId, predecessors: changeId[]` | each member change | member Change DOs, `workflow:KeelVerify` | **Starts KeelVerify.** Never contains two changes with an open suspected conflict or opposite effects on one subject |
| `CandidateAssembled` | Lane DO | `candidateId, batchId, treeSha, composer: gitcore\|mergebox, tier, tierReason` | — | Projector | The candidate is bundled to R2 |
| `VerificationStarted` | Lane DO | `candidateId, batchId, instanceId, planHash` | — | Projector | The union of the members' plans runs across the tiers |
| `BatchVerified` | Lane DO | `batchId, candidateId, verdictId, members: changeId[], base, predecessors: changeId[], verified?` | — | Trunk DO | **Trunk promotion debounces.** `verified` is the batch verdict's, carried unchanged into the Trunk DO's queue and WAL entry. Late results are fenced on `(batchId, attempt, chainEpoch)`; a fenced result is never retried. The Trunk DO records the event it receives and folds it into its state |
| `BatchFailed` | Lane DO | `batchId, candidateId?, verdictId, attribution: changeId\|textual\|interaction\|infra\|unattributed` | each member change | member Change DOs | Flake rerun, then attribution, then bisection. A refused composition of a batch of one names its change; of a larger batch it is `textual`: GitCore and MergeBox both refused to compose, a proven textual conflict. A refused bundle (a symlink, a gitlink, an unsafe path) fails an assembled batch, blamed on the member whose commit introduces the entry, or on `infra` when the base already holds it, and is never bisected. `interaction`: every subset passes and the union fails, an interaction conflict. Both are owned by the Lane DO. `unattributed`: a failure of several members that attribution could not pin; only it is bisected |
| `CandidateBisected` | Lane DO | `candidateId, batchId, into: batchId[]` | each member change | member Change DOs | Leave-one-out or a 4-way split |
| `CandidateInvalidated` | Lane DO | `candidateId, batchId, reason: head-moved` | each member change | member Change DOs | Caused by `PromotionDeclined`; only the intersection is re-verified |
| `CandidatePromoted` | Lane DO | `candidateId, batchId, trunkSha` | — | — | Caused by `TrunkAdvanced` |
| `ProjectCreated` | Project DO (`project:<id>`) | `projectId, name, by` | — | Projector | The project exists; its trunk, lanes and subject registry are keyed by `projectId` from here on. The trunk still waits for `TrunkInitialized` |
| `ProjectDeleted` | Project DO (`project:<id>`) | `projectId, by: UserId` | the project's changes | Projector | The project and its repos are gone |
| `ProjectSettingsChanged` | Project DO (`project:<id>`) | `projectId, changes: [{field, from, to}], by` | — | Projector | Whoever governs the project changed its settings: a person, or an agent in a namespace of its own (the envelope then names the agent and the run its token named). Each changed field is recorded with its value before and after, so a switch such as turning verification off is audited |
| `TrunkInitialized` | Trunk DO | `projectId, head, by, origin?` | — | Projector | The trunk's first known head, from the project's start. Nothing is queued or promoted before it. `origin` says where that head came from, for good: `{kind: "empty"}` (Keel's own first commit), `{kind: "imported", url, ref, commit}` (a public Git repository and the upstream branch that came), `{kind: "forked", project, commit}` or `{kind: "template", name, commit}`, `commit` being the head; absent on a trunk initialized before origins were kept |
| `PromotionStarted` | Trunk DO | `projectId, groupId, old, members: changeId[], batches: batchId[], proofIds[], committerTime` | — | Projector | The write-ahead log entry ([ADR 0003](../adr/0003-trunk-single-writer-wal.md)), committed with the batches' declines. Resolved by exactly one `TrunkAdvanced` or `PromotionFrozen` |
| `PromotionComposed` | Trunk DO | `projectId, groupId, sha, commits: {changeId, commitSha}[]` | — | — | The group's composed commit, recorded before the first push, with each member's commit in the chain, in group order. Every retry pushes this SHA; a recompose that differs freezes promotion instead. A composer report whose chain is not exactly the group's members, in order, is refused (composition mismatch) and records nothing |
| `TrunkAdvanced` | Trunk DO | `projectId, from, to, groupId, landings: {changeId, commitSha, candidateId, proofId}[], verified?, height?` | each landing's change (`affected`, which scoped subscriptions match) | member Change DOs, member lanes, the Auditor, Projector | Each member lands from its own landing: its commit on trunk from `PromotionComposed`, and its own batch's candidate and proof. One landing per member, in group order. The Auditor runs the full suite on the new head. `verified: false` when any batch in the group was unverified; absent when every one was. `height` is trunk's height after the advance: `TrunkInitialized` is 0, and each advance adds 1; a resume keeps it |
| `PromotionDeclined` | Trunk DO | `projectId, batchId, reason: commutation-failed\|frozen\|pack-too-large\|repo-bytes-quota, reverify: changeId[], nextActions?` | the batch | the batch's Lane DO | Trunk moved since the batch was verified and the commutation rule fails for it; or (`frozen`) the batch was in the group a freeze stopped, and the operator's resume drops it; or the group's push was refused and trunk did not move. A pack too large (`pack-too-large`) bounces the members of a batch refused alone (`reverify` empty) and sends a group of several to be verified again, after which promotion takes one batch at a time until a push lands. A full repo (`repo-bytes-quota`) bounces every member. `nextActions` is always set for a refused push |
| `PromotionFrozen` | Trunk DO | `projectId, groupId, expected, observed, reason?` (`head-moved`, `recompose-mismatch` or `readback-mismatch`; always set by the Trunk) | — | the escalation inbox | Trunk's head was neither the old nor the new SHA, or a recompose disagreed with the recorded one; a person is alerted |
| `PromotionResumed` | Trunk DO | `projectId, by, head` | — | Projector | An operator released the freeze, confirming trunk's head |
| `AuditCompleted` | Trunk DO (fact) | `projectId, head, outcome: green\|red, suspects: changeId[], runRef` | — | Projector, the escalation inbox when red | The Auditor's full-suite run on a new head (Tier 2). On red it bisects across commutation-promoted commits and declares a revert change with `origin: auditor` |

## memory

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `RulingGiven` | the namespace object | `escalationId, option: option id, by, rationale?` | what the escalation is about, its namespace, the user asked first | Projector | Committed with the `DecisionRecorded` it makes, in one transaction. An option the escalation does not offer is refused, with a next action per valid id; a second ruling is refused |
| `DecisionRecorded` | the namespace object that took the ruling | `decisionId, escalationId, option, summary, scope?, evidence[], alternatives: [{option, reasonRejected}]` | the escalation and what it is about | the object that raised the escalation, Projector | The raiser acts on it: a Subject DO resolves its conflict with this decision. Becomes a precedent for later changes. Recorded only from a ruled escalation: `option` is the one chosen (`summary` its label), `alternatives` every other option with its consequence, `evidence` each item as `class: summary`. An absent scope is everywhere; a later decision supersedes it only over the same or a wider scope |
| `DecisionSuperseded` | Subject DO | `decisionId, by: decisionId` | subjects in scope | Projector | — |
| `DecisionOverruled` | Subject DO | `decisionId, by: decisionId, requestedBy: changeId` | subjects in scope | Projector | — |
| `PrecedentSurfaced` | Change DO, on the change (fact) | `decisionId, changeId` | — | the change's agent | Shown in preflight as dated, scoped evidence; once a decision a change |
| `PrecedentFollowed` | Subject DO | `decisionId, changeId` | — | Projector | Stance recorded |
| `PrecedentDistinguished` | Change DO, on the change | `decisionId, changeId, distinction` | — | Projector | Stance recorded, by `resolve` with `distinguish` on a ruled conflict |
| `OverruleRequested` | Subject DO | `decisionId, changeId, argument` | — | the escalation inbox | Raises an escalation |
| `TenetEstablished` | Subject DO | `tenetId, subjectId, predicate, value, changeId, guardIds[]` (at least one) | — | relying changes' agents | Caused by a change landing with a guarded effect |
| `TenetContested` | Subject DO | `tenetId, conflictId` | — | relying changes' agents | A change's effect contradicts it |
| `TenetReaffirmed` | Subject DO | `tenetId, conflictId` | — | relying changes' agents | The contest was dismissed or resolved in the tenet's favour |
| `TenetRetracted` | Subject DO | `tenetId, changeId, conflictId, decisionId?` | — | relying changes' agents | A change landed against the tenet: on a ruling (`decisionId`), or on its proven conflict where the predicate's policy let it land |
| `TenetSuperseded` | Subject DO | `tenetId, by: tenetId` | — | relying changes' agents | — |
| `SessionOpened` | AgentSession DO | `sessionId, agentId, harness?, model?, sponsor?: UserId` (the agent's sponsor, from its enrolment) | — | Projector | Session messages are captured against this ID |
| `MessagesCaptured` | AgentSession DO | `sessionId, fromSeq, toSeq, bundleRef` | — | Projector | Messages are immutable and addressed by number |
| `SessionRedacted` | AgentSession DO | `sessionId, ranges[], reason` | — | Projector | Citations into redacted ranges resolve to a redaction marker |

## delivery

| Event | Emitter | Payload | `affected[]` | `notified[]` | Reactions |
|---|---|---|---|---|---|
| `CredentialStored` | namespace object (`ns:<id>`), on `org:<id>` | `namespaceId, credential: {id, namespaceId, label, provider, createdAt, createdBy}, by: UserId` | — | Projector | An owner stored a credential. The secret was sealed in the Worker before it reached the object, and no event carries it. Members only |
| `CredentialRemoved` | namespace object (`ns:<id>`), on `org:<id>` | `namespaceId, credentialId, by: UserId` | — | Projector | An owner removed a credential, seal and all. Members only |
| `DeployTargetSet` | Project DO (`project:<id>`) | `projectId, target: {name, provider, accountId, credential}, by: UserId` | — | Projector | An owner set a deploy target, new or in place of the one of that name. `credential` is a `crd_` id, a reference into the org's credential store, never the secret. Members only |
| `DeployTargetCleared` | Project DO (`project:<id>`) | `projectId, name, by: UserId` | — | Projector | An owner removed a deploy target. Members only |
| `PreviewDeployed` | Change DO (`change:<id>`, recorded from KeelVerify's preview step) | `deploymentId, changeId, candidateId, world, target, provider, url, aliasUrl?` | — | the change's agent, Projector | A preview is a World, so probes can target it live: `world` is `candidate`, the candidate's own tree, which the deploy steps run on outside the probe matrix's worlds. One for each member change of the candidate, on that change's stream, so the agent working the change reads it in its inbox. `target` is the name of the project's deploy target. `url` is the candidate's own version; `aliasUrl` is the change's stable address, set when the candidate is that one change's |
| `PreviewTornDown` | Change DO or Lane DO | `deploymentId` | — | Projector | On land or withdrawal |
| `DeploymentPromoted` | Project DO (`project:<id>`, recorded from the Deliver Workflow) | `deploymentId, trunkSha, target, provider, stage` | — | Projector | Trunk was deployed as the deployment's version. Once per deployment and trunk commit: a redelivered promotion commits nothing. `stage` is `production`: the previewed version takes all of the Worker's traffic at once |
| `DeploymentRolledBack` | Trunk DO | `deploymentId, to, reason` | — | the escalation inbox, Projector | — |
| `DeliveryRefused` | Project DO (`project:<id>`, recorded from the Deliver Workflow) | `projectId, trunkSha, candidateId?, reason: commit-differs\|no-preview\|promote-failed, detail` | — | Projector | Trunk advanced and Keel deployed nothing. `commit-differs`: trunk's new commit is not the candidate's own commit that was previewed (a batch composed new commits, or a landing by commutation), so the version Keel previewed is not trunk's tree and is not promoted. `no-preview`: no preview of the landed candidate was made (no connected account for the deploy spec's target, or the preview did not pass). `promote-failed`: Cloudflare did not take the promote; `detail` says why, and the token is never in it. Members only |

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
- **Scoped subscriptions.** A subscription may name an entity, its scope: it then matches only events whose `entity` is that entity or whose `affected[]` holds it. A batch's members subscribe scoped to their own `change:<id>`, and the emitter sets `affected` to the member changes (the Lane on its batch events and on a batch's `VerdictIssued`; the Trunk on `TrunkAdvanced`), so no change hears another batch, and a landed change's subscriptions never match again.
- One commit's events reach each subscriber in commit order, retries included: a batch's `VerdictIssued` arrives before the `BatchFailed` committed after it.
- `ChangeSubmitted` starts Precheck; `BatchFormed` starts KeelVerify; `RulingGiven` resumes a waiting Workflow through `sendEvent`.
- Every outbox flush nudges the Projector, which drains the operation log and sleeps: the one sanctioned exception to "nothing polls".
