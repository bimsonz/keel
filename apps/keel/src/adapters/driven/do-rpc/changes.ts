import type { AgentId, ChangeId } from "@keeltown/core/kernel";
import { Changes } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AdoptCommand,
  AgentSessionCodecs,
  ChangeCodecs,
  DeclareCommand,
  type EnrolCommand,
  type InboxRead,
  type ReserveChange,
  type TakeNotices,
  SubmitCommand,
} from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The Change DO methods the isolate calls (`change:<id>`), answering Exit envelopes. */
export interface ChangeStub {
  declare(command: typeof DeclareCommand.Encoded): Promise<unknown>;
  submit(command: typeof SubmitCommand.Encoded): Promise<unknown>;
  adopt(command: typeof AdoptCommand.Encoded): Promise<unknown>;
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
}

export interface ChangeObjects {
  readonly change: (changeId: ChangeId) => ChangeStub;
  readonly agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "reserveChange" | "inbox">;
}

const encodeDeclare = Schema.encodeSync(DeclareCommand);
const encodeSubmit = Schema.encodeSync(SubmitCommand);
const encodeAdopt = Schema.encodeSync(AdoptCommand);

/**
 * `Changes` over Durable Object RPC. A declare first asks the agent's
 * AgentSession for the change id its Idempotency-Key reserves (minted on first
 * use, kept 24 h, refused for another body), then declares on that change's
 * own DO, which takes the workspace and decides. Every other call goes
 * straight to the change's DO, which authorises the lease.
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
              projectId: principal.projectId,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ).pipe(
          Effect.map(({ change, grant }) =>
            grant === undefined ? { change } : { change, workspace: grant },
          ),
        ),
      get: (changeId) => callObject(ChangeCodecs.get, () => objects.change(changeId).get()),
      workspace: (changeId) =>
        callObject(ChangeCodecs.workspace, () => objects.change(changeId).workspace()),
      awaitSubmission: (changeId, waitSeconds) =>
        callObject(ChangeCodecs.submission, () =>
          objects.change(changeId).submission(waitSeconds * 1000),
        ),
    }),
  );
}
