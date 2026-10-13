import type { AgentId, ChangeId } from "@keeltown/core/kernel";
import { Changes, PackTooLarge } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AbandonCommand,
  AdoptCommand,
  NearbyCommand,
  RebaseCommand,
  RelyCommand,
  ReviseCommand,
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
  nearby(command: typeof NearbyCommand.Encoded): Promise<unknown>;
  submit(command: typeof SubmitCommand.Encoded): Promise<unknown>;
  adopt(command: typeof AdoptCommand.Encoded): Promise<unknown>;
  rebase(command: typeof RebaseCommand.Encoded): Promise<unknown>;
  abandon(command: typeof AbandonCommand.Encoded): Promise<unknown>;
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
  describe(): Promise<unknown>;
}

export interface ChangeObjects {
  readonly change: (changeId: ChangeId) => ChangeStub;
  readonly agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "reserveChange" | "inbox">;
}

const encodeDeclare = Schema.encodeSync(DeclareCommand);
const encodeSubmit = Schema.encodeSync(SubmitCommand);
const encodeAdopt = Schema.encodeSync(AdoptCommand);
const encodeRebase = Schema.encodeSync(RebaseCommand);
const encodeRevise = Schema.encodeSync(ReviseCommand);
const encodeRely = Schema.encodeSync(RelyCommand);
const encodeNearby = Schema.encodeSync(NearbyCommand);
const encodeAbandon = Schema.encodeSync(AbandonCommand);

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
          const { idempotencyKey, fromSketch, ...intent } = input;
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ ...intent, sketchId: fromSketch }),
          );
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
            ...(fromSketch === undefined ? {} : { sketchId: fromSketch }),
            idempotencyKey,
            fingerprint,
          });
          const declared = yield* callObject(ChangeCodecs.declare, () =>
            objects.change(changeId).declare(command),
          ).pipe(
            // The id is fresh for this key, and a retry replays its first answer by cause, so a
            // declare refused for the change's state means the reservation and the DO disagree.
            Effect.catchTag("ChangeStateRefused", (refused) =>
              Effect.die(
                new Error(
                  `Change ${refused.changeId}, reserved for this key, refused its declare in state ${refused.state}`,
                ),
              ),
            ),
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
      revise: (principal, input) =>
        callObject(ChangeCodecs.revise, () =>
          objects.change(input.changeId).revise(
            encodeRevise({
              agentId: principal.agentId,
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
              ...(principal.run === undefined ? {} : { run: principal.run }),
              leaseId: input.lease,
              premise: input.premise,
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
