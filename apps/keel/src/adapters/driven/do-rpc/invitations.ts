import { namespaceAddress } from "@keeltown/core/application/coordination";
import { eventActorOf } from "@keeltown/core/domain/identity";
import type { ProjectId } from "@keeltown/core/kernel";
import { Invitations } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AcceptInvitationCommand,
  AcceptProjectInvitationCommand,
  EndInvitationCommand,
  EndProjectInvitationCommand,
  InviteAgentCommand,
  InviteToProjectCommand,
  NamespaceCodecs,
  ProjectCodecs,
} from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The namespace object's methods `Invitations` calls (`ns:<id>`), answering Exit envelopes. */
export interface InvitationsStub {
  inviteAgent(command: typeof InviteAgentCommand.Encoded): Promise<unknown>;
  acceptInvitation(command: typeof AcceptInvitationCommand.Encoded): Promise<unknown>;
  endInvitation(command: typeof EndInvitationCommand.Encoded): Promise<unknown>;
}

/** The Project DO's methods `Invitations` calls for an invitation to one project (`project:<id>`). */
export interface ProjectInvitationsStub {
  inviteAgent(command: typeof InviteToProjectCommand.Encoded): Promise<unknown>;
  acceptInvitation(command: typeof AcceptProjectInvitationCommand.Encoded): Promise<unknown>;
  endInvitation(command: typeof EndProjectInvitationCommand.Encoded): Promise<unknown>;
}

const encodeInvite = Schema.encodeSync(InviteAgentCommand);
const encodeAccept = Schema.encodeSync(AcceptInvitationCommand);
const encodeEnd = Schema.encodeSync(EndInvitationCommand);
const encodeInviteTo = Schema.encodeSync(InviteToProjectCommand);
const encodeAcceptTo = Schema.encodeSync(AcceptProjectInvitationCommand);
const encodeEndTo = Schema.encodeSync(EndProjectInvitationCommand);

/**
 * `Invitations` over the object that holds each record, addressed by name: a
 * namespace's own object for an invitation into it, the project's own for one
 * to that project alone. The place picks the object and never crosses. The
 * fingerprint hashes who moves and what they asked, so a retry is told apart
 * from a reused key.
 */
export function InvitationsRpc(
  namespace: (address: string) => InvitationsStub,
  project: (projectId: ProjectId) => ProjectInvitationsStub,
): Layer.Layer<Invitations> {
  return Layer.succeed(
    Invitations,
    Invitations.of({
      invite: (invitation) =>
        Effect.gen(function* () {
          const { agentId, by, scopes, idempotencyKey, projectId } = invitation;
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ invite: agentId, by, scopes: scopes.toSorted() }),
          );
          const asked = { agentId, by, scopes, idempotencyKey, fingerprint };
          return projectId === undefined
            ? yield* callObject(NamespaceCodecs.inviteAgent, () =>
                namespace(namespaceAddress(invitation.namespace)).inviteAgent(encodeInvite(asked)),
              )
            : yield* callObject(ProjectCodecs.inviteAgent, () =>
                project(projectId).inviteAgent(
                  encodeInviteTo({ ...asked, namespace: invitation.namespace }),
                ),
              );
        }),
      accept: (answer) =>
        Effect.gen(function* () {
          const { agentId, run, idempotencyKey, projectId } = answer;
          const fingerprint = yield* Effect.promise(() => fingerprintOf({ accept: agentId }));
          const asked = {
            agentId,
            ...(run === undefined ? {} : { run }),
            idempotencyKey,
            fingerprint,
          };
          return projectId === undefined
            ? yield* callObject(NamespaceCodecs.acceptInvitation, () =>
                namespace(namespaceAddress(answer.namespace)).acceptInvitation(encodeAccept(asked)),
              )
            : yield* callObject(ProjectCodecs.acceptInvitation, () =>
                project(projectId).acceptInvitation(
                  encodeAcceptTo({ ...asked, namespace: answer.namespace }),
                ),
              );
        }),
      end: (actor, ending) =>
        Effect.gen(function* () {
          const { agentId, run, idempotencyKey, projectId } = ending;
          const by = eventActorOf(actor);
          const fingerprint = yield* Effect.promise(() => fingerprintOf({ end: agentId, by }));
          const asked = {
            agentId,
            by,
            ...(run === undefined ? {} : { run }),
            idempotencyKey,
            fingerprint,
          };
          return projectId === undefined
            ? yield* callObject(NamespaceCodecs.endInvitation, () =>
                namespace(namespaceAddress(ending.namespace)).endInvitation(encodeEnd(asked)),
              )
            : yield* callObject(ProjectCodecs.endInvitation, () =>
                project(projectId).endInvitation(
                  encodeEndTo({ ...asked, namespace: ending.namespace }),
                ),
              );
        }),
    }),
  );
}
