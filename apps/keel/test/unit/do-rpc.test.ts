import { describe, expect, it } from "@effect/vitest";
import {
  Change,
  FootprintEntry,
  LeaseStale,
  PoolExhausted,
  Preflight,
  ChangeStateRefused,
} from "@keeltown/core/domain/coordination";
import {
  AgentNotKnown,
  IdempotencyConflict,
  type AgentToken,
} from "@keeltown/core/domain/identity";
import { AgentId, ChangeId, CommitSha, LeaseId, ProjectId } from "@keeltown/core/kernel";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { Changes, Inbox } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { type ChangeObjects, ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { fingerprintOf } from "../../src/adapters/driven/do-rpc/answer.ts";
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import {
  AgentSessionCodecs,
  ChangeCodecs,
  ChangeWorkspace,
  type DeclareCommand,
  encodeExit,
  type SubmitCommand,
  WorkspaceGrant,
} from "../../src/rpc/index.ts";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const changeId = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const lease = Schema.decodeUnknownSync(LeaseId)("lse_01JZ8PT2C4E6G8J0M2N4Q6S8V2");
const principal: AgentToken = {
  agentId,
  projectId: Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V3"),
  scopes: ["agent:work"],
  revocationEpoch: 0,
};
const change = Schema.decodeUnknownSync(Change)({
  id: changeId,
  agentId,
  origin: "agent",
  state: "working",
  intent: { revision: 1, goal: "Cache permission lookups", footprint: [], premises: [] },
  lease: { id: lease, agentId, renewedAt: 1_000, state: "active" },
  createdAt: 1_000,
});
const preflight = Schema.decodeUnknownSync(Preflight)({
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
});
const grant = {
  workspaceId: "wsp_01JZ8PT2C4E6G8J0M2N4Q6S8V4",
  remote: "https://artifacts.invalid/wsp.git",
  token: "write-token",
  expiresAt: 5_000,
  baseSha: "0".repeat(40),
  repo: { namespace: "keel-ws-00", name: "wsp-01jz8pt2c4e6g8j0m2n4q6s8v4" },
};
/** What the change's DO answers for `workspace()`: its repo, its base, and the commit it was granted at. */
const granted = {
  workspaceId: grant.workspaceId,
  repo: grant.repo,
  baseSha: grant.baseSha,
  grantedSha: grant.baseSha,
  flowAt: grant.baseSha,
  projectId: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V5",
  subjects: ["authz.permissions"],
  intent: { revision: 1, goal: "Cache permission lookups", footprint: [], premises: [] },
};
const input = {
  goal: "Cache permission lookups",
  footprint: [Schema.decodeUnknownSync(FootprintEntry)({ path: "src/authz/**", op: "edit" })],
  premises: [],
  idempotencyKey: "declare-0001",
};

/** Fake objects that record what they were sent and answer the Exit each test scripts. */
function objects(answers: {
  reserve?: Exit.Exit<ChangeId, IdempotencyConflict>;
  declare?: Exit.Exit<
    { change: Change; preflight: Preflight; grant: typeof WorkspaceGrant.Type },
    ChangeStateRefused | PoolExhausted
  >;
  submit?: Exit.Exit<Change, LeaseStale>;
}) {
  const sent: {
    reserve: unknown[];
    declare: Array<{ name: string; command: typeof DeclareCommand.Encoded }>;
    submit: Array<{ name: string; command: typeof SubmitCommand.Encoded }>;
    waits: number[];
    workspaces: string[];
  } = { reserve: [], declare: [], submit: [], waits: [], workspaces: [] };
  const fake: ChangeObjects = {
    agentSession: () => ({
      reserveChange: async (request) => {
        sent.reserve.push(request);
        return encodeExit(
          AgentSessionCodecs.reserveChange,
          answers.reserve ?? Exit.succeed(changeId),
        );
      },
      inbox: async () =>
        encodeExit(AgentSessionCodecs.inbox, Exit.fail(new AgentNotKnown({ agentId }))),
    }),
    change: (id) => ({
      declare: async (command) => {
        sent.declare.push({ name: id, command });
        return encodeExit(
          ChangeCodecs.declare,
          answers.declare ??
            Exit.succeed({
              change,
              preflight,
              grant: Schema.decodeUnknownSync(WorkspaceGrant)(grant),
            }),
        );
      },
      adopt: async () => {
        throw new Error("this test never adopts");
      },
      rebase: async () => {
        throw new Error("this test never rebases");
      },
      commit: async () => {
        throw new Error("this test never commits");
      },
      refreshWorkspace: async () => {
        throw new Error("this test never refreshes a workspace");
      },
      revise: async () => {
        throw new Error("this test never revises");
      },
      rely: async () => {
        throw new Error("this test never relies");
      },
      distinguish: async () => {
        throw new Error("this test never distinguishes");
      },
      nearby: async () => {
        throw new Error("this test never reads nearby");
      },
      abandon: async () => {
        throw new Error("this test never abandons");
      },
      submit: async (command) => {
        sent.submit.push({ name: id, command });
        return encodeExit(ChangeCodecs.submit, answers.submit ?? Exit.succeed(change));
      },
      get: async () =>
        encodeExit(ChangeCodecs.get, Exit.die(new NotImplemented("coordination/getChange"))),
      submission: async (waitMs) => {
        sent.waits.push(waitMs);
        return encodeExit(ChangeCodecs.submission, Exit.succeed({ change, commitSha: null }));
      },
      workspace: async () => {
        sent.workspaces.push(id);
        return encodeExit(
          ChangeCodecs.workspace,
          Exit.succeed(Schema.decodeUnknownSync(ChangeWorkspace)(granted)),
        );
      },
      // No case here proposes: a proposal's calls are proven in proposals-http and the pool.
      propose: async () => encodeExit(ChangeCodecs.propose, Exit.die("no proposal here")),
      updateProposal: async () =>
        encodeExit(ChangeCodecs.updateProposal, Exit.die("no proposal here")),
      approveProposal: async () =>
        encodeExit(ChangeCodecs.approveProposal, Exit.die("no proposal here")),
      requestProposalChanges: async () =>
        encodeExit(ChangeCodecs.requestProposalChanges, Exit.die("no proposal here")),
      closeProposal: async () =>
        encodeExit(ChangeCodecs.closeProposal, Exit.die("no proposal here")),
    }),
  };
  return { fake, sent };
}

describe("Changes over Durable Object RPC", () => {
  it.effect(
    "declares on the change its key reserved, fingerprinting the body, and answers the grant as the workspace",
    () => {
      const { fake, sent } = objects({});
      return Effect.gen(function* () {
        const declared = yield* (yield* Changes).declare(principal, input);
        expect(declared.change.id).toBe(changeId);
        expect(declared.workspace).toMatchObject({
          workspaceId: grant.workspaceId,
          token: "write-token",
        });
        expect(sent.reserve).toEqual([
          {
            idempotencyKey: "declare-0001",
            fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          },
        ]);
        expect(sent.declare).toEqual([
          {
            name: changeId,
            command: expect.objectContaining({
              changeId,
              agentId,
              projectId: principal.projectId,
              origin: "agent",
              goal: input.goal,
              idempotencyKey: "declare-0001",
            }),
          },
        ]);
      }).pipe(Effect.provide(ChangesRpc(fake)));
    },
  );

  it("fingerprints equal bodies equally whatever their key order, and different bodies differently", async () => {
    const a = await fingerprintOf({
      goal: "x",
      footprint: [{ path: "a", op: "edit" }],
      premises: [],
    });
    const b = await fingerprintOf({
      premises: [],
      footprint: [{ op: "edit", path: "a" }],
      goal: "x",
    });
    const c = await fingerprintOf({
      goal: "y",
      footprint: [{ path: "a", op: "edit" }],
      premises: [],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it.effect("brings each tagged refusal back as the same tagged error", () => {
    const conflict = objects({
      reserve: Exit.fail(new IdempotencyConflict({ idempotencyKey: "declare-0001" })),
    });
    const exhausted = objects({ declare: Exit.fail(new PoolExhausted({ retryAfterMs: 2_000 })) });
    const stale = objects({ submit: Exit.fail(new LeaseStale({ changeId, leaseId: lease })) });
    const submit = {
      changeId,
      lease,
      commitSha: Schema.decodeUnknownSync(CommitSha)("a".repeat(40)),
      idempotencyKey: "submit-1",
    };
    return Effect.gen(function* () {
      const errors = [
        yield* Effect.flip(
          Changes.use((c) => c.declare(principal, input)).pipe(
            Effect.provide(ChangesRpc(conflict.fake)),
          ),
        ),
        yield* Effect.flip(
          Changes.use((c) => c.declare(principal, input)).pipe(
            Effect.provide(ChangesRpc(exhausted.fake)),
          ),
        ),
        yield* Effect.flip(
          Changes.use((c) => c.submit(principal, submit)).pipe(
            Effect.provide(ChangesRpc(stale.fake)),
          ),
        ),
      ];
      expect(errors).toEqual([
        new IdempotencyConflict({ idempotencyKey: "declare-0001" }),
        new PoolExhausted({ retryAfterMs: 2_000 }),
        new LeaseStale({ changeId, leaseId: lease }),
      ]);
      expect(stale.sent.submit).toEqual([
        {
          name: changeId,
          command: {
            agentId,
            projectId: principal.projectId,
            leaseId: lease,
            commitSha: "a".repeat(40),
            idempotencyKey: "submit-1",
          },
        },
      ]);
      expect(exhausted.sent.declare).toHaveLength(1);
    });
  });

  it.effect("brings a declare refused for the change's state back as the same refusal", () => {
    const refusal = new ChangeStateRefused({ changeId, state: "withdrawn", command: "Declare" });
    const { fake } = objects({ declare: Exit.fail(refusal) });
    return Effect.gen(function* () {
      expect(yield* Effect.flip((yield* Changes).declare(principal, input))).toEqual(refusal);
    }).pipe(Effect.provide(ChangesRpc(fake)));
  });

  it.effect("rebuilds a NotImplemented defect, so the doorway still answers 503", () => {
    const { fake } = objects({});
    return Effect.gen(function* () {
      const exit = yield* Effect.exit((yield* Changes).get(changeId));
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(defect).toBeInstanceOf(NotImplemented);
      expect(defect).toMatchObject({ useCase: "coordination/getChange" });
    }).pipe(Effect.provide(ChangesRpc(fake)));
  });

  it.effect("asks the change's DO to wait in milliseconds", () => {
    const { fake, sent } = objects({});
    return Effect.gen(function* () {
      const status = yield* (yield* Changes).awaitSubmission(changeId, 7);
      expect(status).toEqual({ change, commitSha: null });
      expect(sent.waits).toEqual([7_000]);
    }).pipe(Effect.provide(ChangesRpc(fake)));
  });

  it.effect(
    "[rpc.held-submission] a wait on a submission whose object restarts under it is read again with no wait, and answers the change as it stands",
    () => {
      const { fake, sent } = objects({});
      let restarts = 1;
      const restarting: ChangeObjects = {
        ...fake,
        change: (id) => {
          const stub = fake.change(id);
          return {
            ...stub,
            submission: async (waitMs) => {
              if (restarts === 0) return stub.submission(waitMs);
              restarts -= 1;
              sent.waits.push(waitMs);
              throw new Error("Durable Object reset because its code was updated.");
            },
          };
        },
      };
      return Effect.gen(function* () {
        const status = yield* (yield* Changes).awaitSubmission(changeId, 7);
        expect(status).toEqual({ change, commitSha: null });
        expect(sent.waits).toEqual([7_000, 0]);
      }).pipe(Effect.provide(ChangesRpc(restarting)));
    },
  );

  it.effect("[changes.workspace] reads a change's workspace from its own DO", () => {
    const { fake, sent } = objects({});
    return Effect.gen(function* () {
      expect(yield* (yield* Changes).workspace(changeId)).toEqual(granted);
      expect(sent.workspaces).toEqual([changeId]);
    }).pipe(Effect.provide(ChangesRpc(fake)));
  });
});

describe("Inbox over Durable Object RPC", () => {
  it.effect(
    "treats an authenticated agent its AgentSession does not know as a defect, never an empty inbox",
    () => {
      const { fake } = objects({});
      return Effect.gen(function* () {
        const exit = yield* Effect.exit((yield* Inbox).read(agentId, undefined, 0));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }).pipe(Effect.provide(InboxRpc(fake.agentSession)));
    },
  );
});
