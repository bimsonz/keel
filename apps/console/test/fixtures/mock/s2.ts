// Scenario 2: memory.
//
// Nine days and 1,143 trunk advances after the ruling in scenario 1, its
// authors are gone. A fresh REAL session is asked to simplify the permissions
// code: preflight surfaces Decision D-1 as dated, scoped evidence, the agent
// keeps the invalidation, and its change lands through its batch. A careless
// hosted agent strips the invalidation: its batch's verification runs guard
// G-1, which holds D-1 and fails, and the change bounces on that verdict,
// citing D-1 and pointing its agent to it. That is all Keel commits of it: no
// conflict is opened from a failing guard, and nothing is said of a tenet.
//
// The log opens with scenario 1 told in full, stamped nine days in the past,
// so the world this story starts from is exactly the one that story left.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { NextAction, PrecedentRef } from "../../../src/contract/events.ts";
import { createRng } from "../prng.ts";
import { type GeneratedLog, ScriptBuilder } from "./builder.ts";
import { HEAD_2, continueInvalidate, guardedPlan, land, prelude } from "./s1.ts";
import { described } from "./plans.ts";

export const S2_EPOCH = "2026-10-22T10:14:00.000Z";

const SUBJECT_KEY = "authz.permission-evaluation";
const NINE_DAYS = 9 * 24 * 3600;
const HEAD_1143 = "71f0c2ab94e6d3857a1b0c9e4f2d68a35b7c0e19";
const HEAD_1144 = "c5a8e02f7b3d914a6e0c8f2b5d7a913e4f6b0c2d";
/** The tree the careless change's candidate was assembled as. It never became trunk's. */
const HEAD_H = "9e3b6d0c5a1f48e7b2d60c93f5a8e1d47b0c6a2e";

/** What history's ruling decided, as its decision's summary says it: a guard's failure cites it in these words. */
export const S2_DECIDED = "Cache allowed if revocation invalidates it";

/** The changes' numbers, as Keel's Projector gives them. This project has seen some since the first two. */
const NUMBER_C = "#1204";
const NUMBER_H = "#1205";

const changeRef = (id: string): EntityRef => ({ kind: "change", id });

/**
 * Scenario 2. `withdrawn` tells it to the end S-2's run on keel.town reaches: the careless change is withdrawn
 * after its bounce, by its own agent here.
 */
export function generateS2(
  seed: number,
  { withdrawn = false }: { withdrawn?: boolean } = {},
): GeneratedLog {
  const b = new ScriptBuilder(S2_EPOCH, createRng(seed).fork("s2"));

  // ── History: the conflict, the ruling, the guard, both changes landed ──
  b.offset = -NINE_DAYS;
  const p = prelude(b);
  const { decisionId } = continueInvalidate(b, p);
  const decidedAt = b.isoAt(472.4);
  b.offset = 0;
  // …and trunk has advanced 1,143 times since the decision. One event stands for them here.
  b.at(-3600).emit({
    type: "PromotionStarted",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      groupId: "grp_history",
      old: HEAD_2,
      members: [],
      batches: [],
      proofIds: [],
      committerTime: b.instant(),
    },
  });
  b.emit({
    type: "PromotionComposed",
    entity: p.trunkRef,
    payload: { projectId: p.project, groupId: "grp_history", sha: HEAD_1143, commits: [] },
  });
  b.emit({
    type: "TrunkAdvanced",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      from: HEAD_2,
      to: HEAD_1143,
      groupId: "grp_history",
      landings: [],
      height: 1143,
      x: { commuted: [] },
    },
  });

  const precedent: PrecedentRef = {
    decisionId,
    summary: "Cache allowed if revocation invalidates it",
    decidedAt: Date.parse(decidedAt),
    scope: SUBJECT_KEY,
  };
  const subject: EntityRef = { kind: "subject", id: p.subject };

  const workspaceC = b.at(1).id("wsp");
  const workspaceH = b.id("wsp");
  for (const workspace of [workspaceC, workspaceH]) {
    b.emit({
      type: "WorkspaceForked",
      entity: { kind: "workspace", id: workspace },
      payload: {
        workspaceId: workspace,
        repo: `ws-${workspace.slice(-8).toLowerCase()}`,
        sourceRepo: "mirror",
      },
    });
  }

  // ── A fresh session, C, told to simplify the permissions code ──
  const agentC = b.at(2).id("agt");
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: agentC },
    payload: {
      agentId: agentC,
      projectId: p.project,
      name: "Agent C",
      kind: "interactive",
      scopes: ["agent:work", "agent:read"],
    },
  });
  const sessionC = b.at(3).id("ses");
  b.emit({
    type: "SessionOpened",
    entity: { kind: "session", id: sessionC },
    payload: {
      sessionId: sessionC,
      agentId: agentC,
      harness: "Claude Code",
      model: "example-model-2026-09",
    },
  });
  const changeC = b.at(8).id("chg");
  const declaredC = b.emit({
    type: "IntentDeclared",
    entity: changeRef(changeC),
    label: NUMBER_C,
    payload: {
      changeId: changeC,
      agentId: agentC,
      origin: "agent",
      revision: 1,
      goal: "Simplify the permissions code",
      footprint: [
        { path: "src/authz/cache.ts", symbol: "PermissionCache", op: "edit" },
        { path: "src/authz/check.ts", symbol: "requirePermission", op: "edit" },
      ],
      premises: [
        {
          subject: SUBJECT_KEY,
          predicate: "freshness",
          relation: "at-most",
          value: "per-request",
          scope: "after a revocation",
          gloss: "A revoked collaborator is refused on the next request",
          strength: "must",
        },
      ],
      leaseId: b.id("lse"),
    },
  });
  // Preflight shows the decision as evidence, dated and scoped. It is not an instruction.
  b.at(8.2).emit({
    type: "PreflightIssued",
    entity: changeRef(changeC),
    payload: {
      changeId: changeC,
      revision: 1,
      neighbours: [],
      contradictions: [],
      precedents: [precedent],
      suggestedMove: "proceed",
    },
  });
  b.at(8.3).emit({
    type: "PrecedentSurfaced",
    entity: changeRef(changeC),
    payload: { decisionId, changeId: changeC },
  });
  const grantedC = b.at(8.4).emit({
    type: "WorkspaceGranted",
    entity: { kind: "workspace", id: workspaceC },
    payload: {
      workspaceId: workspaceC,
      holder: changeC,
      expiresAt: b.instant(b.now + 7_200_000),
      baseSha: HEAD_1143,
    },
    causation: declaredC,
  });
  b.at(8.45).emit({
    type: "ChangeStarted",
    entity: changeRef(changeC),
    payload: { changeId: changeC, workspaceId: workspaceC, baseSha: HEAD_1143 },
    causation: grantedC,
  });
  b.at(8.5).emit({
    type: "PremiseRelied",
    entity: subject,
    payload: {
      subjectId: p.subject,
      changeId: changeC,
      premise: {
        subject: SUBJECT_KEY,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
        scope: "after a revocation",
      },
    },
    causation: declaredC,
  });
  b.at(60).emit({
    type: "WorkspacePushed",
    entity: { kind: "workspace", id: workspaceC },
    payload: { workspaceId: workspaceC, ref: "refs/heads/work", sha: "3c2a91f" },
  });
  b.at(72).emit({
    type: "MessagesCaptured",
    entity: { kind: "session", id: sessionC },
    payload: { sessionId: sessionC, fromSeq: 0, toSeq: 17, bundleRef: "r2:sessions/c/0-17" },
  });

  const submittedC = b.at(95).emit({
    type: "ChangeSubmitted",
    entity: changeRef(changeC),
    payload: { changeId: changeC, revision: 1, commitSha: "3c2a91f", workspaceId: workspaceC },
  });
  const precheckC = `precheck:${changeC}:1`;
  b.at(96).emit({
    type: "PrecheckStarted",
    entity: changeRef(changeC),
    payload: { changeId: changeC, revision: 1, instanceId: precheckC },
    causation: submittedC,
  });
  b.at(99).emit({
    type: "EffectsDerived",
    entity: changeRef(changeC),
    payload: {
      changeId: changeC,
      revision: 1,
      effects: [
        {
          method: "extractor",
          evidenceClass: "ruling",
          declared: true,
          proposition: {
            subject: SUBJECT_KEY,
            predicate: "freshness",
            relation: "is",
            value: "per-session",
            scope: "until revoked",
            gloss: "Roles are cached for the session and dropped on revocation",
          },
          anchors: [{ path: "src/authz/cache.ts", symbol: "PermissionCache", commit: "3c2a91f" }],
        },
      ],
      derivationRef: `mfp:derivation:${changeC}:1`,
    },
  });
  // Near the tenet G-1 guards, so Keel's plan runs the guard, which holds D-1.
  const planC = guardedPlan("plan:8d02…f31c", p.guard, { id: decisionId, summary: S2_DECIDED });
  b.at(100).emit({
    type: "PlanCompiled",
    entity: changeRef(changeC),
    payload: {
      changeId: changeC,
      revision: 1,
      planHash: planC.hash,
      steps: planC.steps.length,
      costEstimate: 0.004,
    },
  });
  land(b, p, {
    at: 106.5,
    change: changeC,
    workspace: workspaceC,
    agent: agentC,
    from: HEAD_1143,
    to: HEAD_1144,
    height: 1144,
    label: "L1·3",
    plan: planC,
  });

  // ── A careless hosted agent, H, strips the invalidation ──
  const agentH = b.at(20).id("agt");
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: agentH },
    payload: {
      agentId: agentH,
      projectId: p.project,
      name: "hosted-217",
      kind: "hosted",
      scopes: ["agent:work", "agent:read"],
    },
  });
  const changeH = b.at(30).id("chg");
  const declaredH = b.emit({
    type: "IntentDeclared",
    entity: changeRef(changeH),
    label: NUMBER_H,
    payload: {
      changeId: changeH,
      agentId: agentH,
      origin: "agent",
      revision: 1,
      goal: "Remove unused hooks from the permission cache",
      footprint: [
        { path: "src/authz/cache.ts", symbol: "PermissionCache", op: "edit" },
        { path: "src/collaborators/revoke.ts", symbol: "revokeCollaborator", op: "edit" },
      ],
      premises: [],
      leaseId: b.id("lse"),
    },
  });
  b.at(30.2).emit({
    type: "PreflightIssued",
    entity: changeRef(changeH),
    payload: {
      changeId: changeH,
      revision: 1,
      neighbours: [],
      contradictions: [],
      precedents: [precedent],
      suggestedMove: "proceed",
    },
  });
  b.at(30.3).emit({
    type: "PrecedentSurfaced",
    entity: changeRef(changeH),
    payload: { decisionId, changeId: changeH },
  });
  const grantedH = b.at(30.4).emit({
    type: "WorkspaceGranted",
    entity: { kind: "workspace", id: workspaceH },
    payload: {
      workspaceId: workspaceH,
      holder: changeH,
      expiresAt: b.instant(b.now + 7_200_000),
      baseSha: HEAD_1143,
    },
    causation: declaredH,
  });
  b.at(30.45).emit({
    type: "ChangeStarted",
    entity: changeRef(changeH),
    payload: { changeId: changeH, workspaceId: workspaceH, baseSha: HEAD_1143 },
    causation: grantedH,
  });
  b.at(70).emit({
    type: "WorkspacePushed",
    entity: { kind: "workspace", id: workspaceH },
    payload: { workspaceId: workspaceH, ref: "refs/heads/work", sha: "d41b7e8" },
  });
  const submittedH = b.at(130).emit({
    type: "ChangeSubmitted",
    entity: changeRef(changeH),
    payload: { changeId: changeH, revision: 1, commitSha: "d41b7e8", workspaceId: workspaceH },
  });
  const precheckH = `precheck:${changeH}:1`;
  b.at(131).emit({
    type: "PrecheckStarted",
    entity: changeRef(changeH),
    payload: { changeId: changeH, revision: 1, instanceId: precheckH },
    causation: submittedH,
  });
  b.at(134).emit({
    type: "EffectsDerived",
    entity: changeRef(changeH),
    payload: {
      changeId: changeH,
      revision: 1,
      effects: [
        {
          method: "extractor",
          evidenceClass: "ruling",
          declared: false,
          proposition: {
            subject: SUBJECT_KEY,
            predicate: "freshness",
            relation: "is",
            value: "per-session",
            gloss: "Roles are cached for the session and never dropped",
          },
          anchors: [{ path: "src/authz/cache.ts", symbol: "PermissionCache", commit: "d41b7e8" }],
        },
      ],
      derivationRef: `mfp:derivation:${changeH}:1`,
    },
  });
  b.at(134.2).emit({
    type: "DriftDetected",
    entity: changeRef(changeH),
    payload: {
      changeId: changeH,
      revision: 1,
      drift: [
        {
          class: "silent-retraction",
          severity: "high",
          detail: `Derived freshness is per-session with nothing dropping it on revocation. ${NUMBER_H} declared no effect here, and guard G-1 holds the decision that it be dropped.`,
        },
      ],
    },
  });
  const planH = guardedPlan("plan:1b7e…90ad", p.guard, { id: decisionId, summary: S2_DECIDED });
  b.at(135).emit({
    type: "PlanCompiled",
    entity: changeRef(changeH),
    payload: {
      changeId: changeH,
      revision: 1,
      planHash: planH.hash,
      steps: planH.steps.length,
      costEstimate: 0.004,
    },
  });

  // Keel judges a batch's candidate, never a change alone: the verdict that bounces this change is its batch's.
  // The guard holds an active decision, so its failure blocks whatever the project's policy for the predicate.
  const batch = b.at(139).id("bat");
  const batchRef: EntityRef = { kind: "batch", id: batch };
  const queued = b.emit({
    type: "ChangeQueued",
    entity: changeRef(changeH),
    payload: { changeId: changeH, laneId: "lane-1" },
  });
  const formed = b.at(139.5).emit({
    type: "BatchFormed",
    entity: batchRef,
    payload: {
      batchId: batch,
      laneId: "lane-1",
      members: [changeH],
      base: HEAD_1144,
      attempt: 1,
      chainEpoch: 1,
      x: { label: "L1·4", heldApart: [] },
    },
    causation: queued,
  });
  b.at(139.6).emit({
    type: "ChangeBatched",
    entity: changeRef(changeH),
    payload: { changeId: changeH, batchId: batch },
    causation: formed,
  });
  const candidate = b.at(140.2).id("cnd");
  const candidateRef: EntityRef = { kind: "candidate", id: candidate };
  b.emit({
    type: "CandidateAssembled",
    entity: candidateRef,
    payload: {
      candidateId: candidate,
      batchId: batch,
      treeSha: HEAD_H,
      composer: "gitcore",
      tier: 0,
      tierReason: "Paths are disjoint from head, so no merge engine is needed",
    },
  });
  const instance = `keelverify:${batch}:1`;
  // Keel runs a batch of one on its member's plan, hash and all.
  const planHash = planH.hash;
  b.at(140.6).emit({
    type: "VerificationStarted",
    entity: candidateRef,
    payload: { candidateId: candidate, batchId: batch, instanceId: instance, planHash },
  });

  // The verdict's evidence and the ways forward are worded as Keel's `settleVerdict` words them: the failed
  // step, then the guard cited with the decision it holds, and a next action that reads that decision.
  const failed = `guard:${p.guard} (freshness): a role revoked mid-session is still allowed; it holds decision ${decisionId}: ${S2_DECIDED}`;
  // Only what failed is described on a bounce: the suite and the typecheck passed and have no line.
  const guard = planH.steps.find((step) => step.guards !== undefined);
  if (guard === undefined) throw new Error("the plan runs no guard");
  const evidence = [
    described(
      guard,
      "fail",
      "sha256:90797da7ca407aa60c45f95da887411bdf655c78e2340e27c1e1f429401d1999",
    ),
    `guard failed: ${failed}`,
  ];
  const nextActions: NextAction[] = [
    {
      kind: "call",
      title: `Fix the guarded behaviour, push, then submit again: ${failed}`,
      operationId: "submit",
      args: { failingGuards: [failed] },
    },
    {
      kind: "call",
      title: `Read decision ${decisionId}, which the failed guard holds: ${S2_DECIDED}`,
      operationId: "Memory_getDecision",
      args: { decisionId },
    },
  ];
  const verdictH = b.at(144.4).id("vrd");
  // Keel's view of the verdict: each line with the step it names, and the plan it was issued under.
  b.reasons(verdictH, "bounce", evidence, planH);
  b.emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: verdictH },
    payload: {
      verdictId: verdictH,
      subject: batch,
      outcome: "bounce",
      evidence,
      planHash,
      nextActions,
    },
  });
  // A batch of one's failure is its member's: Keel blames the change, and the change bounces on the verdict.
  b.at(144.5).emit({
    type: "BatchFailed",
    entity: batchRef,
    payload: { batchId: batch, candidateId: candidate, verdictId: verdictH, attribution: changeH },
  });
  b.at(144.6).emit({
    type: "ChangeBounced",
    entity: changeRef(changeH),
    payload: { changeId: changeH, verdictId: verdictH, reasons: evidence, nextActions },
  });
  if (withdrawn) {
    b.at(150).emit({
      type: "ChangeWithdrawn",
      entity: changeRef(changeH),
      payload: { changeId: changeH, by: agentH },
    });
    b.at(150.1).emit({
      type: "WorkspaceCollected",
      entity: { kind: "workspace", id: workspaceH },
      payload: { workspaceId: workspaceH, reason: "withdrawn" },
    });
  }

  // History's question was answered nine days ago: nothing holds this story.
  return { ...b.build(), gates: [] };
}
