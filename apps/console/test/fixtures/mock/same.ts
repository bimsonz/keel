// Scenario 5: the same intent.
//
// Three hosted agents are each asked to put a rate limit on the collaborators
// API, and each declares the same effect before writing any code. Keel knows:
// their declared effects make the same claims. It never ranks them and never
// picks one. It shows them to each other. A change's preflight lists the live
// changes that already had its intent, and each of those is told, by a notice
// on the project, when another is declared.
//
// #1 lands. The other two are told that as well, each with the ways forward
// Keel names: read the other change, read what is near your own, rebase, or
// withdraw. #2's agent withdraws. #3 is still working when the story ends.
//
// One change, #4, declares a different limit on the same subject. It is a
// neighbour of the three and no one's alternative: the claims are not the same.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { NextAction } from "../../../src/contract/events.ts";
import type { Proposition } from "../../../src/contract/mfp.ts";
import { createRng } from "../prng.ts";
import { type GeneratedLog, PLATFORM_PROJECT, ScriptBuilder } from "./builder.ts";
import { land } from "./s1.ts";

export const S5_EPOCH = "2026-10-14T09:30:00.000Z";

const SUBJECT_KEY = "api.collaborators";
const HEAD_0 = "6d0f3a81c5e97b24a0d8f1c36e5b9a7204c8d1e3";
const HEAD_1 = "b83e5c07a1d94f62e0b7c3a85d1f6e942a0c7b58";

const changeRef = (id: string): EntityRef => ({ kind: "change", id });

/** What all three declare: at most a hundred requests a minute, for each caller. */
const LIMIT: Proposition = {
  subject: SUBJECT_KEY,
  predicate: "bound",
  relation: "at-most",
  value: 100,
  unit: "requests/minute",
  scope: "per caller",
};

/** The ways forward Keel names to a change's agent about another with its intent. */
function waysForward(changeId: string, other: string): NextAction[] {
  return [
    {
      kind: "read",
      title: "Read the other change: its intent, its state and its evidence",
      operationId: "Changes_getChange",
      args: { changeId: other },
    },
    {
      kind: "read",
      title: "Read what is near your change, the other change included",
      operationId: "nearby",
      args: { changeId },
    },
    {
      kind: "call",
      title: "Rebase your change onto trunk as it is now",
      operationId: "rebase",
      args: { changeId },
    },
    { kind: "call", title: "Withdraw your change", operationId: "abandon", args: { changeId } },
  ];
}

export function generateS5(seed: number): GeneratedLog {
  const b = new ScriptBuilder(S5_EPOCH, createRng(seed).fork("s5"));
  const project = b.at(0).id("prj");
  b.project = project;
  const projectRef: EntityRef = { kind: "project", id: project };
  const trunkRef: EntityRef = { kind: "trunk", id: project };
  const operator = b.id("agt");
  const subject = b.id("sub");
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
    entity: projectRef,
    payload: { projectId: project, name: "demo", by: operator },
  });
  b.emit({
    type: "TrunkInitialized",
    entity: trunkRef,
    payload: { projectId: project, head: HEAD_0, by: operator },
  });
  b.emit({
    type: "SubjectMinted",
    entity: { kind: "subject", id: subject },
    payload: {
      subjectId: subject,
      key: SUBJECT_KEY,
      anchors: [
        { path: "src/collaborators/routes.ts", symbol: "routes", commit: HEAD_0.slice(0, 7) },
      ],
      gloss: "What the collaborators API will serve, and how much of it",
      mintedBy: "scan",
    },
  });

  /** One hosted agent declares a change, is given a workspace and starts. `effect` is what it says the change will do. */
  const declare = (
    second: number,
    number: string,
    name: string,
    goal: string,
    effect: Proposition,
    alternatives: string[],
  ) => {
    const workspace = b.at(second - 1).id("wsp");
    b.emit({
      type: "WorkspaceForked",
      entity: { kind: "workspace", id: workspace },
      payload: {
        workspaceId: workspace,
        repo: `ws-${workspace.slice(-8).toLowerCase()}`,
        sourceRepo: "mirror",
      },
    });
    const agent = b.at(second - 0.5).id("agt");
    b.emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: agent },
      payload: {
        agentId: agent,
        projectId: project,
        name,
        kind: "hosted",
        scopes: ["agent:work", "agent:read"],
      },
    });
    const change = b.at(second).id("chg");
    const declared = b.emit({
      type: "IntentDeclared",
      entity: changeRef(change),
      label: number,
      payload: {
        changeId: change,
        agentId: agent,
        origin: "agent",
        revision: 1,
        goal,
        footprint: [{ path: "src/collaborators/routes.ts", symbol: "routes", op: "edit" }],
        premises: [],
        declaredEffects: [effect],
        leaseId: b.id("lse"),
      },
    });
    // Keel copies the alternatives onto the preflight only when there are some.
    b.after(0.2).emit({
      type: "PreflightIssued",
      entity: changeRef(change),
      payload: {
        changeId: change,
        revision: 1,
        neighbours: [],
        contradictions: [],
        precedents: [],
        suggestedMove: "proceed",
        ...(alternatives.length === 0 ? {} : { alternatives }),
      },
    });
    // Each live change that already had this intent is told, in the order Keel listed them.
    for (const earlier of alternatives) {
      b.after(0.05).emit({
        type: "AlternativeDeclared",
        entity: projectRef,
        payload: {
          projectId: project,
          changeId: earlier,
          alternativeId: change,
          nextActions: waysForward(earlier, change),
        },
        causation: declared,
      });
    }
    const granted = b.after(0.2).emit({
      type: "WorkspaceGranted",
      entity: { kind: "workspace", id: workspace },
      payload: {
        workspaceId: workspace,
        holder: change,
        expiresAt: b.instant(b.now + 7_200_000),
        baseSha: HEAD_0,
      },
      causation: declared,
    });
    b.after(0.05).emit({
      type: "ChangeStarted",
      entity: changeRef(change),
      payload: { changeId: change, workspaceId: workspace, baseSha: HEAD_0 },
      causation: granted,
    });
    return { change, agent, workspace };
  };

  const one = declare(10, "#1", "hosted-041", "Rate-limit the collaborators API", LIMIT, []);
  const two = declare(24, "#2", "hosted-112", "Add a rate limit to collaborator routes", LIMIT, [
    one.change,
  ]);
  const three = declare(41, "#3", "hosted-207", "Throttle the collaborators endpoints", LIMIT, [
    one.change,
    two.change,
  ]);
  // The same subject and predicate, and another value: a different claim, so no one's alternative.
  declare(
    55,
    "#4",
    "hosted-318",
    "Cap collaborator listing at ten requests a second",
    { ...LIMIT, value: 10, unit: "requests/second" },
    [],
  );

  // ── #1 finishes first: submitted, verified, landed ──
  b.at(90).emit({
    type: "WorkspacePushed",
    entity: { kind: "workspace", id: one.workspace },
    payload: { workspaceId: one.workspace, ref: "refs/heads/work", sha: "a41c9e2" },
  });
  const submitted = b.at(100).emit({
    type: "ChangeSubmitted",
    entity: changeRef(one.change),
    payload: {
      changeId: one.change,
      revision: 1,
      commitSha: "a41c9e2",
      workspaceId: one.workspace,
    },
  });
  b.at(101).emit({
    type: "PrecheckStarted",
    entity: changeRef(one.change),
    payload: { changeId: one.change, revision: 1, instanceId: `precheck:${one.change}:1` },
    causation: submitted,
  });
  b.at(104).emit({
    type: "EffectsDerived",
    entity: changeRef(one.change),
    payload: {
      changeId: one.change,
      revision: 1,
      effects: [
        {
          method: "extractor",
          evidenceClass: "ruling",
          declared: true,
          proposition: { ...LIMIT, gloss: "A caller is refused past a hundred requests a minute" },
          anchors: [{ path: "src/collaborators/routes.ts", symbol: "routes", commit: "a41c9e2" }],
        },
      ],
      derivationRef: `mfp:derivation:${one.change}:1`,
    },
  });
  b.at(105).emit({
    type: "PlanCompiled",
    entity: changeRef(one.change),
    payload: {
      changeId: one.change,
      revision: 1,
      planHash: "plan:5e1a…77c0",
      steps: 9,
      costEstimate: 0.003,
    },
  });
  land(
    b,
    { project, trunkRef },
    {
      at: 108,
      change: one.change,
      workspace: one.workspace,
      agent: one.agent,
      from: HEAD_0,
      to: HEAD_1,
      height: 1,
      label: "L1·1",
    },
  );
  // The live changes with its intent are told it landed.
  for (const [offset, other] of [
    [0, two.change],
    [0.05, three.change],
  ] as const) {
    b.at(124 + offset).emit({
      type: "AlternativeLanded",
      entity: projectRef,
      payload: {
        projectId: project,
        changeId: other,
        landedChangeId: one.change,
        nextActions: waysForward(other, one.change),
      },
    });
  }

  // #2's agent reads the landed change and withdraws its own. #3 goes on.
  b.at(140).emit({
    type: "ChangeWithdrawn",
    entity: changeRef(two.change),
    payload: { changeId: two.change, by: two.agent, reason: "An alternative landed: #1" },
  });
  b.at(141).emit({
    type: "WorkspaceCollected",
    entity: { kind: "workspace", id: two.workspace },
    payload: { workspaceId: two.workspace, reason: "withdrawn" },
  });
  b.at(150).emit({
    type: "WorkspacePushed",
    entity: { kind: "workspace", id: three.workspace },
    payload: { workspaceId: three.workspace, ref: "refs/heads/work", sha: "9be0d14" },
  });
  return b.build();
}
