// A proposal on its Change DO, in memory: proposed from a fork's commit, which
// is copied into a pool workspace and admitted against the upstream's repo
// bytes; read by Precheck and parked for approval as it is queued; approved
// at the commit it carries, or asked for changes; moved to another commit by
// its proposer; closed. A ruling on how Keel verifies it is asked separately:
// heard before the approval it is kept or sends the proposal back, and after
// it the proposal waits for it.
import { describe, expect, it } from "@effect/vitest";
import {
  approveProposal,
  changeWorkspace,
  closeProposal,
  decisionIdOf,
  FLOW_RULING_APPROVE,
  flowRulingIdOf,
  getChange,
  planCompiled,
  precheckStarted,
  propose,
  type ProposeChange,
  reactToBatch,
  requestProposalChanges,
  updateProposal,
} from "@keeltown/core/application/coordination";
import {
  ChangeId,
  type CommitSha,
  ContentHash,
  type EntityRef,
  EscalationId,
  EventEnvelope,
  makeId,
  type NamespaceId,
  userActor,
} from "@keeltown/core/kernel";
import {
  Clock,
  CodeHost,
  EntityStore,
  EventOutbox,
  HumanGate,
  KEEL_PROPOSAL_REF,
  type WithdrawRequest,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeDecisionsMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeManualClock,
  makeNamespaceUsageMemory,
  makeProjectNamespacesMemory,
  makeWorkspacePoolMemory,
  makeWorkspaceRebaserMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { ChangeBounced } from "@keeltown/core/domain/coordination";
import { Effect, Exit, Layer, Schema } from "effect";
import { ulid } from "ulid";

const changeId = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const changeRef: EntityRef = { kind: "change", id: changeId };
const FORK = makeId("prj", "01JZ8PT2C4E6G8J0M2N4Q6F0RK");
const NAMESPACE: NamespaceId = makeId("org", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
/** The namespace of the project proposed to, where its questions are put. */
const UPSTREAM_NAMESPACE: NamespaceId = makeId("org", "01JZ8PT2C4E6G8J0M2N4Q6VP00");
const PROPOSER = userActor(makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V5"));
const MAINTAINER = userActor(makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V1"));
const UPSTREAM_TRUNK = { namespace: "memory", name: "upstream-trunk" };
const FORK_TRUNK = { namespace: "memory", name: "fork-trunk" };
/** The workspace the memory pool grants first, by its id. */
const WORKSPACE = { namespace: "memory", name: makeId("wsp", "1".padStart(26, "0")) };
const MAIN = "refs/heads/main";

/**
 * One proposal's Change DO, in memory: upstream's trunk with the commit the
 * fork was taken at and a later one the pool grants at, the fork with a
 * commit of its own on the first, and the workspace the pool will grant,
 * forked from upstream's trunk. `quota` caps the repo bytes of the fork's namespace.
 */
function proposalObject(options: { readonly quota?: number } = {}) {
  const clock = makeManualClock();
  const code = makeCodeHostMemory();
  const usage = makeNamespaceUsageMemory({
    clock,
    ...(options.quota === undefined
      ? {}
      : { quotas: { defaults: { "repo-bytes": options.quota } } }),
  });
  const seeded = Effect.gen(function* () {
    const host = yield* CodeHost;
    const fixture = yield* CodeHostFixture;
    yield* host.create(UPSTREAM_TRUNK);
    const base = yield* fixture.commit(UPSTREAM_TRUNK, MAIN, { "README.md": "upstream\n" });
    yield* host.fork(UPSTREAM_TRUNK, FORK_TRUNK);
    const proposed = yield* fixture.commit(FORK_TRUNK, MAIN, {
      "README.md": "upstream\n",
      "retry.ts": "export const retry = 1;\n",
    });
    const granted = yield* fixture.commit(UPSTREAM_TRUNK, MAIN, {
      "README.md": "upstream, later\n",
    });
    yield* host.fork(UPSTREAM_TRUNK, WORKSPACE);
    return { base, proposed, granted };
  }).pipe(Effect.provide(code.layer));
  const layerWith = (granted: CommitSha) => {
    const workspaces = makeWorkspacePoolMemory({ baseSha: granted });
    // Every question a proposal's object takes back, as the namespace's object is asked to.
    const withdrawn: WithdrawRequest[] = [];
    const places = makeProjectNamespacesMemory();
    places.places.set(sampleProjectId, {
      projectId: sampleProjectId,
      namespace: UPSTREAM_NAMESPACE,
      name: "upstream",
    });
    return {
      workspaces,
      withdrawn,
      layer: Layer.mergeAll(
        Layer.succeed(
          HumanGate,
          HumanGate.of({
            raise: () => Effect.die(new Error("a proposal's object raises no question")),
            withdraw: (request) => Effect.sync(() => void withdrawn.push(request)),
          }),
        ),
        places.layer,
        makeEventOutboxMemory().layer,
        makeIdsMemory().layer,
        clock.layer,
        workspaces.layer,
        code.layer,
        makeWorkspaceRebaserMemory(code).layer,
        usage.layer,
        makeLiveChangesMemory().layer,
        makeDecisionsMemory().layer,
      ),
    };
  };
  return { seeded, layerWith, code };
}

const proposing = (
  commit: CommitSha,
  base: CommitSha,
  over: Partial<ProposeChange> = {},
): ProposeChange => ({
  changeId,
  projectId: sampleProjectId,
  fork: { projectId: FORK, trunk: FORK_TRUNK },
  proposer: PROPOSER,
  commit,
  base,
  namespace: NAMESPACE,
  goal: "Retry a refused push once",
  idempotencyKey: "propose-1",
  fingerprint: "body-1",
  ...over,
});

const compiling = (instanceId: string, needsRuling = false) => ({
  revision: 1,
  instanceId,
  planHash: Schema.decodeUnknownSync(ContentHash)(`sha256:${"0".repeat(64)}`),
  steps: needsRuling ? 2 : 1,
  costEstimate: 1,
  ...(needsRuling ? { needsRuling: true as const, ruledPaths: ["package.json"] } : {}),
});

/** An event another object committed about the change, as its outbox delivers it. */
const arriving = (entity: EntityRef, payload: Record<string, unknown>) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: payload["_tag"],
    entity,
    seq: 1,
    at: 0,
    dedupeKey: `${entity.kind}:${entity.id}/cause-${ulid()}/${String(payload["_tag"])}#1`,
    affected: [changeRef],
    notified: [`change:${changeId}`],
    payload,
  });

const ruledOn = (escalationId: string, option: string) =>
  arriving(
    { kind: "escalation", id: escalationId },
    {
      _tag: "DecisionRecorded",
      decisionId: decisionIdOf(Schema.decodeUnknownSync(EscalationId)(escalationId)),
      escalationId,
      option,
      summary: option === FLOW_RULING_APPROVE ? "Approve and verify" : "Send it back",
      evidence: [],
      alternatives: [],
    },
  );

/** Receives `event` as the Change DO does: recorded, reacted to and the reaction's events appended, in one transaction. */
const receive = (event: EventEnvelope) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const at = yield* (yield* Clock).now;
    return store.transaction(() => {
      if (!outbox.receive(event.dedupeKey, at)) return undefined;
      const reaction = reactToBatch(changeId, event, { store, outbox, at });
      if (reaction !== undefined && reaction.drafts.length > 0)
        outbox.append(
          {
            entity: changeRef,
            cause: event.dedupeKey,
            causation: event.eventId,
            ...(reaction.project === undefined ? {} : { project: reaction.project }),
          },
          at,
          reaction.drafts,
        );
      return reaction;
    });
  });

const tagsOf = (log: readonly { readonly type: string }[]) => log.map((e) => e.type);

describe("a proposal on its Change DO", () => {
  it.effect(
    "[change.proposal-flow-at] a proposal's workspace has Precheck read its checks at the upstream head it was granted at, never at its base, where its fork last met the upstream",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        return yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          const held = yield* changeWorkspace(changeId);
          expect([held.baseSha, held.flowAt]).toEqual([base, granted]);
          expect(granted).not.toBe(base);
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-parks] a proposal copies the fork's commit into its workspace, admitted against the fork's namespace's repo bytes, submits it on the fork point, and parks for approval once Precheck's plan queues it, nothing else waiting",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        return yield* Effect.gen(function* () {
          const submitted = yield* propose(changeId, proposing(proposed, base));
          expect(submitted).toMatchObject({
            state: "submitted",
            origin: "proposal",
            proposal: { fork: FORK, proposer: PROPOSER },
            baseSha: base,
            commitSha: proposed,
          });
          expect(submitted.agentId).toBeUndefined();
          expect(submitted.lease).toBeUndefined();
          expect(submitted.intent.footprint).toEqual([{ path: "retry.ts", op: "create" }]);
          const held = yield* changeWorkspace(changeId);
          expect(held).toMatchObject({ repo: WORKSPACE, grantedSha: granted, baseSha: base });
          expect(yield* (yield* CodeHost).head(WORKSPACE, KEEL_PROPOSAL_REF)).toBe(proposed);
          expect(tagsOf((yield* EventOutbox).log(changeRef))).toEqual([
            "IntentDeclared",
            "PreflightIssued",
            "ChangeProposed",
            "ChangeStarted",
            "ChangeSubmitted",
          ]);

          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          const parked = yield* planCompiled(changeId, compiling("precheck-1"));
          expect(parked).toMatchObject({
            state: "parked",
            parkReason: "awaiting-approval",
            parkedFrom: "queued",
          });
          expect(tagsOf((yield* EventOutbox).log(changeRef)).slice(-3)).toEqual([
            "PlanCompiled",
            "ChangeQueued",
            "ChangeParked",
          ]);
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-retry] the same key and body answer the same change and copy nothing again; another body is an idempotency conflict; a refused admission gives the workspace back and makes no change",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer, workspaces } = object.layerWith(granted);
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          const before = (yield* EventOutbox).log(changeRef).length;
          const again = yield* propose(changeId, proposing(proposed, base));
          expect(again.state).toBe("submitted");
          expect((yield* EventOutbox).log(changeRef)).toHaveLength(before);
          const other = yield* Effect.exit(
            propose(changeId, proposing(proposed, base, { fingerprint: "body-2" })),
          );
          expect(Exit.isFailure(other) && JSON.stringify(other.cause)).toContain(
            "IdempotencyConflict",
          );
          expect(workspaces.released.size).toBe(0);
        }).pipe(Effect.provide(layer));

        const full = proposalObject({ quota: 1 });
        const seeded = yield* full.seeded;
        const tight = full.layerWith(seeded.granted);
        yield* Effect.gen(function* () {
          const refused = yield* Effect.flip(
            propose(changeId, proposing(seeded.proposed, seeded.base)),
          );
          expect(refused).toMatchObject({ _tag: "QuotaExceeded", kind: "repo-bytes" });
          expect([...tight.workspaces.released.values()]).toEqual(["withdrawn"]);
          expect(yield* Effect.flip(getChange(changeId))).toMatchObject({ _tag: "ChangeNotFound" });
        }).pipe(Effect.provide(tight.layer));
      });
    },
  );

  it.effect(
    "[change.proposal-approve] an approval of the commit it carries takes it back to the queue; one of another commit is refused naming the commit it carries; a request for changes leaves it waiting; its proposer closes it",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1"));
          const asked = yield* requestProposalChanges(changeId, {
            by: MAINTAINER,
            commit: proposed,
            comment: "Add a test for the retry",
            projectId: sampleProjectId,
            idempotencyKey: "ask-1",
          });
          expect(asked).toMatchObject({ state: "parked", parkReason: "awaiting-approval" });
          const moved = yield* Effect.flip(
            approveProposal(changeId, {
              by: MAINTAINER,
              commit: base,
              projectId: sampleProjectId,
              idempotencyKey: "approve-0",
            }),
          );
          expect(moved).toMatchObject({
            _tag: "ProposalCommitMoved",
            commit: base,
            current: proposed,
          });
          const approved = yield* approveProposal(changeId, {
            by: MAINTAINER,
            commit: proposed,
            projectId: sampleProjectId,
            idempotencyKey: "approve-1",
          });
          expect(approved).toMatchObject({ state: "queued", proposal: { approved: proposed } });
          expect(tagsOf((yield* EventOutbox).log(changeRef)).slice(-2)).toEqual([
            "ProposalChangesRequested",
            "ProposalApproved",
          ]);
          const closed = yield* closeProposal(changeId, {
            by: PROPOSER,
            projectId: sampleProjectId,
            reason: "Superseded by a better approach",
            idempotencyKey: "close-1",
          });
          expect(closed.state).toBe("withdrawn");
          expect((yield* EventOutbox).log(changeRef).at(-1)?.payload).toMatchObject({
            _tag: "ChangeWithdrawn",
            by: "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V5",
            reason: "Superseded by a better approach",
          });
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-lane-hears] the lane its plan queued it on hears the proposal approved and moved to another commit, as it hears it parked",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        const later = yield* Effect.flatMap(CodeHostFixture, (fixture) =>
          fixture.commit(FORK_TRUNK, MAIN, {
            "README.md": "upstream\n",
            "retry.ts": "export const retry = 2;\n",
          }),
        ).pipe(Effect.provide(object.code.layer));
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1"));
          yield* approveProposal(changeId, {
            by: MAINTAINER,
            commit: proposed,
            projectId: sampleProjectId,
            idempotencyKey: "approve-1",
          });
          yield* updateProposal(changeId, {
            proposer: PROPOSER,
            fork: { projectId: FORK, trunk: FORK_TRUNK },
            commit: later,
            base,
            namespace: NAMESPACE,
            projectId: sampleProjectId,
            idempotencyKey: "update-1",
          });
          const lane = `lane:${sampleProjectId}:main`;
          const heard = (yield* EventOutbox)
            .log(changeRef)
            .filter((event) => event.notified.includes(lane))
            .map((event) => event.type);
          expect(heard).toEqual(
            expect.arrayContaining(["ChangeParked", "ProposalApproved", "ProposalUpdated"]),
          );
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-update] its proposer moves it to another commit of the fork: copied over the one before, submitted again with no approval, and off the queue",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        const later = yield* Effect.flatMap(CodeHostFixture, (fixture) =>
          fixture.commit(FORK_TRUNK, MAIN, {
            "README.md": "upstream\n",
            "retry.ts": "export const retry = 2;\n",
          }),
        ).pipe(Effect.provide(object.code.layer));
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1"));
          yield* approveProposal(changeId, {
            by: MAINTAINER,
            commit: proposed,
            projectId: sampleProjectId,
            idempotencyKey: "approve-1",
          });
          const updated = yield* updateProposal(changeId, {
            proposer: PROPOSER,
            fork: { projectId: FORK, trunk: FORK_TRUNK },
            commit: later,
            base,
            note: "Retry twice, as asked",
            namespace: NAMESPACE,
            projectId: sampleProjectId,
            idempotencyKey: "update-1",
          });
          expect(updated).toMatchObject({ state: "submitted", commitSha: later, baseSha: base });
          expect(updated.proposal?.approved).toBeUndefined();
          expect(updated.laneId).toBeUndefined();
          expect(yield* (yield* CodeHost).head(WORKSPACE, KEEL_PROPOSAL_REF)).toBe(later);
          expect(tagsOf((yield* EventOutbox).log(changeRef)).slice(-2)).toEqual([
            "ProposalUpdated",
            "ChangeSubmitted",
          ]);
          const replayed = yield* updateProposal(changeId, {
            proposer: PROPOSER,
            fork: { projectId: FORK, trunk: FORK_TRUNK },
            commit: later,
            base,
            note: "Retry twice, as asked",
            namespace: NAMESPACE,
            projectId: sampleProjectId,
            idempotencyKey: "update-1",
          });
          expect(replayed.commitSha).toBe(later);
          const elsewhere = yield* Effect.flip(
            updateProposal(changeId, {
              proposer: PROPOSER,
              fork: { projectId: makeId("prj", "01JZ8PT2C4E6G8J0M2N4Q6S8V9"), trunk: FORK_TRUNK },
              commit: later,
              base,
              namespace: NAMESPACE,
              projectId: sampleProjectId,
              idempotencyKey: "update-2",
            }),
          );
          expect(elsewhere).toMatchObject({ _tag: "ChangeNotFound" });
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-flow-ruled-first] a ruling on how Keel verifies it, heard while it waits for approval, moves nothing when it approves, and the approval then queues it; a refusal heard first sends it back to its proposer",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const kept = object.layerWith(granted);
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          const parked = yield* planCompiled(changeId, compiling("precheck-1", true));
          expect(parked).toMatchObject({ state: "parked", parkReason: "awaiting-approval" });
          const before = (yield* EventOutbox).log(changeRef).length;
          yield* receive(ruledOn(flowRulingIdOf(changeId, "precheck-1"), FLOW_RULING_APPROVE));
          expect((yield* EventOutbox).log(changeRef)).toHaveLength(before);
          const approved = yield* approveProposal(changeId, {
            by: MAINTAINER,
            commit: proposed,
            projectId: sampleProjectId,
            idempotencyKey: "approve-1",
          });
          expect(approved.state).toBe("queued");
        }).pipe(Effect.provide(kept.layer));

        const again = proposalObject();
        const seeded = yield* again.seeded;
        const sent = again.layerWith(seeded.granted);
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(seeded.proposed, seeded.base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1", true));
          yield* receive(ruledOn(flowRulingIdOf(changeId, "precheck-1"), "refuse"));
          const bounced = yield* getChange(changeId);
          expect(bounced.state).toBe("bounced");
          const event = Schema.decodeUnknownSync(ChangeBounced)(
            (yield* EventOutbox).log(changeRef).at(-1)?.payload,
          );
          expect(event.nextActions?.map((n) => n.operationId)).toEqual([
            "updateProposal",
            "closeProposal",
          ]);
        }).pipe(Effect.provide(sent.layer));
      });
    },
  );

  it.effect(
    "[change.proposal-question-withdrawn] a question on how Keel verifies a proposal is taken back once nothing is left to rule on it: when its proposer moves it to another commit, and when it is closed",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer, withdrawn } = object.layerWith(granted);
        const later = yield* Effect.flatMap(CodeHostFixture, (fixture) =>
          fixture.commit(FORK_TRUNK, MAIN, {
            "README.md": "upstream\n",
            "retry.ts": "export const retry = 2;\n",
          }),
        ).pipe(Effect.provide(object.code.layer));
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1", true));
          yield* updateProposal(changeId, {
            proposer: PROPOSER,
            fork: { projectId: FORK, trunk: FORK_TRUNK },
            commit: later,
            base,
            namespace: NAMESPACE,
            projectId: sampleProjectId,
            idempotencyKey: "update-1",
          });
          expect(withdrawn.map((w) => [w.namespace, w.escalationId])).toEqual([
            [UPSTREAM_NAMESPACE, flowRulingIdOf(changeId, "precheck-1")],
          ]);
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-2" });
          yield* planCompiled(changeId, compiling("precheck-2", true));
          yield* closeProposal(changeId, {
            by: PROPOSER,
            projectId: sampleProjectId,
            idempotencyKey: "close-1",
          });
          expect(withdrawn.map((w) => w.escalationId)).toEqual([
            flowRulingIdOf(changeId, "precheck-1"),
            flowRulingIdOf(changeId, "precheck-2"),
          ]);
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "[change.proposal-approve-asks] approved before anyone ruled on how Keel verifies it, a proposal waits for that ruling from the queue, and the ruling's approve takes it back",
    () => {
      const object = proposalObject();
      return Effect.gen(function* () {
        const { base, proposed, granted } = yield* object.seeded;
        const { layer } = object.layerWith(granted);
        yield* Effect.gen(function* () {
          yield* propose(changeId, proposing(proposed, base));
          yield* precheckStarted(changeId, { revision: 1, instanceId: "precheck-1" });
          yield* planCompiled(changeId, compiling("precheck-1", true));
          const waiting = yield* approveProposal(changeId, {
            by: MAINTAINER,
            commit: proposed,
            projectId: sampleProjectId,
            idempotencyKey: "approve-1",
          });
          expect(waiting).toMatchObject({
            state: "parked",
            parkReason: "awaiting-ruling",
            escalationId: flowRulingIdOf(changeId, "precheck-1"),
            proposal: { approved: proposed },
          });
          yield* receive(ruledOn(flowRulingIdOf(changeId, "precheck-1"), FLOW_RULING_APPROVE));
          expect((yield* getChange(changeId)).state).toBe("queued");
        }).pipe(Effect.provide(layer));
      });
    },
  );
});
