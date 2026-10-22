import { describe, expect, it } from "@effect/vitest";
import { type DeclareInput, type SubmitInput } from "@keeltown/core/application/coordination";
import { type Change, FootprintEntry, Proposition } from "@keeltown/core/domain/coordination";
import type { AgentToken } from "@keeltown/core/domain/identity";
import {
  AgentId,
  ChangeId,
  CommitSha,
  LeaseId,
  ProjectId,
  RunRef,
  UserId,
} from "@keeltown/core/kernel";
import { Changes, type WorkspaceGrant } from "@keeltown/core/ports";
import { Effect, Fiber, type Layer, Schema } from "effect";

/** The lease of an agent's change: every change the suite declares is an agent's, and holds one. */
const leaseIdOf = (change: Change) => {
  if (change.lease === undefined) throw new Error(`${change.id} holds no lease`);
  return change.lease.id;
};

/**
 * What the `Changes` suite needs beside the port: a way to put a commit into a
 * granted workspace, as the agent's `git push` would. A factory per test, so
 * each case starts from a fresh adapter.
 */
export interface ChangesHarness {
  readonly layer: Layer.Layer<Changes>;
  readonly push: (grant: WorkspaceGrant) => Effect.Effect<CommitSha>;
  /**
   * A caller whose project can declare: a real adapter's project needs a
   * stocked WorkspacePool first. Absent, each case makes its own.
   */
  readonly caller?: () => Effect.Effect<AgentToken>;
  /** The change's lease deadline passes, as time would let it, so an adopt may take it. */
  readonly lapse: (changeId: ChangeId) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fresh = (prefix: string) =>
  `${prefix}_${[...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`;

/** A caller of its own per test: a real adapter's DOs outlive one case. */
function principal(): AgentToken {
  return {
    agentId: Schema.decodeUnknownSync(AgentId)(fresh("agt")),
    projectId: Schema.decodeUnknownSync(ProjectId)(fresh("prj")),
    scopes: ["agent:read", "agent:work"],
    revocationEpoch: 0,
  };
}

function declaration(goal = "Cache permission lookups per request"): DeclareInput {
  return {
    goal,
    footprint: [Schema.decodeUnknownSync(FootprintEntry)({ path: "src/authz/**", op: "edit" })],
    premises: [],
    idempotencyKey: `declare-${crypto.randomUUID()}`,
  };
}

const NOWHERE = Schema.decodeUnknownSync(CommitSha)("f".repeat(40));

const premise = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});

/** A declared change with a commit pushed to its workspace, and a submit for it. */
/** A caller of the harness's making, or a fresh one. */
const callerOf = (harness: ChangesHarness) => harness.caller?.() ?? Effect.sync(principal);

const declared = (harness: ChangesHarness) =>
  Effect.gen(function* () {
    const who = yield* callerOf(harness);
    const changes = yield* Changes;
    const result = yield* changes.declare(who, declaration());
    const commitSha = yield* harness.push(result.workspace);
    const submit = (overrides: Partial<SubmitInput> = {}): SubmitInput => ({
      changeId: result.change.id,
      lease: leaseIdOf(result.change),
      idempotencyKey: `submit-${crypto.randomUUID()}`,
      commitSha,
      ...overrides,
    });
    return { who, result, commitSha, submit };
  });

/** A maintainer of `projectId`, as the doorway authorised them: they hold no lease. */
const maintainerOf = (projectId: ProjectId) => ({
  _tag: "Maintainer" as const,
  by: Schema.decodeUnknownSync(UserId)(fresh("usr")),
  projectId,
});

/** A declared change whose lease has lapsed, and another agent of its project to adopt it. */
const lapsedChange = (harness: ChangesHarness) =>
  Effect.gen(function* () {
    const found = yield* declared(harness);
    yield* harness.lapse(found.result.change.id);
    const adopter: AgentToken = {
      ...found.who,
      agentId: Schema.decodeUnknownSync(AgentId)(fresh("agt")),
    };
    return { ...found, adopter };
  });

export function describeChangesContract(adapter: string, make: () => ChangesHarness) {
  describe(`Changes contract: ${adapter}`, () => {
    it.live(
      "declares a working change, with its caller's active lease, a workspace and preflight",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const { who, result } = yield* declared(harness);
          expect(result.change).toMatchObject({
            agentId: who.agentId,
            state: "working",
            intent: { revision: 1, goal: "Cache permission lookups per request" },
            lease: { agentId: who.agentId, state: "active" },
            workspaceId: result.workspace.workspaceId,
          });
          expect(result.workspace.token).not.toBe("");
          expect(result.preflight.suggestedMove).toBe("proceed");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[run.changes-port] a change declared under a token that names a run is held by that run, and one declared under none is held by none",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const run = Schema.decodeUnknownSync(RunRef)({ id: fresh("run"), label: "run-c" });
          const held = yield* changes.declare(
            { ...(yield* callerOf(harness)), run },
            declaration(),
          );
          expect(held.change.run).toEqual(run);
          const { run: _none, ...noRun } = yield* callerOf(harness);
          const unheld = yield* changes.declare(noRun, declaration());
          expect("run" in unheld.change).toBe(false);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("reaches the same change when a declare is retried with its key and body", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const who = yield* callerOf(harness);
        const input = declaration();
        const first = yield* changes.declare(who, input);
        const again = yield* changes.declare(who, input);
        expect(again.change.id).toBe(first.change.id);
        expect(again.workspace.workspaceId).toBe(first.workspace.workspaceId);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses a declare key reused for another body as IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const who = yield* callerOf(harness);
        const input = declaration();
        yield* changes.declare(who, input);
        const error = yield* Effect.flip(
          changes.declare(who, { ...input, goal: "Something else entirely" }),
        );
        expect(error).toMatchObject({
          _tag: "IdempotencyConflict",
          idempotencyKey: input.idempotencyKey,
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("submits a pushed commit under the change's lease, and reads it back", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, result, commitSha, submit } = yield* declared(harness);
        const submitted = yield* changes.submit(who, submit());
        expect(submitted).toMatchObject({ id: result.change.id, state: "submitted" });
        const read = yield* changes.get(result.change.id);
        expect(read.change.state).toBe("submitted");
        expect(read.projectId).toBe(who.projectId);
        const status = yield* changes.awaitSubmission(result.change.id, 0);
        expect(status.commitSha).toBe(commitSha);
        expect(status.change.state).toBe("submitted");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses a submit under another lease as LeaseStale", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, submit } = yield* declared(harness);
        const other = Schema.decodeUnknownSync(LeaseId)(fresh("lse"));
        const error = yield* Effect.flip(changes.submit(who, submit({ lease: other })));
        expect(error).toMatchObject({ _tag: "LeaseStale", leaseId: other });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses a commit the workspace does not hold as CommitNotInWorkspace", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, submit } = yield* declared(harness);
        const error = yield* Effect.flip(changes.submit(who, submit({ commitSha: NOWHERE })));
        expect(error).toMatchObject({ _tag: "CommitNotInWorkspace", commitSha: NOWHERE });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "refuses a second submit while the first is with the platform, as ChangeStateRefused",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, submit } = yield* declared(harness);
          yield* changes.submit(who, submit());
          const error = yield* Effect.flip(changes.submit(who, submit()));
          // `command` is the domain command's tag, as the Change machine names it.
          expect(error).toMatchObject({
            _tag: "ChangeStateRefused",
            state: "submitted",
            command: "Submit",
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "refreshes the workspace a change holds for its own agent under its lease: the same workspace, a token of its own",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const refreshed = yield* changes.refreshWorkspace(who, {
            changeId: result.change.id,
            lease: leaseIdOf(result.change),
          });
          expect(refreshed).toMatchObject({
            workspaceId: result.workspace.workspaceId,
            remote: result.workspace.remote,
          });
          expect(refreshed.token).not.toBe("");
          expect(refreshed.token).not.toBe(result.workspace.token);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "reads a refresh by another agent, or by the change's agent in another project, as ChangeNotFound",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const input = { changeId: result.change.id, lease: leaseIdOf(result.change) };
          const other: AgentToken = {
            ...who,
            agentId: Schema.decodeUnknownSync(AgentId)(fresh("agt")),
          };
          const elsewhere: AgentToken = {
            ...who,
            projectId: Schema.decodeUnknownSync(ProjectId)(fresh("prj")),
          };
          const errors = [
            yield* Effect.flip(changes.refreshWorkspace(other, input)),
            yield* Effect.flip(changes.refreshWorkspace(elsewhere, input)),
          ];
          expect(errors).toMatchObject([
            { _tag: "ChangeNotFound", changeId: result.change.id },
            { _tag: "ChangeNotFound", changeId: result.change.id },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("refuses a refresh under another lease as LeaseStale", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, result } = yield* declared(harness);
        const other = Schema.decodeUnknownSync(LeaseId)(fresh("lse"));
        const error = yield* Effect.flip(
          changes.refreshWorkspace(who, { changeId: result.change.id, lease: other }),
        );
        expect(error).toMatchObject({
          _tag: "LeaseStale",
          changeId: result.change.id,
          leaseId: other,
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses a refresh of an abandoned change as ChangeStateRefused", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, result } = yield* declared(harness);
        const lease = leaseIdOf(result.change);
        yield* changes.abandon({
          changeId: result.change.id,
          authority: {
            _tag: "Lease",
            leaseId: lease,
            agentId: who.agentId,
            projectId: who.projectId,
          },
          reason: "A smaller change does it",
          idempotencyKey: `abandon-${crypto.randomUUID()}`,
        });
        const error = yield* Effect.flip(
          changes.refreshWorkspace(who, { changeId: result.change.id, lease }),
        );
        expect(error).toMatchObject({
          _tag: "ChangeStateRefused",
          changeId: result.change.id,
          state: "withdrawn",
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers ChangeNotFound for a change that was never declared", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const changeId = Schema.decodeUnknownSync(ChangeId)(fresh("chg"));
        const lease = Schema.decodeUnknownSync(LeaseId)(fresh("lse"));
        const submit = { changeId, lease, commitSha: NOWHERE, idempotencyKey: "submit-unknown" };
        const errors = [
          yield* Effect.flip(changes.submit(principal(), submit)),
          yield* Effect.flip(changes.get(changeId)),
          yield* Effect.flip(changes.awaitSubmission(changeId, 0)),
        ];
        expect(errors.map((error) => error._tag)).toEqual([
          "ChangeNotFound",
          "ChangeNotFound",
          "ChangeNotFound",
        ]);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers a waiting status read as soon as a submit moves the change", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const { who, result, submit } = yield* declared(harness);
        const started = Date.now();
        const waiting = yield* Effect.forkChild(changes.awaitSubmission(result.change.id, 20));
        yield* Effect.sleep("200 millis");
        yield* changes.submit(who, submit());
        const status = yield* Fiber.join(waiting);
        expect(status.change.state).toBe("submitted");
        expect(Date.now() - started).toBeLessThan(10_000);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "answers a waiting status read with the change as it stands when the wait runs out",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { result } = yield* declared(harness);
          const started = Date.now();
          const status = yield* changes.awaitSubmission(result.change.id, 1);
          expect(Date.now() - started).toBeGreaterThanOrEqual(900);
          expect(status).toMatchObject({ change: { state: "working" }, commitSha: null });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b11.adopt] adopts a lapsed change: a new lease for the adopter, a fresh workspace token, the old lease fenced",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result, adopter, submit } = yield* lapsedChange(harness);
          const adopted = yield* changes.adopt(adopter, {
            changeId: result.change.id,
            idempotencyKey: `adopt-${crypto.randomUUID()}`,
          });
          expect(adopted.change).toMatchObject({
            id: result.change.id,
            agentId: adopter.agentId,
            lease: { agentId: adopter.agentId, state: "active" },
          });
          expect(leaseIdOf(adopted.change)).not.toBe(leaseIdOf(result.change));
          expect(adopted.workspace?.workspaceId).toBe(result.workspace.workspaceId);
          expect(adopted.workspace?.token).not.toBe("");
          const fenced = yield* Effect.flip(changes.submit(who, submit()));
          expect(fenced._tag).toBe("LeaseStale");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b11.adopt-early] refuses an adopt while the lease is alive as LeaseNotLapsed, with when it lapses",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const adopter: AgentToken = {
            ...who,
            agentId: Schema.decodeUnknownSync(AgentId)(fresh("agt")),
          };
          const error = yield* Effect.flip(
            changes.adopt(adopter, { changeId: result.change.id, idempotencyKey: "adopt-early" }),
          );
          expect(error).toMatchObject({ _tag: "LeaseNotLapsed", changeId: result.change.id });
          expect(error._tag === "LeaseNotLapsed" ? error.lapsesAt : 0).toBeGreaterThan(Date.now());
          expect(error._tag === "LeaseNotLapsed" ? error.nextActions.length : 0).toBeGreaterThan(0);
          expect(leaseIdOf((yield* changes.get(result.change.id)).change)).toBe(
            leaseIdOf(result.change),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b11.adopt-replay] answers a retried adopt with the same lease, and the key from another agent as IdempotencyConflict",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { result, adopter } = yield* lapsedChange(harness);
          const input = {
            changeId: result.change.id,
            idempotencyKey: `adopt-${crypto.randomUUID()}`,
          };
          const first = yield* changes.adopt(adopter, input);
          const again = yield* changes.adopt(adopter, input);
          expect(leaseIdOf(again.change)).toBe(leaseIdOf(first.change));
          expect(again.workspace?.workspaceId).toBe(first.workspace?.workspaceId);
          const other: AgentToken = {
            ...adopter,
            agentId: Schema.decodeUnknownSync(AgentId)(fresh("agt")),
          };
          const error = yield* Effect.flip(changes.adopt(other, input));
          expect(error).toMatchObject({
            _tag: "IdempotencyConflict",
            idempotencyKey: input.idempotencyKey,
          });
          expect((yield* changes.get(result.change.id)).change.agentId).toBe(adopter.agentId);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b11.adopt-foreign] refuses an agent of another project as ChangeInOtherProject, lapsed or not",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { result, adopter } = yield* lapsedChange(harness);
          const foreign: AgentToken = {
            ...adopter,
            projectId: Schema.decodeUnknownSync(ProjectId)(fresh("prj")),
          };
          const error = yield* Effect.flip(
            changes.adopt(foreign, { changeId: result.change.id, idempotencyKey: "adopt-foreign" }),
          );
          expect(error).toMatchObject({ _tag: "ChangeInOtherProject", changeId: result.change.id });
          expect(leaseIdOf((yield* changes.get(result.change.id)).change)).toBe(
            leaseIdOf(result.change),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b21.changes-revise] revises at the revision last read, replays its key, and refuses a stale revision as RevisionMismatch",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const input = {
            changeId: result.change.id,
            lease: leaseIdOf(result.change),
            idempotencyKey: `revise-${crypto.randomUUID()}`,
            ifMatchRevision: 1,
            goal: "Cache permission lookups per session",
            premisesAdded: [premise],
            premisesRetracted: [],
          };
          const revised = yield* changes.revise(who, input);
          expect(revised.change.intent).toMatchObject({
            revision: 2,
            goal: "Cache permission lookups per session",
            premises: [premise],
          });
          expect(revised.preflight.contradictions).toEqual([]);
          expect((yield* changes.revise(who, input)).change.intent.revision).toBe(2);
          const reused = yield* Effect.flip(changes.revise(who, { ...input, goal: "another" }));
          expect(reused).toMatchObject({ _tag: "IdempotencyConflict" });
          const stale = yield* Effect.flip(
            changes.revise(who, { ...input, idempotencyKey: `revise-${crypto.randomUUID()}` }),
          );
          expect(stale).toMatchObject({ _tag: "RevisionMismatch", expected: 1, actual: 2 });
          const fenced = yield* Effect.flip(
            changes.revise(who, {
              ...input,
              ifMatchRevision: 2,
              lease: Schema.decodeUnknownSync(LeaseId)(fresh("lse")),
              idempotencyKey: `revise-${crypto.randomUUID()}`,
            }),
          );
          expect(fenced).toMatchObject({ _tag: "LeaseStale" });
          expect((yield* changes.get(result.change.id)).change.intent.revision).toBe(2);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b21.changes-rely] adds one premise at the next revision, replays its key, and refuses another lease",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const input = {
            changeId: result.change.id,
            lease: leaseIdOf(result.change),
            idempotencyKey: `rely-${crypto.randomUUID()}`,
            premise,
          };
          const relied = yield* changes.rely(who, input);
          expect(relied.change.intent).toMatchObject({ revision: 2, premises: [premise] });
          expect(relied.preflight.suggestedMove).toBe("proceed");
          expect((yield* changes.rely(who, input)).change.intent.revision).toBe(2);
          const fenced = yield* Effect.flip(
            changes.rely(who, {
              ...input,
              lease: Schema.decodeUnknownSync(LeaseId)(fresh("lse")),
              idempotencyKey: `rely-${crypto.randomUUID()}`,
            }),
          );
          expect(fenced).toMatchObject({ _tag: "LeaseStale", changeId: result.change.id });
          expect((yield* changes.get(result.change.id)).change.intent.revision).toBe(2);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b21.changes-nearby] reads what is near for a reader of the change's project, and refuses another project",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const near = yield* changes.nearby(who.projectId, result.change.id);
          expect(near).toMatchObject({ contradictions: [], suggestedMove: "proceed" });
          const foreign = Schema.decodeUnknownSync(ProjectId)(fresh("prj"));
          const refused = yield* Effect.flip(changes.nearby(foreign, result.change.id));
          expect(refused).toMatchObject({
            _tag: "ChangeInOtherProject",
            changeId: result.change.id,
          });
          const changeId = Schema.decodeUnknownSync(ChangeId)(fresh("chg"));
          const missing = yield* Effect.flip(changes.nearby(who.projectId, changeId));
          expect(missing).toMatchObject({ _tag: "ChangeNotFound", changeId });
          expect((yield* changes.get(result.change.id)).change.intent.revision).toBe(1);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("refuses an adopt of an unknown change as ChangeNotFound", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const changeId = Schema.decodeUnknownSync(ChangeId)(fresh("chg"));
        const error = yield* Effect.flip(
          changes.adopt(yield* callerOf(harness), { changeId, idempotencyKey: "adopt-nowhere" }),
        );
        expect(error).toMatchObject({ _tag: "ChangeNotFound", changeId });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[changes.abandon] withdraws a change under its lease: it ends, and its lease is released",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const lease = leaseIdOf(result.change);
          const withdrawn = yield* changes.abandon({
            changeId: result.change.id,
            authority: {
              _tag: "Lease",
              leaseId: lease,
              agentId: who.agentId,
              projectId: who.projectId,
            },
            reason: "A smaller change does it",
            idempotencyKey: `abandon-${crypto.randomUUID()}`,
          });
          expect(withdrawn).toMatchObject({
            id: result.change.id,
            agentId: who.agentId,
            state: "withdrawn",
            lease: { id: lease, state: "released" },
          });
          expect((yield* changes.get(result.change.id)).change.state).toBe("withdrawn");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[changes.abandon-maintainer] withdraws a change as a maintainer of its project, who holds no lease on it; a maintainer of another project is ChangeNotFound",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const foreign = maintainerOf(Schema.decodeUnknownSync(ProjectId)(fresh("prj")));
          const refused = yield* Effect.flip(
            changes.abandon({
              changeId: result.change.id,
              authority: foreign,
              idempotencyKey: `abandon-${crypto.randomUUID()}`,
            }),
          );
          expect(refused).toMatchObject({ _tag: "ChangeNotFound", changeId: result.change.id });
          expect((yield* changes.get(result.change.id)).change.state).toBe("working");
          const withdrawn = yield* changes.abandon({
            changeId: result.change.id,
            authority: maintainerOf(who.projectId),
            idempotencyKey: `abandon-${crypto.randomUUID()}`,
          });
          expect(withdrawn).toMatchObject({
            id: result.change.id,
            agentId: who.agentId,
            state: "withdrawn",
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[changes.abandon-stale] refuses a withdraw under another lease as LeaseStale, and the change carries on",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const other = Schema.decodeUnknownSync(LeaseId)(fresh("lse"));
          const error = yield* Effect.flip(
            changes.abandon({
              changeId: result.change.id,
              authority: {
                _tag: "Lease",
                leaseId: other,
                agentId: who.agentId,
                projectId: who.projectId,
              },
              idempotencyKey: `abandon-${crypto.randomUUID()}`,
            }),
          );
          expect(error).toMatchObject({ _tag: "LeaseStale", leaseId: other });
          expect((yield* changes.get(result.change.id)).change.state).toBe("working");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[changes.abandon-refused] refuses a second withdraw, under a new key, as ChangeStateRefused",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const maintainer = maintainerOf(who.projectId);
          const withdraw = (idempotencyKey: string) =>
            changes.abandon({ changeId: result.change.id, authority: maintainer, idempotencyKey });
          yield* withdraw(`abandon-${crypto.randomUUID()}`);
          const error = yield* Effect.flip(withdraw(`abandon-${crypto.randomUUID()}`));
          expect(error).toMatchObject({
            _tag: "ChangeStateRefused",
            changeId: result.change.id,
            state: "withdrawn",
            command: "Withdraw",
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[changes.abandon-replay] answers a retried withdraw with the same change, and the key with another reason as IdempotencyConflict",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const changes = yield* Changes;
          const { who, result } = yield* declared(harness);
          const input = {
            changeId: result.change.id,
            authority: {
              _tag: "Lease" as const,
              leaseId: leaseIdOf(result.change),
              agentId: who.agentId,
              projectId: who.projectId,
            },
            reason: "A smaller change does it",
            idempotencyKey: `abandon-${crypto.randomUUID()}`,
          };
          const first = yield* changes.abandon(input);
          const again = yield* changes.abandon(input);
          expect(again).toEqual(first);
          const error = yield* Effect.flip(
            changes.abandon({ ...input, reason: "Another reason entirely" }),
          );
          expect(error).toMatchObject({
            _tag: "IdempotencyConflict",
            idempotencyKey: input.idempotencyKey,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("refuses an abandon of an unknown change as ChangeNotFound", () => {
      const harness = make();
      return Effect.gen(function* () {
        const changes = yield* Changes;
        const changeId = Schema.decodeUnknownSync(ChangeId)(fresh("chg"));
        const error = yield* Effect.flip(
          changes.abandon({
            changeId,
            authority: maintainerOf(principal().projectId),
            idempotencyKey: "abandon-nowhere",
          }),
        );
        expect(error).toMatchObject({ _tag: "ChangeNotFound", changeId });
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
