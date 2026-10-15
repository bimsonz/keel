/**
 * Each machine's statechart, typed from docs/domain/state-machines.md's
 * tables. They check the machines (see chart-kit.ts) and draw the docs'
 * diagrams (render.ts); nothing here drives a machine.
 */
import type { Chart, Target } from "./chart-kit.ts";

const to = (id: string) => (path: string) => `#${id}.${path}`;

// Change

const c = to("change");
/** Withdrawal and supersession, from every state but Integrating and the terminals. */
const ends = { ChangeWithdrawn: c("withdrawn"), ChangeSuperseded: c("superseded") };
/** Adoption of a lapsed lease, where the change waits on its agent: under the platform a lease does not lapse. */
const waits = (state: string) => ({ ChangeAdopted: c(state) });
const lapses = { ChangeParked: c("parked.leaseLapsed") };

export const changeChart: Chart = {
  id: "change",
  initial: "declared",
  meta: { createdBy: "IntentDeclared", section: "Change" },
  states: {
    declared: { on: { ChangeStarted: c("working"), ...lapses, ...waits("declared"), ...ends } },
    working: {
      on: {
        IntentRevised: c("working"),
        ChangeSubmitted: c("submitted"),
        ChangeRebased: c("working"),
        ...lapses,
        ...waits("working"),
        ...ends,
      },
    },
    submitted: { on: { PrecheckStarted: c("deriving"), ...ends } },
    deriving: {
      on: {
        ChangeDrifted: c("drifted"),
        PlanCompiled: c("verifying"),
        ChangeBounced: c("bounced"),
        ...ends,
      },
    },
    drifted: { on: { IntentRevised: c("working"), ...lapses, ...waits("drifted"), ...ends } },
    verifying: {
      on: {
        ChangeQueued: c("queued"),
        ChangeParked: c("parked.awaitingRuling"),
        ChangeBounced: c("bounced"),
        ...ends,
      },
    },
    queued: {
      on: {
        ChangeBatched: c("integrating"),
        ChangeParked: c("parked.awaitingRuling"),
        ChangeBounced: c("bounced"),
        ...ends,
      },
    },
    integrating: {
      on: {
        ChangeRequeued: c("queued"),
        ChangeBounced: c("bounced"),
        ChangeLanded: c("landed"),
      },
    },
    bounced: {
      on: {
        IntentRevised: c("working"),
        ChangeSubmitted: c("submitted"),
        ChangeRebased: c("bounced"),
        ...lapses,
        ...waits("bounced"),
        ...ends,
      },
    },
    parked: {
      initial: "awaitingRuling",
      on: { ...ends },
      states: {
        awaitingRuling: {
          on: {
            ChangeResumed: [
              { target: c("verifying"), guard: "parked from Verifying" },
              { target: c("queued"), guard: "parked from Queued" },
            ],
            ChangeBounced: c("bounced"),
            // Held by another question: it waits on that one, from where it first parked.
            ChangeParked: c("parked.awaitingRuling"),
          },
        },
        leaseLapsed: {
          on: {
            // Back to work; a change parked before its workspace was granted is still waiting for one.
            ChangeAdopted: [
              { target: c("working"), guard: "has-workspace" },
              { target: c("declared"), guard: "no-workspace" },
            ],
          },
        },
      },
    },
    landed: { type: "final" },
    withdrawn: { type: "final" },
    superseded: { type: "final" },
  },
};

// Lease: the life of one lease, so adoption supersedes the old lease (the new one starts Active).
// It lapses only while the change waits on its agent, so a change lands under an Active lease.

const l = to("lease");
const ended = { ChangeWithdrawn: l("released"), ChangeSuperseded: l("released") };

export const leaseChart: Chart = {
  id: "lease",
  initial: "active",
  meta: { createdBy: "IntentDeclared / ChangeAdopted", section: "Lease" },
  states: {
    active: {
      on: {
        LeaseLapsed: l("lapsed"),
        // The platform hands the change back: the 15 minutes start again.
        LeaseRestarted: l("active"),
        ChangeParked: [{ target: l("active"), guard: "awaiting-ruling" }],
        ChangeAdopted: l("superseded"),
        ChangeLanded: l("released"),
        ...ended,
      },
    },
    lapsed: { on: { ChangeParked: l("lapsed"), ChangeAdopted: l("superseded"), ...ended } },
    released: { type: "final" },
    superseded: { type: "final" },
  },
};

// Candidate

const b = to("candidate");
export const candidateChart: Chart = {
  id: "candidate",
  initial: "forming",
  meta: { createdBy: "BatchFormed", section: "Candidate" },
  states: {
    // Cancelled (CandidateInvalidated) when a batch it was speculated behind fails.
    forming: {
      on: {
        CandidateAssembled: b("assembled"),
        BatchFailed: b("red"),
        CandidateInvalidated: b("invalidated"),
      },
    },
    // A refused bundle fails the batch before verification starts.
    assembled: {
      on: {
        VerificationStarted: b("verifying"),
        BatchFailed: b("red"),
        CandidateInvalidated: b("invalidated"),
      },
    },
    verifying: {
      on: {
        BatchVerified: b("green"),
        BatchFailed: b("red"),
        CandidateInvalidated: b("invalidated"),
      },
    },
    green: { on: { CandidatePromoted: b("promoted"), CandidateInvalidated: b("invalidated") } },
    // Terminal unless several members failed and nobody is blamed yet: then it is bisected.
    red: { tags: ["terminal"], on: { CandidateBisected: b("bisected") } },
    promoted: { type: "final" },
    invalidated: { type: "final" },
    bisected: { type: "final" },
  },
};

// Promotion (Trunk DO): a long-lived entity, so no final state.

const p = to("promotion");
const settles = (event: string): Readonly<Record<string, Target>> => ({
  [event]: [
    { target: p("idle"), guard: "queue-empty" },
    { target: p("debouncing"), guard: "batches-waiting" },
  ],
});

export const promotionChart: Chart = {
  id: "promotion",
  initial: "idle",
  meta: { createdBy: "TrunkInitialized", section: "Promotion (Trunk DO)" },
  states: {
    // A cancelled batch is dropped in any phase, or remembered before its verdict arrives.
    idle: {
      on: {
        BatchVerified: p("debouncing"),
        TrunkSyncStarted: p("syncing"),
        BatchDropped: p("idle"),
      },
    },
    debouncing: {
      on: {
        BatchVerified: p("debouncing"),
        ...settles("PromotionDeclined"),
        ...settles("BatchDropped"),
        PromotionStarted: p("promoting"),
        PromotionFrozen: p("frozen"),
        TrunkSyncStarted: p("syncing"),
      },
    },
    // A sync from upstream: its write-ahead entry, then main moved and read back. Batches queue meanwhile.
    syncing: {
      on: {
        BatchVerified: p("syncing"),
        ...settles("TrunkSynced"),
        BatchDropped: p("syncing"),
        PromotionFrozen: p("frozen"),
      },
    },
    promoting: {
      on: {
        BatchVerified: p("promoting"),
        BatchDropped: p("promoting"),
        PromotionComposed: p("promoting"),
        ...settles("TrunkAdvanced"),
        // A refused push declines the group's batches one by one; the last ends the group.
        PromotionDeclined: [
          { target: p("promoting"), guard: "group-open" },
          { target: p("idle"), guard: "queue-empty" },
          { target: p("debouncing"), guard: "batches-waiting" },
        ],
        PromotionFrozen: p("frozen"),
      },
    },
    frozen: {
      on: {
        BatchVerified: p("frozen"),
        BatchDropped: p("frozen"),
        PromotionDeclined: p("frozen"),
        ...settles("PromotionResumed"),
      },
    },
  },
};

// Workspace

const w = to("workspace");
export const workspaceChart: Chart = {
  id: "workspace",
  initial: "ready",
  meta: { createdBy: "WorkspaceForked", section: "Workspace" },
  states: {
    ready: { on: { WorkspaceGranted: w("granted"), WorkspaceCollected: w("collected") } },
    granted: { on: { WorkspaceCollected: w("collected") } },
    collected: { type: "final" },
  },
};

// Agent

const a = to("agent");
export const agentChart: Chart = {
  id: "agent",
  initial: "active",
  meta: { createdBy: "AgentEnrolled / AgentSignedUp", section: "Agent" },
  states: {
    active: {
      on: {
        AgentSuspended: a("suspended"),
        AgentRevoked: a("revoked"),
        AgentSponsored: a("active"),
        AgentUnsponsored: a("active"),
      },
    },
    suspended: {
      on: {
        AgentReinstated: a("active"),
        AgentRevoked: a("revoked"),
      },
    },
    revoked: { type: "final" },
  },
};

// Invitation: an agent's place in one namespace, or on one project of a person's. The two share
// every edge under their own events. Ended is where a run may rest, and no end: the agent may be
// invited again.
const i = to("invitation");

export const invitationChart: Chart = {
  id: "invitation",
  initial: "invited",
  meta: { createdBy: "AgentInvited / AgentInvitedToProject", section: "Invitation" },
  states: {
    invited: {
      on: {
        AgentJoinedNamespace: i("joined"),
        AgentJoinedProject: i("joined"),
        AgentLeftNamespace: i("ended"),
        AgentLeftProject: i("ended"),
      },
    },
    joined: { on: { AgentLeftNamespace: i("ended"), AgentLeftProject: i("ended") } },
    ended: {
      tags: ["terminal"],
      on: { AgentInvited: i("invited"), AgentInvitedToProject: i("invited") },
    },
  },
};

// Conflict
const f = to("conflict");
/** Out of an open conflict: proof, a ruling or a non-discriminating probe, or escalation when it is unprovable. */
const unsettled = {
  ConflictProven: f("proven"),
  ConflictDismissed: f("dismissed"),
  ConflictEscalated: f("escalated"),
};

/** A suite's cell that completes after the probe has decided: a fact of a conflict whose probe was drafted, which stays where it is. */
const lateCheck = (state: string) => ({
  WorldCheckRan: [{ target: f(state), guard: "probe-drafted" }],
});

export const conflictChart: Chart = {
  id: "conflict",
  initial: "suspected",
  meta: { createdBy: "ConflictSuspected", section: "Conflict" },
  states: {
    suspected: { on: { ProbeDrafted: f("probing"), ...unsettled } },
    probing: { on: { ProbeRan: f("probing"), WorldCheckRan: f("probing"), ...unsettled } },
    proven: {
      on: {
        ConflictResolved: f("resolved"),
        ConflictEscalated: f("escalated"),
        ...lateCheck("proven"),
      },
    },
    escalated: { on: { ConflictResolved: f("resolved"), ...lateCheck("escalated") } },
    // Terminal, though a late suite cell is still recorded: an xstate final state takes no event.
    resolved: { tags: ["terminal"], on: lateCheck("resolved") },
    dismissed: { tags: ["terminal"], on: lateCheck("dismissed") },
  },
};

// Probe → Guard: a probe whose drafts all failed begins Discarded.
const g = to("probe");

export const probeChart: Chart = {
  id: "probe",
  initial: "calibrating",
  meta: {
    createdBy: "ProbeDrafted",
    section: "Probe → Guard",
    alsoCreated: [{ event: "ProbeDiscarded", target: "discarded", guard: "draft-failed" }],
  },
  states: {
    calibrating: {
      on: {
        ProbeRan: g("calibrating"),
        GuardAdmitted: g("admitted"),
        ProbeDiscarded: g("discarded"),
      },
    },
    admitted: { on: { GuardRetired: g("retired") } },
    discarded: { type: "final" },
    retired: { type: "final" },
  },
};

// Escalation: the owner holds while it is open; nothing applies the default.
const e = to("escalation");

export const escalationChart: Chart = {
  id: "escalation",
  initial: "open",
  meta: { createdBy: "EscalationRaised", section: "Escalation" },
  states: {
    open: {
      on: {
        RulingGiven: e("ruled"),
        EscalationWithdrawn: e("withdrawn"),
        EscalationWidened: e("open"),
      },
    },
    ruled: { type: "final" },
    withdrawn: { type: "final" },
  },
};

// Decision: recorded from a ruling; a precedent's stances never change its state.
const d = to("decision");

export const decisionChart: Chart = {
  id: "decision",
  initial: "active",
  meta: { createdBy: "DecisionRecorded", section: "Decision" },
  states: {
    active: { on: { DecisionSuperseded: d("superseded"), DecisionOverruled: d("overruled") } },
    superseded: { type: "final" },
    overruled: { type: "final" },
  },
};

// Tenet: only retraction reads the project's policy, and both its paths share one edge.
const t = to("tenet");

export const tenetChart: Chart = {
  id: "tenet",
  initial: "established",
  meta: { createdBy: "TenetEstablished", section: "Tenet" },
  states: {
    established: { on: { TenetContested: t("contested"), TenetSuperseded: t("superseded") } },
    contested: { on: { TenetReaffirmed: t("established"), TenetRetracted: t("retracted") } },
    retracted: { type: "final" },
    superseded: { type: "final" },
  },
};

export const charts: readonly Chart[] = [
  changeChart,
  leaseChart,
  candidateChart,
  promotionChart,
  workspaceChart,
  agentChart,
  invitationChart,
  conflictChart,
  probeChart,
  escalationChart,
  decisionChart,
  tenetChart,
];
