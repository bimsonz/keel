import { describe, expect, it } from "@effect/vitest";
import {
  decidePrecheck,
  diffSubmission,
  type PrecheckSubmission,
  precheckPolicy,
  recordPlan,
  refuseSubmission,
  startPrecheck,
} from "@keeltown/core/application/verification";
import { CommitSha, Glob, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, type PrecheckWorkspace } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  type FixtureFiles,
  makeChangePrecheckMemory,
  makeCodeHostMemory,
  makeProjectsMemory,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";

const changeId = makeId("chg", "01JZD12D12D12D12D12D12D12D");
const projectId: ProjectId = makeId("prj", "01JZD12D12D12D12D12D12D12D");
const repo = { namespace: "keel-ws-00", name: "ws-d12" };
const BASE_FILES: FixtureFiles = {
  "src/a.ts": "export const a = 1;\n",
  "infra/main.tf": 'resource "x" "y" {}\n',
  ".keel/guards/g1.test.ts": "test('g1', () => {});\n",
};

/**
 * Precheck's world in memory: a workspace repo holding the base and the
 * agent's commits on top of it, the change submitted on that workspace, and
 * the project's settings. `run` takes the Workflow's steps in order.
 */
function precheckWorld(options: { readonly protectedPaths?: readonly string[] } = {}) {
  const code = makeCodeHostMemory();
  const changes = makeChangePrecheckMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: (options.protectedPaths ?? ["infra/**"]).map((g) => Glob.make(g)),
    maxBatchSize: 4,
  });
  const layer = Layer.mergeAll(code.layer, changes.layer, projects.layer);
  const commit = (files: FixtureFiles) =>
    Effect.gen(function* () {
      return yield* (yield* CodeHostFixture).commit(repo, "refs/heads/main", files);
    }).pipe(Effect.provide(code.layer));

  /** Creates the workspace on `base` and submits the last of `pushes` (each a whole tree) at revision 1. */
  const submitted = (pushes: readonly FixtureFiles[], instanceId = "precheck-evt_1") =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* CodeHost).create(repo);
      }).pipe(Effect.provide(code.layer));
      const baseSha = yield* commit(BASE_FILES);
      let head: CommitSha = baseSha;
      for (const files of pushes) head = yield* commit(files);
      const workspace: PrecheckWorkspace = {
        workspaceId: makeId("wsp", "01JZD12D12D12D12D12D12D12D"),
        repo,
        baseSha,
        projectId,
      };
      changes.submit(changeId, 1, workspace);
      const submission: PrecheckSubmission = { changeId, revision: 1, commitSha: head, instanceId };
      return submission;
    });

  /** The Workflow's steps, in order, on these use-cases. */
  const run = (submission: PrecheckSubmission) =>
    Effect.gen(function* () {
      const workspace = yield* startPrecheck(submission);
      const touched = yield* diffSubmission(workspace, submission.commitSha);
      const policy = yield* precheckPolicy(workspace);
      const decision = decidePrecheck(touched, policy, workspace.baseSha);
      if (decision._tag === "Refuse") yield* refuseSubmission(submission, decision);
      else yield* recordPlan(submission, decision);
      return decision;
    }).pipe(Effect.provide(layer));

  return { code, changes, layer, submitted, run };
}

const withFile = (path: string, data = "changed\n"): FixtureFiles => ({
  ...BASE_FILES,
  [path]: data,
});

describe("Precheck", () => {
  it.effect("[d12.guard-refused] refuses a change to a guard, citing it, with next actions", () => {
    const world = precheckWorld();
    return Effect.gen(function* () {
      const decision = yield* world.run(
        yield* world.submitted([withFile(".keel/guards/g1.test.ts")]),
      );
      expect(decision).toMatchObject({
        _tag: "Refuse",
        reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
      });
      expect(world.changes.stateOf(changeId)).toBe("bounced");
      expect(world.changes.calls.map((c) => c.method)).toEqual([
        "precheckStarted",
        "precheckRefused",
      ]);
    });
  });

  it.effect(
    "[d12.protected-refused] refuses a protected path, read from the project's settings",
    () => {
      const world = precheckWorld({ protectedPaths: ["infra/**"] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("infra/main.tf")]));
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:protected:infra/main.tf (infra/**)"],
        });
        if (decision._tag !== "Refuse") return;
        expect(decision.nextActions.map((a) => a.kind)).toEqual(["call", "escalate"]);
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[d12.protected-refused] lets the same path through a project that does not protect it",
    () => {
      const world = precheckWorld({ protectedPaths: [] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("infra/main.tf")]));
        expect(decision._tag).toBe("Compile");
      });
    },
  );

  it.effect(
    "[d12.clean-compiles] compiles a clean change's plan from its base, and records it",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/a.ts")]));
        expect(decision).toMatchObject({ _tag: "Compile", steps: 1 });
        expect(world.changes.stateOf(changeId)).toBe("queued");
        expect(world.changes.calls.map((c) => c.method)).toEqual([
          "precheckStarted",
          "planCompiled",
        ]);
      });
    },
  );

  it.effect(
    "[d12.base-diff] diffs against the base, so a guard edit in an earlier push still counts",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        // The guard changes in the first push; the submitted second push only touches src.
        const guarded = withFile(".keel/guards/g1.test.ts");
        const decision = yield* world.run(
          yield* world.submitted([guarded, { ...guarded, "src/a.ts": "export const a = 2;\n" }]),
        );
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
        });
      });
    },
  );

  it.effect(
    "[d12.base-missing] refuses, with a resubmit next action, a commit the workspace lacks",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const submission = yield* world.submitted([withFile("src/a.ts")]);
        const decision = yield* world.run({
          ...submission,
          commitSha: CommitSha.make("f".repeat(40)),
        });
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${"f".repeat(40)}`],
          nextActions: [{ kind: "call", operationId: "submit" }],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[d12.l1-plan-gap] refuses a flow change, whose human-class step KeelVerify cannot run at L1",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile(".keel/flow.yaml")]));
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:l1-plan-gap:keel.human-class"],
          nextActions: [
            { kind: "call", operationId: "submit", args: { steps: ["keel.human-class"] } },
          ],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect("[d12.replay] a replayed run commits nothing new", () => {
    const world = precheckWorld();
    return Effect.gen(function* () {
      const submission = yield* world.submitted([withFile("src/a.ts")]);
      const first = yield* world.run(submission);
      const again = yield* world.run(submission);
      expect(again).toEqual(first);
      expect(world.changes.calls).toHaveLength(2);
    });
  });

  it.effect(
    "[d12.stale] a resubmitted change refuses the old revision's Precheck, which moves nothing",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const submission = yield* world.submitted([withFile("src/a.ts")]);
        const error = yield* Effect.flip(world.run({ ...submission, revision: 0 }));
        expect(error._tag).toBe("ChangeStateRefused");
        expect(world.changes.stateOf(changeId)).toBe("submitted");
        expect(world.changes.calls).toHaveLength(0);
      });
    },
  );
});
