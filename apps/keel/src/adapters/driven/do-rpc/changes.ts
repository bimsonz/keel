import { CommitParentRefused } from "@keeltown/core/application/coordination";
import type { AgentId, ChangeId } from "@keeltown/core/kernel";
import {
  Changes,
  EditsRefused,
  ObjectNotFound,
  PackTooLarge,
  WorkspaceHeadMoved,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AbandonCommand,
  AdoptCommand,
  ApproveProposalCommand,
  CloseProposalCommand,
  CommitCommand,
  type DescribeSession,
  NearbyCommand,
  RebaseCommand,
  RefreshCommand,
  RelyCommand,
  DistinguishCommand,
  ProposeCommand,
  RequestProposalChangesCommand,
  ReviseCommand,
  UpdateProposalCommand,
  AgentSessionCodecs,
  ChangeCodecs,
  DeclareCommand,
  type EnrolCommand,
  type SignUpCommand,
  type InboxRead,
  type OpenSession,
  type ReserveChange,
  type TakeNotices,
  SubmitCommand,
} from "../../../rpc/index.ts";
import { callHeldRead, callObject, fingerprintOf } from "./answer.ts";

/** The Change DO methods the isolate calls (`change:<id>`), answering Exit envelopes. */
export interface ChangeStub {
  declare(command: typeof DeclareCommand.Encoded): Promise<unknown>;
  revise(command: typeof ReviseCommand.Encoded): Promise<unknown>;
  rely(command: typeof RelyCommand.Encoded): Promise<unknown>;
  distinguish(command: typeof DistinguishCommand.Encoded): Promise<unknown>;
  nearby(command: typeof NearbyCommand.Encoded): Promise<unknown>;
  submit(command: typeof SubmitCommand.Encoded): Promise<unknown>;
  adopt(command: typeof AdoptCommand.Encoded): Promise<unknown>;
  rebase(command: typeof RebaseCommand.Encoded): Promise<unknown>;
  commit(command: typeof CommitCommand.Encoded): Promise<unknown>;
  refreshWorkspace(command: typeof RefreshCommand.Encoded): Promise<unknown>;
  abandon(command: typeof AbandonCommand.Encoded): Promise<unknown>;
  propose(command: typeof ProposeCommand.Encoded): Promise<unknown>;
  updateProposal(command: typeof UpdateProposalCommand.Encoded): Promise<unknown>;
  approveProposal(command: typeof ApproveProposalCommand.Encoded): Promise<unknown>;
  requestProposalChanges(command: typeof RequestProposalChangesCommand.Encoded): Promise<unknown>;
  closeProposal(command: typeof CloseProposalCommand.Encoded): Promise<unknown>;
  get(): Promise<unknown>;
  submission(waitMs: number): Promise<unknown>;
  workspace(): Promise<unknown>;
}

/** The AgentSession DO methods the isolate calls (`agent:<id>`), answering Exit envelopes. */
export interface AgentSessionStub {
  reserveChange(request: typeof ReserveChange.Encoded): Promise<unknown>;
  inbox(request: typeof InboxRead.Encoded): Promise<unknown>;
  takeNotices(request: typeof TakeNotices.Encoded): Promise<unknown>;
  enrol(command: typeof EnrolCommand.Encoded): Promise<unknown>;
  signUp(command: typeof SignUpCommand.Encoded): Promise<unknown>;
  openSession(command: typeof OpenSession.Encoded): Promise<unknown>;
  describe(request?: typeof DescribeSession.Encoded): Promise<unknown>;
}

export interface ChangeObjects {
  readonly change: (changeId: ChangeId) => ChangeStub;
  readonly agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "reserveChange" | "inbox">;
}

const encodeDeclare = Schema.encodeSync(DeclareCommand);
const encodeSubmit = Schema.encodeSync(SubmitCommand);
const encodeAdopt = Schema.encodeSync(AdoptCommand);
const encodeRebase = Schema.encodeSync(RebaseCommand);
const encodeCommit = Schema.encodeSync(CommitCommand);
const encodeRefresh = Schema.encodeSync(RefreshCommand);
const encodeRevise = Schema.encodeSync(ReviseCommand);
const encodeRely = Schema.encodeSync(RelyCommand);
const encodeDistinguish = Schema.encodeSync(DistinguishCommand);
const encodeNearby = Schema.encodeSync(NearbyCommand);
const encodeAbandon = Schema.encodeSync(AbandonCommand);
const encodePropose = Schema.encodeSync(ProposeCommand);
const encodeUpdateProposal = Schema.encodeSync(UpdateProposalCommand);
const encodeApprove = Schema.encodeSync(ApproveProposalCommand);
const encodeRequestChanges = Schema.encodeSync(RequestProposalChangesCommand);
const encodeClose = Schema.encodeSync(CloseProposalCommand);

/**
 * `Changes` over Durable Object RPC. A declare first asks the agent's
 * AgentSession for the change id its Idempotency-Key reserves (minted on first
 * use, kept 24 h, refused for another body), then declares on that change's
 * own DO, which takes the workspace and decides. Every other call goes
 * straight to the change's DO, which authorises the lease and confines a read
 * or a maintainer's withdrawal to the project it was authorised on.
 */
export function ChangesRpc(objects: ChangeObjects): Layer.Layer<Changes> {
  return Layer.succeed(
    Changes,
    Changes.of({
      declare: (principal, input) =>
        Effect.gen(function* () {
          const { idempotencyKey, ...intent } = input;
          const fingerprint = yield* Effect.promise(() => fingerprintOf(intent));
          const changeId = yield* callObject(AgentSessionCodecs.reserveChange, () =>
            objects.agentSession(principal.agentId).reserveChange({ idempotencyKey, fingerprint }),
          );
          const command = encodeDeclare({
            changeId,
            agentId: principal.agentId,
            ...(principal.run === undefined ? {} : { run: principal.run }),
            projectId: principal.projectId,
            origin: "agent",
            ...intent,
            idempotencyKey,
            fingerprint,
          });
          // A retry whose change has ended is refused for the change's state: it has no workspace.
          const declared = yield* callObject(ChangeCodecs.declare, () =>
            objects.change(changeId).declare(command),
          );
          return {
            change: declared.change,
            preflight: declared.preflight,
            workspace: declared.grant,
          };
        }),
      submit: (principal, input) =>
        callObject(ChangeCodecs.submit, () =>
          objects.change(input.changeId).submit(
            encodeSubmit({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              commitSha: input.commitSha,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      adopt: (principal, input) =>
        callObject(ChangeCodecs.adopt, () =>
          objects.change(input.changeId).adopt(
            encodeAdopt({
              agentId: principal.agentId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              projectId: principal.projectId,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ).pipe(
          Effect.map(({ change, grant }) =>
            grant === undefined ? { change } : { change, workspace: grant },
          ),
        ),
      rebase: (principal, input) =>
        callObject(ChangeCodecs.rebase, () =>
          objects.change(input.changeId).rebase(
            encodeRebase({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ).pipe(
          // The RPC carries PackTooLarge by shape (rule R15); the port's is its class.
          Effect.catchTag("PackTooLarge", (e) =>
            Effect.fail(new PackTooLarge({ repo: e.repo, bytes: e.bytes, limit: e.limit })),
          ),
        ),
      commit: (principal, input) =>
        callObject(ChangeCodecs.commit, () =>
          objects.change(input.changeId).commit(
            encodeCommit({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              ...(principal.handle === undefined ? {} : { handle: principal.handle }),
              leaseId: input.lease,
              expectedHead: input.expectedHead,
              ...(input.parent === undefined ? {} : { parent: input.parent }),
              edits: input.edits,
              message: input.message,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ).pipe(
          // The RPC carries the writer's errors by shape (rule R15); the port's are its classes.
          Effect.catchTags({
            PackTooLarge: (e) =>
              Effect.fail(new PackTooLarge({ repo: e.repo, bytes: e.bytes, limit: e.limit })),
            CommitParentRefused: (e) =>
              Effect.fail(
                new CommitParentRefused({
                  changeId: e.changeId,
                  parent: e.parent,
                  expectedHead: e.expectedHead,
                  ...(e.base === undefined ? {} : { base: e.base }),
                }),
              ),
            WorkspaceHeadMoved: (e) =>
              Effect.fail(new WorkspaceHeadMoved({ expected: e.expected, head: e.head })),
            EditsRefused: (e) => Effect.fail(new EditsRefused({ reason: e.reason, path: e.path })),
            ObjectNotFound: (e) => Effect.fail(new ObjectNotFound({ repo: e.repo, oid: e.oid })),
          }),
        ),
      refreshWorkspace: (principal, input) =>
        callObject(ChangeCodecs.refreshWorkspace, () =>
          objects.change(input.changeId).refreshWorkspace(
            encodeRefresh({
              agentId: principal.agentId,
              projectId: principal.projectId,
              leaseId: input.lease,
            }),
          ),
        ),
      revise: (principal, input) =>
        callObject(ChangeCodecs.revise, () =>
          objects.change(input.changeId).revise(
            encodeRevise({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              ifMatchRevision: input.ifMatchRevision,
              ...(input.goal === undefined ? {} : { goal: input.goal }),
              ...(input.footprint === undefined ? {} : { footprint: input.footprint }),
              premisesAdded: input.premisesAdded,
              premisesRetracted: input.premisesRetracted,
              ...(input.declaredEffects === undefined
                ? {}
                : { declaredEffects: input.declaredEffects }),
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      rely: (principal, input) =>
        callObject(ChangeCodecs.rely, () =>
          objects.change(input.changeId).rely(
            encodeRely({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              premise: input.premise,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      distinguish: (principal, input) =>
        callObject(ChangeCodecs.distinguish, () =>
          objects.change(input.changeId).distinguish(
            encodeDistinguish({
              agentId: principal.agentId,
              projectId: principal.projectId,
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              decisionId: input.decisionId,
              distinction: input.distinction,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      nearby: (projectId, changeId) =>
        callObject(ChangeCodecs.nearby, () =>
          objects.change(changeId).nearby(encodeNearby({ projectId })),
        ),
      abandon: (input) =>
        callObject(ChangeCodecs.abandon, () =>
          objects.change(input.changeId).abandon(
            encodeAbandon({
              authority: input.authority,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      propose: (changeId, input) =>
        callObject(ChangeCodecs.propose, () =>
          objects.change(changeId).propose(
            encodePropose({
              projectId: input.projectId,
              fork: input.fork,
              proposer: input.proposer,
              commit: input.commit,
              base: input.base,
              namespace: input.namespace,
              goal: input.goal,
              idempotencyKey: input.idempotencyKey,
              fingerprint: input.fingerprint,
            }),
          ),
        ).pipe(
          // The RPC carries PackTooLarge by shape (rule R15); the port's is its class.
          Effect.catchTag("PackTooLarge", (e) =>
            Effect.fail(new PackTooLarge({ repo: e.repo, bytes: e.bytes, limit: e.limit })),
          ),
        ),
      updateProposal: (changeId, input) =>
        callObject(ChangeCodecs.updateProposal, () =>
          objects.change(changeId).updateProposal(
            encodeUpdateProposal({
              proposer: input.proposer,
              projectId: input.projectId,
              fork: input.fork,
              commit: input.commit,
              base: input.base,
              ...(input.note === undefined ? {} : { note: input.note }),
              namespace: input.namespace,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ).pipe(
          // The RPC carries PackTooLarge by shape (rule R15); the port's is its class.
          Effect.catchTag("PackTooLarge", (e) =>
            Effect.fail(new PackTooLarge({ repo: e.repo, bytes: e.bytes, limit: e.limit })),
          ),
        ),
      approveProposal: (changeId, input) =>
        callObject(ChangeCodecs.approveProposal, () =>
          objects.change(changeId).approveProposal(encodeApprove(input)),
        ),
      requestProposalChanges: (changeId, input) =>
        callObject(ChangeCodecs.requestProposalChanges, () =>
          objects.change(changeId).requestProposalChanges(encodeRequestChanges(input)),
        ),
      closeProposal: (changeId, input) =>
        callObject(ChangeCodecs.closeProposal, () =>
          objects.change(changeId).closeProposal(
            encodeClose({
              by: input.by,
              projectId: input.projectId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      get: (changeId) => callObject(ChangeCodecs.get, () => objects.change(changeId).get()),
      workspace: (changeId) =>
        callObject(ChangeCodecs.workspace, () => objects.change(changeId).workspace()),
      // Held by the change's object, which may restart under it: read again as it stands.
      awaitSubmission: (changeId, waitSeconds) =>
        callHeldRead(ChangeCodecs.submission, "submission", waitSeconds * 1000, (waitMs) =>
          objects.change(changeId).submission(waitMs),
        ),
    }),
  );
}
