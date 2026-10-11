import { describe, expect, it } from "@effect/vitest";
import {
  checkAncestry,
  decidePrecheck,
  diffSubmission,
  type PrecheckFindings,
  type PrecheckSubmission,
  precheckPolicy,
  recordPlan,
  refuseSubmission,
  startPrecheck,
} from "@keeltown/core/application/verification";
import { CommitSha, Glob, makeId, type ProjectId, type WorkspaceId } from "@keeltown/core/kernel";
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
const workspaceId: WorkspaceId = makeId("wsp", "01JZD12D12D12D12D12D12D12D");
const repo = { namespace: "keel-ws-00", name: "ws-d12" };
const MAIN = "refs/heads/main";
const KEEL_TRUNK = "refs/heads/keel/trunk";
const BASE_FILES: FixtureFiles = {
  "src/a.ts": "export const a = 1;\n",
  "infra/main.tf": 'resource "x" "y" {}\n',
  ".keel/guards/g1.test.ts": "test('g1', () => {});\n",
};

/** A read Precheck asked of the code host, with its arguments after the repo. */
type HostRead =
  | {
      readonly method: "isAncestor";
      readonly ancestor: CommitSha;
      readonly descendant: CommitSha;
      readonly stopAt: readonly CommitSha[];
    }
  | { readonly method: "diffTrees"; readonly base: CommitSha; readonly head: CommitSha };

/**
 * Precheck's world in memory: a workspace repo granted at the base files'
 * commit, the agent's commits on its main and trunk's on its keel/trunk (as a
 * rebase puts them), the change submitted on that workspace, and the
 * project's settings. Precheck's ancestry walks and diffs are recorded in
 * `reads`. `run` takes the Workflow's steps in order.
 */
function precheckWorld(options: { readonly protectedPaths?: readonly string[] } = {}) {
  const code = makeCodeHostMemory();
  const changes = makeChangePrecheckMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: (options.protectedPaths ?? ["infra/**"]).map((g) => Glob.make(g)),
    maxBatchSize: 4,
    verification: "required",
    visibility: "private",
  });
  const reads: HostRead[] = [];
  const recording = Layer.effect(
    CodeHost,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      return CodeHost.of({
        ...host,
        isAncestor: (at, ancestor, descendant, stopAt) => {
          reads.push({ method: "isAncestor", ancestor, descendant, stopAt });
          return host.isAncestor(at, ancestor, descendant, stopAt);
        },
        diffTrees: (at, base, head) => {
          reads.push({ method: "diffTrees", base, head });
          return host.diffTrees(at, base, head);
        },
      });
    }),
  ).pipe(Layer.provide(code.layer));
  const layer = Layer.mergeAll(recording, changes.layer, projects.layer);
  /** Commits `files` as the whole tree on `ref`, on top of its head and then `merged`. */
  const commitOn = (ref: string, files: FixtureFiles, merged?: readonly CommitSha[]) =>
    Effect.gen(function* () {
      return yield* (yield* CodeHostFixture).commit(repo, ref, files, merged);
    }).pipe(Effect.provide(code.layer));

  /** Creates the workspace repo, granted at the base files' commit on main. */
  const grant = () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* CodeHost).create(repo);
      }).pipe(Effect.provide(code.layer));
      return yield* commitOn(MAIN, BASE_FILES);
    });

  /** A push to the workspace's main: `files` as the whole tree, merging `merged`. */
  const push = (files: FixtureFiles, merged?: readonly CommitSha[]) =>
    commitOn(MAIN, files, merged);

  /** Trunk moves on past the grant: `files` on keel/trunk, parented on `granted`, as a rebase puts it there. */
  const trunk = (granted: CommitSha, files: FixtureFiles) => commitOn(KEEL_TRUNK, files, [granted]);

  /**
   * Seeds the change as submitted at revision 1 on `commitSha`, judged
   * against `base` (none: an older submission that carries no base). The
   * workspace view serves the change's current base, the grant's when none.
   */
  const submit = (
    granted: CommitSha,
    commitSha: CommitSha,
    base: CommitSha | undefined,
    instanceId = "precheck-evt_1",
  ): PrecheckSubmission => {
    const workspace: PrecheckWorkspace = {
      workspaceId,
      repo,
      baseSha: base ?? granted,
      grantedSha: granted,
      projectId,
    };
    changes.submit(changeId, 1, workspace);
    return { changeId, revision: 1, commitSha, baseSha: base, instanceId };
  };

  /** Grants the workspace and submits the last of `pushes` (each a whole tree) at revision 1, on the grant. */
  const submitted = (pushes: readonly FixtureFiles[], instanceId = "precheck-evt_1") =>
    Effect.gen(function* () {
      const granted = yield* grant();
      let head: CommitSha = granted;
      for (const files of pushes) head = yield* push(files);
      return submit(granted, head, granted, instanceId);
    });

  /** The Workflow's steps, in order, on these use-cases. */
  const run = (submission: PrecheckSubmission) =>
    Effect.gen(function* () {
      const workspace = yield* startPrecheck(submission);
      const ancestry = yield* checkAncestry(workspace, submission);
      const findings: PrecheckFindings =
        ancestry._tag === "Descends"
          ? {
              ancestry,
              touched: yield* diffSubmission(workspace, ancestry.base, submission.commitSha),
              policy: yield* precheckPolicy(workspace),
            }
          : { ancestry };
      const decision = decidePrecheck(findings);
      if (decision._tag === "Refuse") yield* refuseSubmission(submission, decision);
      else yield* recordPlan(submission, decision);
      return decision;
    }).pipe(Effect.provide(layer));

  return { code, changes, layer, reads, grant, push, trunk, submit, submitted, run };
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

describe("Precheck's ancestry", () => {
  it.effect(
    "[c14.descends] compiles a commit that descends from its base, after one ancestry walk stopped at the grant",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, granted));
        expect(decision._tag).toBe("Compile");
        expect(world.reads).toEqual([
          { method: "isAncestor", ancestor: granted, descendant: work, stopAt: [granted] },
          { method: "diffTrees", base: granted, head: work },
        ]);
      });
    },
  );

  it.effect(
    "[c14.diverged] refuses a commit that does not descend from the rebased base, naming rebase and the merge, before any diff",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const trunk = yield* world.trunk(granted, withFile("src/b.ts", "trunk\n"));
        // Rebased onto trunk's head, then pushed without merging keel/trunk.
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, trunk));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:not-on-base:${work} does not descend from ${trunk}`],
          nextActions: [
            {
              kind: "call",
              operationId: "rebase",
              title: expect.stringContaining("git fetch origin keel/trunk && git merge FETCH_HEAD"),
              args: { base: trunk },
            },
          ],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
        expect(world.reads.map((r) => r.method)).toEqual(["isAncestor"]);
      });
    },
  );

  it.effect(
    "[c14.merged] passes a merge of keel/trunk, diffed from the rebased base, so trunk's own guard change is not the agent's",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const onTrunk = withFile(".keel/guards/g1.test.ts", "test('g1 tightened', () => {});\n");
        const trunk = yield* world.trunk(granted, onTrunk);
        // The agent's own work, then its merge of keel/trunk: parents [work, trunk].
        yield* world.push(withFile("src/a.ts"));
        const merge = yield* world.push({ ...onTrunk, "src/a.ts": "changed\n" }, [trunk]);
        const decision = yield* world.run(world.submit(granted, merge, trunk));
        expect(decision._tag).toBe("Compile");
        expect(world.changes.stateOf(changeId)).toBe("queued");
        expect(world.reads).toEqual([
          { method: "isAncestor", ancestor: trunk, descendant: merge, stopAt: [granted] },
          { method: "diffTrees", base: trunk, head: merge },
        ]);
      });
    },
  );

  it.effect(
    "[c14.missing] refuses, never as a defect, a commit whose history the workspace lacks, naming the missing object and the commit",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const lost = CommitSha.make("e".repeat(40));
        const merge = yield* world.push(withFile("src/a.ts"), [lost]);
        const decision = yield* world.run(world.submit(granted, merge, granted));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${lost}, in the history of ${merge}`],
          nextActions: [expect.objectContaining({ kind: "call", operationId: "submit" })],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[c14.missing] refuses a submitted commit the workspace does not hold, naming it, before any diff",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const absent = CommitSha.make("f".repeat(40));
        const decision = yield* world.run(world.submit(granted, absent, granted));
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${absent}`],
        });
        expect(world.reads.map((r) => r.method)).toEqual(["isAncestor"]);
      });
    },
  );

  it.effect(
    "[c14.stop-at] walks from the submission's base with the grant as its only stop, even after a rebase moved the base",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const trunk = yield* world.trunk(granted, withFile("src/b.ts", "trunk\n"));
        const merge = yield* world.push(
          { ...withFile("src/b.ts", "trunk\n"), "src/a.ts": "changed\n" },
          [trunk],
        );
        yield* world.run(world.submit(granted, merge, trunk));
        expect(world.reads[0]).toEqual({
          method: "isAncestor",
          ancestor: trunk,
          descendant: merge,
          stopAt: [granted],
        });
      });
    },
  );

  it.effect(
    "[c14.no-base] refuses a submission that carries no base, reading nothing, never falling back to the workspace's",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, undefined));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:no-base:${work} was submitted without the base it is judged against`],
          nextActions: [expect.objectContaining({ kind: "call", operationId: "submit" })],
        });
        expect(world.reads).toEqual([]);
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );
});
