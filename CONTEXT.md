# Keel

Keel is a Git platform that many agents use at once to change one codebase. It keeps trunk coherent by comparing what each change *relies on* with what each change *alters*.

## Language

### Coordination

**Change**:
One unit of intended work, identified by a Change-Id that survives rebases and squashes. It is the thing that lands on trunk, or doesn't.
_Avoid_: pull request, PR, branch, task

**Intent**:
What an agent declares about a Change before writing code: its goal, footprint and premises. Each revision is immutable.
_Avoid_: plan, ticket, claim

**Premise**:
A typed statement of what a Change *relies on* about code it doesn't own, e.g. "permission evaluation is at most per-request". Premises are declared by agents.
_Avoid_: assumption, belief (in code), dependency

**Effect**:
A typed statement of what a Change actually *alters*. Keel derives effects from the diff. When an agent declares one, it is advisory only.
_Avoid_: side effect, impact, output

**Proposition**:
The shared shape of premises and effects: subject, predicate, relation, value, scope and anchors. Two propositions can be compared once both are normalised.
_Avoid_: fact, claim, rule

**Subject**:
A named concept in the codebase, e.g. `authz.permission-evaluation`. Propositions are about subjects, and subjects are how coordination is sharded.
_Avoid_: topic, module, area

**Predicate**:
The dimension a proposition talks about, such as freshness, cardinality or ordering. Each predicate has a lattice that orders its values.
_Avoid_: property, attribute

**Anchor**:
A code symbol pinned to a commit, which ties a proposition to real code.
_Avoid_: reference, link, pointer

**Footprint**:
The paths and symbols a Change edits, creates or deletes.
_Avoid_: scope (scope belongs to a proposition), claim

**Preflight**:
What Keel tells an agent as soon as it declares an Intent: overlapping changes on the same subjects, contradictory premises, relevant precedents, and a suggested Move.
_Avoid_: check, lint, validation

**Move**:
A coordination action Keel suggests or an agent takes: proceed, coordinate, refine, sequence, yield, merge, distinguish or escalate.
_Avoid_: action, resolution

**Lease**:
A permit to act on a Change. It carries a server-minted fencing token and stays alive while the agent keeps acting. A lease is never exclusive over files.
_Avoid_: lock, claim, reservation

**Workspace**:
The throwaway Artifacts repo a Change is worked in.
_Avoid_: fork (that is the mechanism), branch, worktree

**Sketch**:
A throwaway workspace for an idea, with no Intent and no integration. It becomes a Change only when declared.
_Avoid_: draft, spike, scratch branch

**Bet**:
A premise that no tenet guards yet. Its probe is the bet's falsifier.
_Avoid_: risk, gamble (outside prose)

### Verification

**Conflict**:
A disagreement between two Changes, or between a Change and a Tenet. Its kind is textual, semantic, precedent or interaction (a batch whose union fails while every subset passes). Overlapping footprints are not a Conflict: proximity is exposure, reported in preflight. A Conflict is a first-class object with a resolution path.
_Avoid_: merge conflict (that is only the textual kind), clash

**Fallout**:
How a landed or proven effect spreads to premises that relied on it. It has three outcomes: conflict, suspect, or notify.
_Avoid_: blast radius (that is a ranking input), propagation

**World**:
One combination of Changes evaluated together: A alone, B alone, or A+B.
_Avoid_: environment, branch, build

**World matrix**:
Worlds × checks (A's tests, B's tests, the probe). Comparing the cells shows whether a disagreement is real.
_Avoid_: test matrix, CI matrix

**Probe**:
An executable check that Keel drafts to test a contested proposition.
_Avoid_: test (tests belong to the project), assertion

**Guard**:
A probe that has proven a disagreement and been admitted to the guard repo, which agents cannot write to. Only guards block on behalf of past decisions.
_Avoid_: protected test, fixture, rule

**Candidate**:
A composed tree of trunk plus one or more queued Changes, assembled to be verified before trunk advances.
_Avoid_: merge commit, build, staging branch

**Verification Plan**:
The throwaway pipeline compiled for one Change from the flow grammar and the Change's facts. Every step cites why it exists.
_Avoid_: CI config, workflow (that is the Cloudflare primitive), pipeline file

**Step**:
One typed unit of a Verification Plan. It produces an outcome and an evidence class.
_Avoid_: job, task, action

**Verdict**:
The outcome for a Change (land, bounce, park, hold or supersede), with the evidence behind it.
_Avoid_: review, approval, status check

**Evidence class**:
How much weight a piece of evidence carries:
- **proof** is executed by Keel;
- a **ruling** is a deterministic judgement over derived facts, or a human decision;
- **testimony** is a claim from outside Keel;
- **opinion** is any model output.

Only proof and rulings block.
_Avoid_: confidence level, severity

**Drift**:
The gap between what a Change declared and what Keel derived from its diff.
_Avoid_: deviation, mismatch

**Silent retraction**:
Drift where an effect the Change didn't declare contradicts a live premise or a tenet.
_Avoid_: regression (that is the observed failure, not the cause)

**Batch**:
A set of Changes from one Lane, composed into one Candidate and verified together before trunk advances.
_Avoid_: train, group (a group is several verified batches promoted in one trunk commit)

**Lane**:
A queue of Changes whose footprints fall in one partition. Batching and fairness happen per lane.
_Avoid_: branch, pipeline, merge queue (the whole system is not one queue)

**Commutation**:
When two Changes are independent enough that either order produces the same verified result. This is what lets trunk advance without rebuilding.
_Avoid_: rebase, fast-forward

**Tier**:
Where a step runs: Tier 0 is pure git inside coordination objects, Tier 1 is a throwaway isolate, Tier 2 is a container.
_Avoid_: runner type, stage

### Memory

**Tenet**:
A belief trunk currently holds: an effect that has landed and is backed by at least one guard.
_Avoid_: invariant (in code), fact, rule

**Decision**:
A recorded ruling, with its date, scope, evidence and the alternatives it rejected.
_Avoid_: ADR (ours are about building Keel), policy, rule

**Precedent**:
A Decision as later Changes encounter it: evidence, not authority. A Change can follow it, distinguish it, or ask to overrule it.
_Avoid_: instruction, constraint

**Stance**:
How a Change relates to a Precedent: followed, distinguished, or overrule requested.
_Avoid_: compliance

**Session**:
The record of an agent's working conversation. It has its own identifier, independent of commits, and its messages are immutable and addressed by number.
_Avoid_: transcript (that is the raw form), log, run

**MFP record**:
A claim made by an author (agent, platform or human) in the Model Feedback Protocol format, citing its sources.
_Avoid_: event (events are facts), log line, message

### Identity

**Agent**:
A principal that uses Keel to change code. Keel never runs, schedules or prompts agents.
_Avoid_: bot, worker, job

**Declaration fidelity**:
The share of an agent's derived effects that the agent had declared. It is used to route review, never to judge the agent.
_Avoid_: trust score, reputation

### Delivery

**Deployment**:
The act of putting a candidate or trunk somewhere it can run. Every target sits behind one port.
_Avoid_: release, ship

**Preview**:
A throwaway deployment of one World, so probes can run against it live.
_Avoid_: staging, review app

**Promotion**:
Moving a deployment toward production after a Change lands, e.g. gradually from 10% to 100%.
_Avoid_: release, rollout (the mechanism), go-live

### Agent surface

**Notice**:
A short message Keel attaches to an agent's next tool result, or pushes to the agent, when something it relies on changes.
_Avoid_: notification, alert, webhook (that is a transport)

**Escalation**:
A question routed to a person, with options and their consequences. Answering it produces a Decision.
_Avoid_: review request, ticket, approval
