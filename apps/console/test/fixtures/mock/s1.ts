// Scenario 1: the semantic conflict.
//
// Two REAL agents work on authz.permission-evaluation. A relies on freshness
// being at most per-request. B submits without declaring an effect; Keel
// derives per-session: a silent retraction. A conflict opens, a probe is
// drafted, the world matrix fills, and a person is asked. The story holds at
// that question until someone rules, then follows the option they chose.
//
// "A" and "B" are the story's names, and Keel's names for the two sides of
// the conflict. Keel numbers the changes themselves as they are declared: B,
// declared first, is #1, and A is #2.
//
// Times are seconds of simulated time from the epoch. The beat map decides how
// fast each stretch plays.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { AnyEvent, DriftEntry, ProbeWorld } from "../../../src/contract/events.ts";
import type { EventPredicatePolicies } from "../../../src/contract/keel/index.ts";
import type { DerivedEffect, Proposition } from "../../../src/contract/mfp.ts";
import type { EscalationOption } from "../../../src/contract/events.ts";
import type { EvidenceLine, FlowNode, StepSpec } from "../../../src/contract/provisional.ts";
import { type Rng, createRng } from "../prng.ts";
import {
  BASE_ANCHORS,
  BASE_FILES,
  LANDED_A,
  LANDED_B_AS_WRITTEN,
  LANDED_B_INVALIDATING,
  type Landing,
} from "../repo.ts";
import { CACHE_AFTER, CHECK_AFTER, CHECK_BEFORE, PROBE_SOURCE } from "../s1.ts";
import { type GeneratedLog, PLATFORM_PROJECT, ScriptBuilder } from "./builder.ts";

export const S1_EPOCH = "2026-10-13T16:05:30.000Z";

export type S1Ruling = "no-cache" | "invalidate" | "allow-stale";

/** The changes' numbers, as Keel's Projector gives them: in the order they were declared. */
const NUMBER_B = "#1";
const NUMBER_A = "#2";

/** What a person can choose. */
export const S1_CHOICES: EscalationOption[] = [
  {
    id: "no-cache",
    label: "Never cache permission checks",
    consequence: `${NUMBER_B} cannot land as written, and checks stay as slow as they are. Revocation is immediate.`,
  },
  {
    id: "invalidate",
    label: "Cache allowed if revocation invalidates it",
    consequence: `${NUMBER_B} revises to drop a session's cached roles on revocation. Both changes land. The probe stays as a guard.`,
  },
  {
    id: "allow-stale",
    label: "Cache for the session; revocation applies at next sign-in",
    consequence: `A revoked collaborator keeps access until their session ends. ${NUMBER_A} must relax its premise, and the guard is retired.`,
  },
];

/** What stands until someone does: the question's default. */
export const S1_HOLD: EscalationOption = {
  id: "hold",
  label: "Both changes wait",
  consequence: "Nothing lands on this subject.",
};

export const S1_OPTIONS: EscalationOption[] = [...S1_CHOICES, S1_HOLD];

const SUBJECT_KEY = "authz.permission-evaluation";

const subjectRef = (id: string): EntityRef => ({ kind: "subject", id });
const changeRef = (id: string): EntityRef => ({ kind: "change", id });

const step = (spec: StepSpec): FlowNode => ({ op: "step", step: spec });

/** B's Verification Plan. With `guard`, it also runs the admitted guard, citing the decision. */
export function planForB(guard: { label: string; decision: string } | null): FlowNode {
  const steps: FlowNode[] = [
    step({
      id: "diff",
      title: "Tree diff against trunk",
      kind: "deterministic",
      tier: 0,
      tierReason: "Pure git",
      evidenceCeiling: "proof",
      because: { text: "Every change is diffed against the head it will land on" },
    }),
    step({
      id: "protected",
      title: "Protected and guard paths untouched",
      kind: "deterministic",
      tier: 0,
      tierReason: "Pure git",
      evidenceCeiling: "ruling",
      because: { text: "A change may not edit its own checks" },
    }),
    {
      op: "cascade",
      of: [
        step({
          id: "extract",
          title: "Derive effects: extractors",
          kind: "deterministic",
          tier: 1,
          tierReason: "Reads repository text, runs none of it",
          evidenceCeiling: "proof",
          because: { text: "Effects are derived from the diff, never taken from the agent" },
        }),
        step({
          id: "clef",
          title: "Derive effects: Clef",
          kind: "decision-model",
          tier: 1,
          tierReason: "One budgeted model call",
          evidenceCeiling: "opinion",
          because: { text: "The extractors left requirePermission's freshness unresolved" },
        }),
      ],
    },
    step({
      id: "lattice",
      title: `Compare propositions on ${SUBJECT_KEY}`,
      kind: "deterministic",
      tier: 0,
      tierReason: "A table lookup",
      evidenceCeiling: "ruling",
      because: {
        text: `${NUMBER_A} relies on freshness at most per-request`,
        cites: `premise:${NUMBER_A}`,
      },
    }),
    {
      op: "par",
      of: [
        step({
          id: "typecheck",
          title: "Typecheck",
          kind: "deterministic",
          tier: 1,
          tierReason: "Fits in an isolate",
          evidenceCeiling: "proof",
          because: { text: "The footprint is TypeScript" },
        }),
        step({
          id: "unit",
          title: "Project tests, 27 selected",
          kind: "deterministic",
          tier: 1,
          tierReason: "Worker-native tests",
          evidenceCeiling: "proof",
          because: { text: "The footprint touches src/authz" },
        }),
      ],
    },
  ];
  if (guard === null) {
    steps.push({
      op: "worlds",
      over: ["trunk", "A", "B", "AB"],
      of: step({
        id: "probe",
        title: "World matrix: probe P-1",
        kind: "probe",
        tier: 1,
        tierReason: "One throwaway isolate per world",
        evidenceCeiling: "proof",
        because: {
          text: "Conflict C-1 was suspected, and only a probe can prove it",
          cites: "conflict:C-1",
        },
      }),
    });
    steps.push(
      step({
        id: "ruling",
        title: "Ruling on E-1",
        kind: "human",
        tier: null,
        tierReason: "A person",
        evidenceCeiling: "ruling",
        because: { text: "Permission semantics are human-class" },
      }),
    );
  } else {
    steps.push({
      op: "worlds",
      over: ["trunk", "AB"],
      of: step({
        id: "guard",
        title: `Guard ${guard.label}`,
        kind: "probe",
        tier: 1,
        tierReason: "One throwaway isolate per world",
        evidenceCeiling: "proof",
        because: {
          text: `Decision ${guard.decision}: cache allowed if revocation invalidates it`,
          cites: "decision:D-1",
        },
      }),
    });
  }
  return { op: "seq", of: steps };
}

/** Records one step of a run as Keel's step observations: running, then how it ended. */
export function stepRunOn(b: ScriptBuilder) {
  return (
    at: number,
    instanceId: string,
    subjectId: string,
    stepId: string,
    tier: 0 | 1 | 2 | null,
    seconds: number,
    status: "passed" | "failed" | "annotated",
    usd?: number,
  ): void => {
    const sandboxId = tier === 1 ? `iso-${stepId}-${Math.round(at)}` : undefined;
    b.at(at).observe({
      kind: "step",
      instanceId,
      subject: subjectId,
      stepId,
      status: "running",
      tier,
      attempt: 1,
      ...(sandboxId === undefined ? {} : { sandboxId }),
    });
    b.at(at + seconds).observe({
      kind: "step",
      instanceId,
      subject: subjectId,
      stepId,
      status,
      tier,
      attempt: 1,
      ...(sandboxId === undefined ? {} : { sandboxId }),
      cost: { ms: Math.round(seconds * 1000), ...(usd === undefined ? {} : { usd }) },
    });
  };
}

/**
 * Everything up to the proof: both changes submitted, and the conflict between them probed and proven. With
 * `policy`, each change's plan compiles that predicate policy, which is what Keel applies to a proof.
 */
export function opening(b: ScriptBuilder, policy?: EventPredicatePolicies) {
  const project = b.at(0).id("prj");
  b.project = project;
  // The Trunk DO is its own entity, named for its project, with its own seq.
  const trunkRef: EntityRef = { kind: "trunk", id: project };
  const operator = b.id("agt");
  const subject = b.id("sub");
  const head0 = "4b1d9e0c7a2f5381966be0d4c3a7f1e2b8d05a46";

  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: operator },
    payload: {
      agentId: operator,
      projectId: PLATFORM_PROJECT,
      name: "Judge",
      kind: "human",
      scopes: ["operator"],
    },
  });
  b.emit({
    type: "ProjectCreated",
    entity: { kind: "project", id: project },
    payload: { projectId: project, name: "demo", by: operator },
  });
  b.repository = { base: BASE_FILES, anchors: BASE_ANCHORS, landings: new Map() };
  // Nothing is queued or promoted before trunk's first head is known.
  b.emit({
    type: "TrunkInitialized",
    entity: trunkRef,
    payload: { projectId: project, head: head0, by: operator },
  });
  b.emit({
    type: "SubjectMinted",
    entity: subjectRef(subject),
    payload: {
      subjectId: subject,
      key: SUBJECT_KEY,
      anchors: [
        { path: "src/authz/check.ts", symbol: "requirePermission", commit: head0.slice(0, 7) },
      ],
      gloss: "How a request's permissions are decided",
      mintedBy: "scan",
    },
  });

  // The pool keeps forks ready, so a declared change gets a workspace at once.
  const workspaceB = b.at(1).id("wsp");
  const workspaceA = b.id("wsp");
  for (const workspace of [workspaceB, workspaceA]) {
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

  // ── Onboarding: two REAL sessions join ──
  const agentB = b.at(2).id("agt");
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: agentB },
    payload: {
      agentId: agentB,
      projectId: project,
      name: "Agent B",
      kind: "interactive",
      scopes: ["agent:work", "agent:read"],
    },
  });
  const sessionB = b.at(4).id("ses");
  b.emit({
    type: "SessionOpened",
    entity: { kind: "session", id: sessionB },
    payload: {
      sessionId: sessionB,
      agentId: agentB,
      harness: "Claude Code",
      model: "example-model-2026-09",
    },
  });
  const agentA = b.at(14).id("agt");
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: agentA },
    payload: {
      agentId: agentA,
      projectId: project,
      name: "Agent A",
      kind: "interactive",
      scopes: ["agent:work", "agent:read"],
    },
  });
  const sessionA = b.at(16).id("ses");
  b.emit({
    type: "SessionOpened",
    entity: { kind: "session", id: sessionA },
    payload: {
      sessionId: sessionA,
      agentId: agentA,
      harness: "Claude Code",
      model: "example-model-2026-09",
    },
  });

  // ── Declare: B is vague, A is typed ──
  const premiseB: Proposition = {
    subject: SUBJECT_KEY,
    predicate: "invariant",
    relation: "is",
    value: "unchanged",
    gloss: "Permission checks behave as before, only faster",
    strength: "should",
  };
  const changeB = b.at(36).id("chg");
  const leaseB = b.id("lse");
  const declaredB = b.emit({
    type: "IntentDeclared",
    entity: changeRef(changeB),
    label: NUMBER_B,
    payload: {
      changeId: changeB,
      agentId: agentB,
      origin: "agent",
      revision: 1,
      goal: "Speed up permission checks",
      footprint: [{ path: "src/authz/check.ts", symbol: "requirePermission", op: "edit" }],
      premises: [premiseB],
      leaseId: leaseB,
    },
  });
  b.after(0.2).emit({
    type: "PreflightIssued",
    entity: changeRef(changeB),
    payload: {
      changeId: changeB,
      revision: 1,
      neighbours: [],
      contradictions: [],
      precedents: [],
      suggestedMove: "proceed",
    },
  });
  const grantedB = b.after(0.2).emit({
    type: "WorkspaceGranted",
    entity: { kind: "workspace", id: workspaceB },
    payload: {
      workspaceId: workspaceB,
      holder: changeB,
      expiresAt: b.instant(b.now + 7_200_000),
      baseSha: head0,
    },
    causation: declaredB,
  });
  b.after(0.05).emit({
    type: "ChangeStarted",
    entity: changeRef(changeB),
    payload: { changeId: changeB, workspaceId: workspaceB, baseSha: head0 },
    causation: grantedB,
  });
  b.after(0.05).emit({
    type: "PremiseRelied",
    entity: subjectRef(subject),
    payload: {
      subjectId: subject,
      changeId: changeB,
      premise: { subject: SUBJECT_KEY, predicate: "invariant", relation: "is", value: "unchanged" },
    },
    causation: declaredB,
  });

  const premiseA: Proposition = {
    subject: SUBJECT_KEY,
    predicate: "freshness",
    relation: "at-most",
    value: "per-request",
    gloss: "requirePermission re-reads roles on every request",
    strength: "must",
  };
  const changeA = b.at(50).id("chg");
  const leaseA = b.id("lse");
  const declaredA = b.emit({
    type: "IntentDeclared",
    entity: changeRef(changeA),
    label: NUMBER_A,
    payload: {
      changeId: changeA,
      agentId: agentA,
      origin: "agent",
      revision: 1,
      goal: "Owners can revoke collaborators, effective immediately",
      footprint: [
        { path: "src/collaborators/revoke.ts", op: "create" },
        { path: "src/collaborators/routes.ts", op: "edit" },
      ],
      premises: [premiseA],
      leaseId: leaseA,
    },
  });
  b.after(0.3).emit({
    type: "PreflightIssued",
    entity: changeRef(changeA),
    payload: {
      changeId: changeA,
      revision: 1,
      neighbours: [
        {
          changeId: changeB,
          goal: "Speed up permission checks",
          subjects: [SUBJECT_KEY],
          overlap: "subject",
        },
      ],
      contradictions: [],
      precedents: [],
      suggestedMove: "proceed",
    },
  });
  const grantedA = b.after(0.2).emit({
    type: "WorkspaceGranted",
    entity: { kind: "workspace", id: workspaceA },
    payload: {
      workspaceId: workspaceA,
      holder: changeA,
      expiresAt: b.instant(b.now + 7_200_000),
      baseSha: head0,
    },
    causation: declaredA,
  });
  b.after(0.05).emit({
    type: "ChangeStarted",
    entity: changeRef(changeA),
    payload: { changeId: changeA, workspaceId: workspaceA, baseSha: head0 },
    causation: grantedA,
  });
  b.after(0.05).emit({
    type: "PremiseRelied",
    entity: subjectRef(subject),
    payload: {
      subjectId: subject,
      changeId: changeA,
      premise: {
        subject: SUBJECT_KEY,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
      },
    },
    causation: declaredA,
  });

  // ── Work: pushes are observed, never authoritative ──
  const pushes: [number, string, string][] = [
    [140, workspaceB, "71c0a94"],
    [200, workspaceA, "0d3be17"],
    [260, workspaceB, "c88f2b0"],
    [330, workspaceA, "5a90e6d"],
    [372, workspaceB, "e5f6a7b"],
  ];
  for (const [second, workspace, sha] of pushes) {
    b.at(second).emit({
      type: "WorkspacePushed",
      entity: { kind: "workspace", id: workspace },
      payload: { workspaceId: workspace, ref: "refs/heads/work", sha },
    });
  }
  b.at(120).emit({
    type: "MessagesCaptured",
    entity: { kind: "session", id: sessionB },
    payload: { sessionId: sessionB, fromSeq: 0, toSeq: 21, bundleRef: "r2:sessions/b/0-21" },
  });
  b.at(300).emit({
    type: "MessagesCaptured",
    entity: { kind: "session", id: sessionA },
    payload: { sessionId: sessionA, fromSeq: 0, toSeq: 34, bundleRef: "r2:sessions/a/0-34" },
  });

  // ── B submits. Keel derives what the diff actually alters ──
  const submittedB = b.at(390).emit({
    type: "ChangeSubmitted",
    entity: changeRef(changeB),
    payload: { changeId: changeB, revision: 1, commitSha: "e5f6a7b", workspaceId: workspaceB },
  });
  const precheckB = `precheck:${changeB}:1`;
  b.after(1).emit({
    type: "PrecheckStarted",
    entity: changeRef(changeB),
    payload: { changeId: changeB, revision: 1, instanceId: precheckB },
    causation: submittedB,
  });
  const stepRun = stepRunOn(b);
  stepRun(391.1, precheckB, changeB, "diff", 0, 0.1, "passed");
  stepRun(391.3, precheckB, changeB, "protected", 0, 0.1, "passed");
  stepRun(391.6, precheckB, changeB, "extract", 1, 1.8, "passed");
  stepRun(393.5, precheckB, changeB, "clef", 1, 1.3, "annotated", 0.0004);

  const effectsB: DerivedEffect[] = [
    {
      method: "extractor",
      evidenceClass: "ruling",
      declared: false,
      proposition: {
        subject: SUBJECT_KEY,
        predicate: "freshness",
        relation: "is",
        value: "per-session",
        gloss: "Roles are cached for the life of the session",
      },
      anchors: [{ path: "src/authz/cache.ts", symbol: "PermissionCache", commit: "e5f6a7b" }],
    },
    {
      method: "clef",
      evidenceClass: "opinion",
      p: 0.93,
      declared: false,
      proposition: {
        subject: SUBJECT_KEY,
        predicate: "freshness",
        relation: "at-least",
        value: "per-session",
        gloss: "Permissions are cached for the whole session",
      },
      anchors: [{ path: "src/authz/check.ts", symbol: "requirePermission", commit: "e5f6a7b" }],
    },
  ];
  const derivedB = b.at(395).emit({
    type: "EffectsDerived",
    entity: changeRef(changeB),
    payload: {
      changeId: changeB,
      revision: 1,
      effects: effectsB,
      derivationRef: `mfp:derivation:${changeB}:1`,
    },
  });
  const driftB: DriftEntry[] = [
    {
      class: "silent-retraction",
      severity: "high",
      detail: `Derived freshness is per-session. ${NUMBER_B} declared no effect here, and ${NUMBER_A} relies on at most per-request.`,
    },
  ];
  b.after(1).emit({
    type: "DriftDetected",
    entity: changeRef(changeB),
    payload: { changeId: changeB, revision: 1, drift: driftB },
  });
  stepRun(396, precheckB, changeB, "lattice", 0, 0.1, "failed");

  const conflict = b.at(396.2).id("cfl");
  const conflictRef: EntityRef = { kind: "conflict", id: conflict };
  const suspected = b.emit({
    type: "ConflictSuspected",
    entity: conflictRef,
    label: "C-1",
    payload: {
      conflictId: conflict,
      kind: "semantic",
      parties: [changeA, changeB],
      subjectId: subject,
      predicate: "freshness",
      x: {
        summary: `${NUMBER_A} relies on freshness at most per-request. ${NUMBER_B} makes it per-session.`,
        silentRetraction: true,
      },
    },
    causation: derivedB,
  });
  b.at(397).emit({
    type: "PlanCompiled",
    entity: changeRef(changeB),
    payload: {
      changeId: changeB,
      revision: 1,
      planHash: "plan:3f9a…d27e",
      steps: planForB(null),
      costEstimate: 0.006,
      ...(policy === undefined ? {} : { predicatePolicy: policy }),
    },
  });
  stepRun(397.2, precheckB, changeB, "typecheck", 1, 2.1, "passed");
  stepRun(397.2, precheckB, changeB, "unit", 1, 3.4, "passed");

  // A has finished too, and submits. Its plan passes; the open conflict keeps it from queueing.
  const submittedA = b.at(400).emit({
    type: "ChangeSubmitted",
    entity: changeRef(changeA),
    payload: { changeId: changeA, revision: 1, commitSha: "5a90e6d", workspaceId: workspaceA },
  });
  b.after(1).emit({
    type: "PrecheckStarted",
    entity: changeRef(changeA),
    payload: { changeId: changeA, revision: 1, instanceId: `precheck:${changeA}:1` },
    causation: submittedA,
  });
  b.at(404).emit({
    type: "EffectsDerived",
    entity: changeRef(changeA),
    payload: {
      changeId: changeA,
      revision: 1,
      effects: [
        {
          method: "extractor",
          evidenceClass: "ruling",
          declared: false,
          proposition: {
            subject: "collab.revocation",
            predicate: "presence",
            relation: "is",
            value: true,
            gloss: "An owner can remove a collaborator",
          },
          anchors: [
            {
              path: "src/collaborators/revoke.ts",
              symbol: "revokeCollaborator",
              commit: "5a90e6d",
            },
          ],
        },
      ],
      derivationRef: `mfp:derivation:${changeA}:1`,
    },
  });
  b.at(405).emit({
    type: "PlanCompiled",
    entity: changeRef(changeA),
    payload: {
      changeId: changeA,
      revision: 1,
      planHash: "plan:81c2…0b6f",
      steps: {
        op: "seq",
        of: [
          step({
            id: "diff",
            title: "Tree diff against trunk",
            kind: "deterministic",
            tier: 0,
            tierReason: "Pure git",
            evidenceCeiling: "proof",
            because: { text: "Every change is diffed against the head it will land on" },
          }),
          step({
            id: "unit",
            title: "Project tests, 31 selected",
            kind: "deterministic",
            tier: 1,
            tierReason: "Worker-native tests",
            evidenceCeiling: "proof",
            because: { text: "The footprint touches src/collaborators" },
          }),
        ],
      },
      costEstimate: 0.002,
      ...(policy === undefined ? {} : { predicatePolicy: policy }),
    },
  });

  // ── The probe, and the world matrix, cell by cell ──
  const probe = b.at(406).id("prb");
  const probeRef: EntityRef = { kind: "probe", id: probe };
  b.emit({
    type: "ProbeDrafted",
    entity: probeRef,
    label: "P-1",
    payload: {
      probeId: probe,
      conflictId: conflict,
      attempts: 1,
      bundleHash: "sha256:7be4…c19a",
      x: { path: "probes/authz.permission-evaluation/freshness.probe.ts" },
    },
    causation: suspected,
  });
  b.probes.set(probe, {
    probeId: probe,
    path: "probes/authz.permission-evaluation/freshness.probe.ts",
    source: PROBE_SOURCE,
  });
  b.diffs.set(changeB, {
    changeId: changeB,
    commit: "e5f6a7b",
    files: [
      { path: "src/authz/check.ts", before: CHECK_BEFORE, after: CHECK_AFTER },
      { path: "src/authz/cache.ts", before: null, after: CACHE_AFTER },
    ],
    anchors: [
      {
        path: "src/authz/check.ts",
        symbol: "requirePermission",
        line: 6,
        side: "additions",
        subjectKey: SUBJECT_KEY,
      },
      {
        path: "src/authz/cache.ts",
        symbol: "PermissionCache",
        line: 6,
        side: "additions",
        subjectKey: SUBJECT_KEY,
      },
    ],
  });
  const probeRuns = (
    world: ProbeWorld,
    outcome: "pass" | "fail" | "n/a",
    times: [number, number, number],
    reason?: string,
  ): AnyEvent[] =>
    times.map((second, index) =>
      b.at(second).emit({
        type: "ProbeRan",
        entity: probeRef,
        payload: {
          probeId: probe,
          conflictId: conflict,
          world,
          run: index === 0 ? 1 : index === 1 ? 2 : 3,
          outcome,
          resultRef: `r2:probes/${probe}/${world}/${index + 1}`,
          x: { cost: { ms: 1_400, usd: 0.00014 }, ...(reason === undefined ? {} : { reason }) },
        },
      }),
    );
  /** One change's own suite, run in one world. `passed` is null where the suite does not apply. */
  const testCell = (
    second: number,
    world: ProbeWorld,
    of: "A" | "B",
    passed: number | null,
    reason = `${of}'s tests are not in this world`,
  ): void => {
    b.at(second).emit({
      type: "WorldCheckRan",
      entity: conflictRef,
      payload: {
        conflictId: conflict,
        world,
        check: `suite:${of === "A" ? changeA : changeB}`,
        run: 1,
        outcome: passed === null ? "n/a" : "pass",
        ...(passed === null ? { reason } : { counts: { passed, failed: 0, skipped: 0 } }),
      },
    });
  };
  const NO_PATH = "No revocation path in this world";
  testCell(410, "trunk", "A", null);
  testCell(410.4, "trunk", "B", null);
  probeRuns("trunk", "n/a", [411.5, 412.5, 413.5], NO_PATH);
  // The control: A's world with the revocation path taken out. A probe that still passed here would prove nothing.
  // It runs the probe alone: neither change's suite is run there, and Keel records none.
  probeRuns("A-noop", "fail", [414.6, 415, 415.4]);
  testCell(416, "A", "A", 31);
  testCell(416.4, "A", "B", null);
  probeRuns("A", "pass", [418, 420, 422]);
  testCell(425, "B", "A", null);
  testCell(425.4, "B", "B", 27);
  probeRuns("B", "n/a", [427, 428, 429], NO_PATH);
  testCell(433, "AB", "A", 31);
  testCell(435, "AB", "B", 27);
  const failed = probeRuns("AB", "fail", [438, 442, 446]);
  const lastRun = failed.at(-1);

  // ── Proven: the probe discriminates, three runs out of three ──
  const guard = b.at(447).id("grd");
  // The probe's own event: from here the admitted probe is the guard, and G-1 is its name.
  b.emit({
    type: "GuardAdmitted",
    entity: probeRef,
    label: "G-1",
    payload: { guardId: guard, probeId: probe, conflictId: conflict, runs: 3 },
    ...(lastRun === undefined ? {} : { causation: lastRun }),
  });
  const proven = b.after(0.2).emit({
    type: "ConflictProven",
    entity: conflictRef,
    payload: {
      conflictId: conflict,
      evidence: { _tag: "probe", probeId: probe },
      x: { cost: { ms: 40_000, usd: 0.0021 } },
    },
  });

  return {
    project,
    trunkRef,
    operator,
    subject,
    head0,
    agentA,
    agentB,
    sessionB,
    changeA,
    changeB,
    workspaceA,
    workspaceB,
    conflict,
    conflictRef,
    probe,
    guard,
    probeRef,
    proven,
    stepRun,
  };
}

export type Opening = ReturnType<typeof opening>;

/** Everything up to the question. Identical for every ruling, so a live session and a deep link share it. */
export function prelude(b: ScriptBuilder) {
  const o = opening(b);
  const { changeA, changeB, conflict, conflictRef, probe, proven, sessionB } = o;

  const evidence: EvidenceLine[] = [
    {
      class: "proof",
      summary: "Probe P-1 fails in A+B, three runs out of three",
      by: "World matrix · Tier 1 isolate",
      ref: `prb:${probe}/AB`,
      at: b.isoAt(446),
      detail:
        "Passes in A alone, three runs. Does not apply in B or on trunk: neither has a revocation path.",
    },
    {
      // An extractor reads the code by rule: Keel classes what it finds as a ruling.
      class: "ruling",
      summary: "Extractor: permissionCache keeps roles for the life of the session",
      by: "Effect derivation · extractor",
      ref: "src/authz/cache.ts#PermissionCache",
      at: b.isoAt(395),
    },
    {
      class: "ruling",
      summary: "per-session is not at most per-request",
      by: "Lattice comparison · freshness",
      ref: "lattice:freshness",
      at: b.isoAt(396),
      detail: "Deterministic: per-call < per-request < per-session < ttl < static.",
    },
    {
      class: "proof",
      summary: "A's tests (31) and B's tests (27) all pass in A+B",
      by: "World matrix · Tier 1 isolate",
      ref: `cnd:${conflict}/AB/tests`,
      at: b.isoAt(435),
      detail: "Nothing either change wrote notices the disagreement.",
    },
    {
      class: "testimony",
      summary: `${NUMBER_B}: “Permission checks behave as before, only faster.”`,
      by: "Agent B · intent, revision 1",
      ref: `ses:${sessionB}#12`,
      at: b.isoAt(36),
    },
    {
      class: "opinion",
      summary: "Clef: permissions are cached for the whole session, p = 0.93",
      by: "Effect derivation · Clef",
      ref: `drv:${changeB}/clef`,
      at: b.isoAt(395),
    },
  ];

  const verdictPark = b.at(448).id("vrd");
  b.emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: verdictPark },
    payload: {
      verdictId: verdictPark,
      subject: changeB,
      outcome: "park",
      // The event carries references. The evidence itself is what Keel's read model serves for this verdict.
      evidence: b.reasons(verdictPark, "park", evidence),
      planHash: "plan:3f9a…d27e",
      x: {
        summary:
          "Conflict C-1 is proven and authz is human-class, so the change waits for a ruling",
      },
    },
  });
  const escalation = b.after(0.2).id("esc");
  const escalationRef: EntityRef = { kind: "escalation", id: escalation };
  const raised = b.emit({
    type: "EscalationRaised",
    entity: escalationRef,
    label: "E-1",
    payload: {
      escalationId: escalation,
      question: "May permission checks be cached within a session?",
      options: S1_OPTIONS,
      about: conflictRef,
      category: "permission-semantics",
      // As Keel publishes a question's evidence: its class, one sentence, and what it refers to.
      evidence: evidence.map((line) => ({
        class: line.class,
        summary: line.summary ?? "",
        ref: line.ref,
      })),
      precedents: [],
      default: S1_HOLD.id,
    },
    causation: proven,
  });
  b.after(0.2).emit({
    type: "ConflictEscalated",
    entity: conflictRef,
    payload: { conflictId: conflict, escalationId: escalation, reason: "human-class" },
  });
  for (const change of [changeB, changeA]) {
    b.after(0.1).emit({
      type: "ChangeParked",
      entity: changeRef(change),
      payload: { changeId: change, reason: "awaiting-ruling", escalationId: escalation },
      causation: raised,
    });
  }

  // The latest instant the story can reach unruled: the default while open is hold.
  b.at(472).gate(
    escalation,
    S1_CHOICES.map((option) => option.id),
    "invalidate",
  );

  return { ...o, escalation, escalationRef, evidence };
}

export type Prelude = ReturnType<typeof prelude>;

/** One change through its lane and onto trunk: batch, candidate, verification, advance, landing. */
export function land(
  b: ScriptBuilder,
  p: Pick<Opening, "project" | "trunkRef" | "stepRun">,
  input: {
    at: number;
    change: string;
    workspace: string;
    agent: string;
    from: string;
    to: string;
    height: number;
    label: string;
    landing?: Landing;
  },
): void {
  // What this change puts on trunk, for the repository the story can be browsed in.
  if (input.landing !== undefined) b.repository?.landings.set(input.change, input.landing);
  const batch = b.at(input.at).id("bat");
  const batchRef: EntityRef = { kind: "batch", id: batch };
  const queued = b.emit({
    type: "ChangeQueued",
    entity: changeRef(input.change),
    payload: { changeId: input.change, laneId: "lane-1" },
  });
  const formed = b.after(0.5).emit({
    type: "BatchFormed",
    entity: batchRef,
    payload: {
      batchId: batch,
      laneId: "lane-1",
      members: [input.change],
      base: input.from,
      attempt: 1,
      chainEpoch: 1,
      x: { label: input.label, heldApart: [] },
    },
    causation: queued,
  });
  b.after(0.1).emit({
    type: "ChangeBatched",
    entity: changeRef(input.change),
    payload: { changeId: input.change, batchId: batch },
    causation: formed,
  });
  const candidate = b.after(0.6).id("cnd");
  const candidateRef: EntityRef = { kind: "candidate", id: candidate };
  b.emit({
    type: "CandidateAssembled",
    entity: candidateRef,
    payload: {
      candidateId: candidate,
      batchId: batch,
      treeSha: input.to,
      composer: "gitcore",
      tier: 0,
      tierReason: "Paths are disjoint from head, so no merge engine is needed",
    },
  });
  const instance = `keelverify:${batch}:1`;
  b.after(0.4).emit({
    type: "VerificationStarted",
    entity: candidateRef,
    payload: {
      candidateId: candidate,
      batchId: batch,
      instanceId: instance,
      planHash: `plan:${batch.slice(-6).toLowerCase()}`,
    },
  });
  p.stepRun(b.now / 1000 - b.offset + 0.2, instance, batch, "unit", 1, 5.5, "passed");
  const verdict = b.after(7).id("vrd");
  b.emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: verdict },
    payload: {
      verdictId: verdict,
      subject: batch,
      outcome: "land",
      evidence: b.reasons(verdict, "land", [
        {
          class: "proof",
          summary: "Every step of the batch's Verification Plan passed",
          by: "KeelVerify · Tier 0 and Tier 1",
          ref: `cnd:${candidate}`,
          at: b.iso(),
        },
      ]),
      planHash: `plan:${batch.slice(-6).toLowerCase()}`,
      x: { summary: "Verified: nothing it could have broken is broken" },
    },
  });
  const verified = b.after(0.1).emit({
    type: "BatchVerified",
    entity: batchRef,
    payload: { batchId: batch, candidateId: candidate, verdictId: verdict },
  });
  const proofId = `prf_${candidate.slice(-10)}`;
  const groupId = `grp_${batch.slice(-10)}`;
  // The Trunk DO writes the group ahead, composes it once, pushes, and reads the head back.
  const started = b.after(0.1).emit({
    type: "PromotionStarted",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      groupId,
      old: input.from,
      members: [input.change],
      batches: [batch],
      proofIds: [proofId],
      committerTime: b.instant(),
    },
    causation: verified,
  });
  b.after(0.05).emit({
    type: "PromotionComposed",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      groupId,
      sha: input.to,
      commits: [{ changeId: input.change, commitSha: input.to }],
    },
  });
  const advanced = b.after(0.05).emit({
    type: "TrunkAdvanced",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      from: input.from,
      to: input.to,
      groupId,
      landings: [{ changeId: input.change, commitSha: input.to, candidateId: candidate, proofId }],
      height: input.height,
      x: { commuted: [] },
    },
    causation: started,
  });
  b.after(0.05).emit({
    type: "CandidatePromoted",
    entity: candidateRef,
    payload: { candidateId: candidate, batchId: batch, trunkSha: input.to },
    causation: advanced,
  });
  b.after(0.05).emit({
    type: "ChangeLanded",
    entity: changeRef(input.change),
    payload: {
      changeId: input.change,
      commitSha: input.to,
      trunkSha: input.to,
      candidateId: candidate,
      proofId,
    },
    causation: advanced,
  });
  b.after(0.6).emit({
    type: "WorkspaceCollected",
    entity: { kind: "workspace", id: input.workspace },
    payload: { workspaceId: input.workspace, reason: "landed" },
  });
  b.after(28).emit({
    type: "AuditCompleted",
    entity: p.trunkRef,
    payload: {
      projectId: p.project,
      head: input.to,
      outcome: "green",
      suspects: [],
      runRef: `r2:audits/${input.to.slice(0, 7)}`,
    },
    causation: advanced,
  });
}

export const HEAD_1 = "9c41e7a05b6d2f38c1e4a7b90d2f6e83a5c1b7d4";
export const HEAD_2 = "2e7f0b91d4c6a385e09b1f7c3d5a8e6204b9c1f7";

function ruled(
  b: ScriptBuilder,
  p: Prelude,
  option: S1Ruling,
  decision: { chosen: string; rejected: [string, string][] },
) {
  const chosen = S1_OPTIONS.find((candidate) => candidate.id === option);
  const given = b.at(472).emit({
    type: "RulingGiven",
    entity: p.escalationRef,
    payload: {
      escalationId: p.escalation,
      option,
      by: p.operator,
      rationale: chosen?.label ?? option,
    },
  });
  const decisionId = b.after(0.2).id("dec");
  b.emit({
    type: "ConflictResolved",
    entity: p.conflictRef,
    payload: {
      conflictId: p.conflict,
      move: option === "no-cache" ? "yield" : "refine",
      decisionId,
    },
    causation: given,
  });
  b.after(0.2).emit({
    type: "DecisionRecorded",
    entity: { kind: "decision", id: decisionId },
    label: "D-1",
    payload: {
      decisionId,
      escalationId: p.escalation,
      option,
      summary: decision.chosen,
      scope: SUBJECT_KEY,
      evidence: p.evidence.map((line) => line.ref),
      alternatives: decision.rejected.map(([alternative, reasonRejected]) => ({
        option: alternative,
        reasonRejected,
      })),
      x: { question: "May permission checks be cached within a session?" },
    },
    causation: given,
  });
  return { given, decisionId };
}

/** A lands, and its premise becomes a tenet backed by the guard. */
function landA(
  b: ScriptBuilder,
  p: Prelude,
  at: number,
  from: string,
  to: string,
  height: number,
  withTenet: boolean,
): string | undefined {
  land(b, p, {
    at,
    change: p.changeA,
    workspace: p.workspaceA,
    agent: p.agentA,
    from,
    to,
    height,
    label: `L1·${height}`,
    landing: LANDED_A,
  });
  if (!withTenet) return undefined;
  const tenet = b.at(at + 9.2).id("tnt");
  b.emit({
    type: "TenetEstablished",
    entity: { kind: "tenet", id: tenet },
    payload: {
      tenetId: tenet,
      subjectId: p.subject,
      predicate: "freshness",
      value: "per-request",
      changeId: p.changeA,
      guardIds: [p.guard],
      x: { label: "T-1" },
    },
  });
  return tenet;
}

function bounce(
  b: ScriptBuilder,
  p: Prelude,
  at: number,
  change: string,
  agent: string,
  summary: string,
  actions: string[],
  cause: AnyEvent,
): void {
  const verdict = b.at(at).id("vrd");
  b.emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: verdict },
    payload: {
      verdictId: verdict,
      subject: change,
      outcome: "bounce",
      evidence: b.reasons(verdict, "bounce", [
        { class: "ruling", summary, by: "Ruling on E-1", ref: `esc:${p.escalation}`, at: b.iso() },
      ]),
      planHash: "plan:3f9a…d27e",
      x: { summary },
    },
  });
  b.after(0.1).emit({
    type: "ChangeBounced",
    entity: changeRef(change),
    payload: {
      changeId: change,
      verdictId: verdict,
      reasons: [`esc:${p.escalation}`],
      nextActions: actions.map((title) => ({
        kind: "call" as const,
        title,
        operationId: "revise",
      })),
    },
    causation: cause,
  });
}

/** The scripted ruling: cache allowed if revocation invalidates it. B revises; both land. */
export function continueInvalidate(
  b: ScriptBuilder,
  p: Prelude,
): { decisionId: string; tenetId: string | undefined } {
  const { given, decisionId } = ruled(b, p, "invalidate", {
    chosen: "Cache allowed if revocation invalidates it",
    rejected: [
      [
        "Never cache permission checks",
        "Gives up the speed-up when invalidation already makes the cache safe",
      ],
      [
        "Cache for the session; revocation applies at next sign-in",
        "A revoked collaborator would keep access for the rest of their session",
      ],
    ],
  });
  b.at(472.6).emit({
    type: "ChangeResumed",
    entity: changeRef(p.changeA),
    payload: { changeId: p.changeA, decisionId },
    causation: given,
  });
  bounce(
    b,
    p,
    472.8,
    p.changeB,
    p.agentB,
    "Decision D-1: the cache may stay if revocation invalidates it. As written, it does not.",
    [
      "Invalidate a session's cached roles on revocation",
      "Declare the effect on authz.permission-evaluation",
    ],
    given,
  );
  const tenetId = landA(b, p, 474, p.head0, HEAD_1, 1, true);

  // B meets the decision as precedent, follows it, and comes back.
  b.at(480).emit({
    type: "PrecedentSurfaced",
    entity: { kind: "decision", id: decisionId },
    payload: { decisionId, changeId: p.changeB },
  });
  b.at(500).emit({
    type: "IntentRevised",
    entity: changeRef(p.changeB),
    payload: {
      changeId: p.changeB,
      revision: 2,
      footprint: [
        { path: "src/authz/check.ts", symbol: "requirePermission", op: "edit" },
        { path: "src/authz/cache.ts", op: "create" },
        { path: "src/collaborators/revoke.ts", symbol: "revokeCollaborator", op: "edit" },
      ],
      premisesAdded: [
        {
          subject: "collab.revocation",
          predicate: "presence",
          relation: "is",
          value: true,
          gloss: "Revocation calls permissionCache.invalidate",
          strength: "must",
        },
      ],
      premisesRetracted: [],
      // This time the agent says what the change does to the subject it tripped over.
      declaredEffects: [
        {
          subject: SUBJECT_KEY,
          predicate: "freshness",
          relation: "is",
          value: "per-session",
          scope: "until revoked",
          gloss: "Roles are cached for the session and dropped on revocation",
        },
      ],
    },
  });
  // The revision relies on a subject nobody had named until now. Keel mints a subject at an agent's first
  // word about it, under an id it derives from the key, and records the premise against it.
  const revocation = "sub_01M4V0618GREV0CAT10N000000";
  const reliesOnRevocation: Proposition = {
    subject: "collab.revocation",
    predicate: "presence",
    relation: "is",
    value: true,
    gloss: "Revocation calls permissionCache.invalidate",
    strength: "must",
  };
  b.emit({
    type: "SubjectMinted",
    entity: subjectRef(revocation),
    payload: {
      subjectId: revocation,
      key: reliesOnRevocation.subject,
      anchors: [],
      gloss: "Revocation calls permissionCache.invalidate",
      mintedBy: "agent",
    },
  });
  b.emit({
    type: "PremiseRelied",
    entity: subjectRef(revocation),
    payload: { subjectId: revocation, changeId: p.changeB, premise: reliesOnRevocation },
  });
  b.after(0.3).emit({
    type: "PreflightIssued",
    entity: changeRef(p.changeB),
    payload: {
      changeId: p.changeB,
      revision: 2,
      neighbours: [],
      contradictions: [],
      precedents: [
        {
          decisionId,
          summary: "Cache allowed if revocation invalidates it",
          decidedAt: b.instantAt(472.4),
          scope: SUBJECT_KEY,
        },
      ],
      suggestedMove: "proceed",
    },
  });
  for (const [second, sha] of [
    [560, "b0d47c1"],
    [610, "9a1c3d2"],
  ] as const) {
    b.at(second).emit({
      type: "WorkspacePushed",
      entity: { kind: "workspace", id: p.workspaceB },
      payload: { workspaceId: p.workspaceB, ref: "refs/heads/work", sha },
    });
  }
  const resubmitted = b.at(640).emit({
    type: "ChangeSubmitted",
    entity: changeRef(p.changeB),
    payload: { changeId: p.changeB, revision: 2, commitSha: "9a1c3d2", workspaceId: p.workspaceB },
  });
  const precheck = `precheck:${p.changeB}:2`;
  b.after(1).emit({
    type: "PrecheckStarted",
    entity: changeRef(p.changeB),
    payload: { changeId: p.changeB, revision: 2, instanceId: precheck },
    causation: resubmitted,
  });
  // The second revision's own check, step by step.
  p.stepRun(641.1, precheck, p.changeB, "diff", 0, 0.1, "passed");
  p.stepRun(641.3, precheck, p.changeB, "protected", 0, 0.1, "passed");
  p.stepRun(641.6, precheck, p.changeB, "extract", 1, 1.8, "passed");
  p.stepRun(643.2, precheck, p.changeB, "clef", 1, 1.3, "annotated", 0.0004);
  p.stepRun(646, precheck, p.changeB, "lattice", 0, 0.1, "passed");
  p.stepRun(647.2, precheck, p.changeB, "typecheck", 1, 2.1, "passed");
  p.stepRun(647.2, precheck, p.changeB, "unit", 1, 3.6, "passed");
  b.at(645).emit({
    type: "EffectsDerived",
    entity: changeRef(p.changeB),
    payload: {
      changeId: p.changeB,
      revision: 2,
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
          anchors: [{ path: "src/authz/cache.ts", symbol: "PermissionCache", commit: "9a1c3d2" }],
        },
      ],
      derivationRef: `mfp:derivation:${p.changeB}:2`,
    },
  });
  b.after(1).emit({
    type: "PrecedentFollowed",
    entity: { kind: "decision", id: decisionId },
    payload: { decisionId, changeId: p.changeB },
  });
  b.at(647).emit({
    type: "PlanCompiled",
    entity: changeRef(p.changeB),
    payload: {
      changeId: p.changeB,
      revision: 2,
      planHash: "plan:c07e…41aa",
      steps: planForB({ label: "G-1", decision: "D-1" }),
      costEstimate: 0.004,
    },
  });
  // Nothing is run in the matrix's worlds again: the conflict is settled. The revised change's own plan runs,
  // with the admitted guard a step of it like any other, and the verdict it lands by is what Keel records.
  p.stepRun(650, precheck, p.changeB, "guard", 1, 12, "passed");
  land(b, p, {
    at: 663.5,
    change: p.changeB,
    workspace: p.workspaceB,
    agent: p.agentB,
    from: HEAD_1,
    to: HEAD_2,
    height: 2,
    label: "L1·2",
    landing: LANDED_B_INVALIDATING,
  });
  return { decisionId, tenetId };
}

/** Never cache: A lands, B cannot land as written and withdraws. */
function continueNoCache(b: ScriptBuilder, p: Prelude): void {
  const { given, decisionId } = ruled(b, p, "no-cache", {
    chosen: "Never cache permission checks",
    rejected: [
      [
        "Cache allowed if revocation invalidates it",
        "Judged not worth a second code path in authz",
      ],
      [
        "Cache for the session; revocation applies at next sign-in",
        "A revoked collaborator would keep access for the rest of their session",
      ],
    ],
  });
  b.at(472.6).emit({
    type: "ChangeResumed",
    entity: changeRef(p.changeA),
    payload: { changeId: p.changeA, decisionId },
    causation: given,
  });
  bounce(
    b,
    p,
    472.8,
    p.changeB,
    p.agentB,
    "Decision D-1: permission checks are never cached.",
    ["Withdraw the change", "Find the speed-up somewhere that keeps freshness at most per-request"],
    given,
  );
  landA(b, p, 474, p.head0, HEAD_1, 1, true);
  b.at(520).emit({
    type: "ChangeWithdrawn",
    entity: changeRef(p.changeB),
    payload: { changeId: p.changeB, by: p.agentB, reason: "Decision D-1 rules the approach out" },
  });
  b.after(0.6).emit({
    type: "WorkspaceCollected",
    entity: { kind: "workspace", id: p.workspaceB },
    payload: { workspaceId: p.workspaceB, reason: "withdrawn" },
  });
}

/** Allow staleness: the guard is retired, B lands, and A must relax its premise first. */
function continueAllowStale(b: ScriptBuilder, p: Prelude): void {
  const { given, decisionId } = ruled(b, p, "allow-stale", {
    chosen: "Cache for the session; revocation applies at next sign-in",
    rejected: [
      ["Never cache permission checks", "The speed-up was judged worth a bounded delay"],
      [
        "Cache allowed if revocation invalidates it",
        "Judged not worth a second code path in authz",
      ],
    ],
  });
  b.at(472.5).emit({
    type: "GuardRetired",
    entity: p.probeRef,
    payload: { guardId: p.guard, decisionId },
    causation: given,
  });
  b.at(472.6).emit({
    type: "ChangeResumed",
    entity: changeRef(p.changeB),
    payload: { changeId: p.changeB, decisionId },
    causation: given,
  });
  bounce(
    b,
    p,
    472.8,
    p.changeA,
    p.agentA,
    `Decision D-1: revocation applies at next sign-in. ${NUMBER_A}'s premise no longer holds.`,
    ["Relax the premise to at most per-session", "Say so where the owner revokes"],
    given,
  );
  land(b, p, {
    at: 474,
    change: p.changeB,
    workspace: p.workspaceB,
    agent: p.agentB,
    from: p.head0,
    to: HEAD_1,
    height: 1,
    label: "L1·1",
    landing: LANDED_B_AS_WRITTEN,
  });
  b.at(505).emit({
    type: "IntentRevised",
    entity: changeRef(p.changeA),
    payload: {
      changeId: p.changeA,
      revision: 2,
      premisesAdded: [
        {
          subject: SUBJECT_KEY,
          predicate: "freshness",
          relation: "at-most",
          value: "per-session",
          gloss: "A revoked collaborator loses access by their next sign-in",
          strength: "must",
        },
      ],
      premisesRetracted: [
        { subject: SUBJECT_KEY, predicate: "freshness", relation: "at-most", value: "per-request" },
      ],
    },
  });
  const resubmitted = b.at(560).emit({
    type: "ChangeSubmitted",
    entity: changeRef(p.changeA),
    payload: { changeId: p.changeA, revision: 2, commitSha: "7f3e2a9", workspaceId: p.workspaceA },
  });
  b.after(1).emit({
    type: "PrecheckStarted",
    entity: changeRef(p.changeA),
    payload: { changeId: p.changeA, revision: 2, instanceId: `precheck:${p.changeA}:2` },
    causation: resubmitted,
  });
  b.at(566).emit({
    type: "PlanCompiled",
    entity: changeRef(p.changeA),
    payload: {
      changeId: p.changeA,
      revision: 2,
      planHash: "plan:5d18…e9c3",
      steps: { op: "seq", of: [] },
      costEstimate: 0.002,
    },
  });
  landA(b, p, 568, HEAD_1, HEAD_2, 2, false);
}

/**
 * The whole story for one seed. With no ruling, the log ends at the question
 * and carries its gate. With one, it runs on to the end. The unruled log is a
 * strict prefix of every ruled one: that is what lets a live tap and a deep
 * link arrive at the same place.
 */
export function generateS1(seed: number, ruling?: S1Ruling): GeneratedLog {
  const rng: Rng = createRng(seed).fork("s1");
  const b = new ScriptBuilder(S1_EPOCH, rng);
  const p = prelude(b);
  if (ruling === "invalidate") continueInvalidate(b, p);
  else if (ruling === "no-cache") continueNoCache(b, p);
  else if (ruling === "allow-stale") continueAllowStale(b, p);
  const log = b.build();
  return ruling === undefined ? log : { ...log, gates: [] };
}
