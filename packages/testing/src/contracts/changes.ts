import { describe, expect, it } from "@effect/vitest";
import { type DeclareInput, type SubmitInput } from "@keeltown/core/application/coordination";
import { FootprintEntry } from "@keeltown/core/domain/coordination";
import type { Principal } from "@keeltown/core/domain/identity";
import { AgentId, ChangeId, CommitSha, LeaseId, ProjectId } from "@keeltown/core/kernel";
import { Changes, type WorkspaceGrant } from "@keeltown/core/ports";
import { Effect, Fiber, type Layer, Schema } from "effect";

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
  readonly caller?: () => Effect.Effect<Principal>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const fresh = (prefix: string) =>
  `${prefix}_${[...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`;

/** A caller of its own per test: a real adapter's DOs outlive one case. */
function principal(): Principal {
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
      lease: result.change.lease.id,
      idempotencyKey: `submit-${crypto.randomUUID()}`,
      commitSha,
      ...overrides,
    });
    return { who, result, commitSha, submit };
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
        expect((yield* changes.get(result.change.id)).state).toBe("submitted");
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
  });
}
