// Scenario 6: a premise put in doubt.
//
// #1 relies on an invoice's total being worked out in at most 50 ms, a premise
// it should hold rather than must, resting on `totalOf` in
// src/billing/total.ts. Keel tells #1 twice that the premise may no longer
// stand, and opens no conflict for either:
//
//   by an edit     #2 submits a diff that touches `totalOf`, and makes no
//                  effect of its own on the subject. Keel tells #1 that a
//                  change edited code its premise rests on.
//   by an effect   #3 declares that a total takes at most two seconds, which
//                  contradicts the premise. A premise held as `should` does not
//                  bind, so Keel suspects and does not open a conflict.
//
// Nobody reaffirms the premise. #1 and #3 are still working when the story
// ends, and #2 is still being checked.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { Anchor, Proposition } from "../../../src/contract/mfp.ts";
import { createRng } from "../prng.ts";
import { type GeneratedLog, PLATFORM_PROJECT, ScriptBuilder } from "./builder.ts";

export const S6_EPOCH = "2026-10-14T11:00:00.000Z";

const SUBJECT_KEY = "billing.invoices";
const HEAD_0 = "4c2e9b07d1a85f63e0c7b2a94d8f1e6305b7c9a2";

const changeRef = (id: string): EntityRef => ({ kind: "change", id });

/** The code the premise rests on, as #1 pinned it at trunk's head. */
const TOTAL_OF: Anchor = { path: "src/billing/total.ts", symbol: "totalOf", commit: "4c2e9b0" };

/** #1's premise: a total is worked out fast enough to show on the page. */
export const QUICK_TOTAL: Proposition = {
  subject: SUBJECT_KEY,
  predicate: "bound",
  relation: "at-most",
  value: 50,
  unit: "ms",
  gloss: "An invoice's total is worked out in at most 50 ms",
  strength: "should",
  anchors: [TOTAL_OF],
};

/** #3's declared effect: totals are worked out in a nightly batch, two seconds each at most. */
export const BATCHED_TOTAL: Proposition = {
  subject: SUBJECT_KEY,
  predicate: "bound",
  relation: "at-most",
  value: 2000,
  unit: "ms",
  gloss: "An invoice's total is worked out in the nightly batch",
};

export function generateS6(seed: number): GeneratedLog {
  const b = new ScriptBuilder(S6_EPOCH, createRng(seed).fork("s6"));
  const project = b.at(0).id("prj");
  b.project = project;
  const projectRef: EntityRef = { kind: "project", id: project };
  const trunkRef: EntityRef = { kind: "trunk", id: project };
  const operator = b.id("agt");
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

  /** One hosted agent declares a change, is given a workspace and starts. */
  const declare = (
    second: number,
    number: string,
    name: string,
    goal: string,
    intent: { path: string; premises: Proposition[]; declaredEffects: Proposition[] },
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
        footprint: [{ path: intent.path, op: "edit" }],
        premises: intent.premises,
        declaredEffects: intent.declaredEffects,
        leaseId: b.id("lse"),
      },
    });
    return { change, agent, workspace, declared };
  };

  /** Keel answers the declaration, grants the workspace and starts the change. */
  const start = (made: ReturnType<typeof declare>) => {
    b.after(0.2).emit({
      type: "PreflightIssued",
      entity: changeRef(made.change),
      payload: {
        changeId: made.change,
        revision: 1,
        neighbours: [],
        contradictions: [],
        precedents: [],
        suggestedMove: "proceed",
      },
    });
    const granted = b.after(0.2).emit({
      type: "WorkspaceGranted",
      entity: { kind: "workspace", id: made.workspace },
      payload: {
        workspaceId: made.workspace,
        holder: made.change,
        expiresAt: b.instant(b.now + 7_200_000),
        baseSha: HEAD_0,
      },
      causation: made.declared,
    });
    b.after(0.05).emit({
      type: "ChangeStarted",
      entity: changeRef(made.change),
      payload: { changeId: made.change, workspaceId: made.workspace, baseSha: HEAD_0 },
      causation: granted,
    });
  };

  // ── #1 relies on the total being quick. Keel mints the subject at the agent's first word about it. ──
  const one = declare(10, "#1", "hosted-501", "Show each invoice's total as it is edited", {
    path: "src/billing/InvoicePage.tsx",
    premises: [QUICK_TOTAL],
    declaredEffects: [],
  });
  const subject = b.id("sub");
  const subjectRef: EntityRef = { kind: "subject", id: subject };
  b.emit({
    type: "SubjectMinted",
    entity: subjectRef,
    payload: {
      subjectId: subject,
      key: SUBJECT_KEY,
      anchors: [],
      gloss: "What an invoice's total is and how it is worked out",
      mintedBy: "agent",
    },
  });
  b.emit({
    type: "PremiseRelied",
    entity: subjectRef,
    payload: { subjectId: subject, changeId: one.change, premise: QUICK_TOTAL },
    causation: one.declared,
  });
  start(one);

  // ── #2 rounds each line, in the code #1's premise rests on, and says nothing of how long a total takes. ──
  const two = declare(20, "#2", "hosted-502", "Round each invoice line half to even", {
    path: TOTAL_OF.path,
    premises: [],
    declaredEffects: [],
  });
  start(two);
  b.at(40).emit({
    type: "WorkspacePushed",
    entity: { kind: "workspace", id: two.workspace },
    payload: { workspaceId: two.workspace, ref: "refs/heads/work", sha: "c71e0a4" },
  });
  const submitted = b.at(41).emit({
    type: "ChangeSubmitted",
    entity: changeRef(two.change),
    payload: {
      changeId: two.change,
      revision: 1,
      commitSha: "c71e0a4",
      workspaceId: two.workspace,
    },
  });
  b.at(42).emit({
    type: "PrecheckStarted",
    entity: changeRef(two.change),
    payload: { changeId: two.change, revision: 1, instanceId: `precheck:${two.change}:1` },
    causation: submitted,
  });
  const derived = b.at(45).emit({
    type: "EffectsDerived",
    entity: changeRef(two.change),
    payload: {
      changeId: two.change,
      revision: 1,
      effects: [],
      derivationRef: `mfp:derivation:${two.change}:1`,
      touched: [{ subject: SUBJECT_KEY, anchor: { ...TOTAL_OF, commit: "c71e0a4" } }],
    },
  });
  // The diff touched code a premise rests on, and no effect of the change was judged against it.
  b.after(0.1).emit({
    type: "PremiseSuspected",
    entity: subjectRef,
    payload: {
      subjectId: subject,
      changeId: one.change,
      premise: QUICK_TOTAL,
      cause: { changeId: two.change, anchor: { ...TOTAL_OF, commit: "c71e0a4" } },
    },
    causation: derived,
  });

  // ── #3 declares totals worked out nightly. The premise does not bind, so Keel suspects it. ──
  const three = declare(60, "#3", "hosted-503", "Work out invoice totals in a nightly batch", {
    path: "src/billing/nightly.ts",
    premises: [],
    declaredEffects: [BATCHED_TOTAL],
  });
  b.after(0.1).emit({
    type: "PremiseSuspected",
    entity: subjectRef,
    payload: {
      subjectId: subject,
      changeId: one.change,
      premise: QUICK_TOTAL,
      cause: { changeId: three.change, effect: BATCHED_TOTAL },
    },
    causation: three.declared,
  });
  start(three);
  return b.build();
}
