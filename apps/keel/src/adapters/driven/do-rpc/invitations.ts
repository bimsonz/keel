import { namespaceAddress } from "@keeltown/core/application/coordination";
import { eventActorOf } from "@keeltown/core/domain/identity";
import { Invitations } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AcceptInvitationCommand,
  EndInvitationCommand,
  InviteAgentCommand,
  NamespaceCodecs,
} from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The namespace object's methods `Invitations` calls (`ns:<id>`), answering Exit envelopes. */
export interface InvitationsStub {
  inviteAgent(command: typeof InviteAgentCommand.Encoded): Promise<unknown>;
  acceptInvitation(command: typeof AcceptInvitationCommand.Encoded): Promise<unknown>;
  endInvitation(command: typeof EndInvitationCommand.Encoded): Promise<unknown>;
}

const encodeInvite = Schema.encodeSync(InviteAgentCommand);
const encodeAccept = Schema.encodeSync(AcceptInvitationCommand);
const encodeEnd = Schema.encodeSync(EndInvitationCommand);

/**
 * `Invitations` over each namespace's object, addressed by name: the
 * namespace picks the object and never crosses. The fingerprint hashes who
 * moves and what they asked, so a retry is told apart from a reused key.
 */
export function InvitationsRpc(
  namespace: (address: string) => InvitationsStub,
): Layer.Layer<Invitations> {
  return Layer.succeed(
    Invitations,
    Invitations.of({
      invite: (invitation) =>
        Effect.gen(function* () {
          const { agentId, by, scopes, idempotencyKey } = invitation;
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ invite: agentId, by, scopes: scopes.toSorted() }),
          );
          return yield* callObject(NamespaceCodecs.inviteAgent, () =>
            namespace(namespaceAddress(invitation.namespace)).inviteAgent(
              encodeInvite({ agentId, by, scopes, idempotencyKey, fingerprint }),
            ),
          );
        }),
      accept: (answer) =>
        Effect.gen(function* () {
          const { agentId, run, idempotencyKey } = answer;
          const fingerprint = yield* Effect.promise(() => fingerprintOf({ accept: agentId }));
          return yield* callObject(NamespaceCodecs.acceptInvitation, () =>
            namespace(namespaceAddress(answer.namespace)).acceptInvitation(
              encodeAccept({
                agentId,
                ...(run === undefined ? {} : { run }),
                idempotencyKey,
                fingerprint,
              }),
            ),
          );
        }),
      end: (actor, ending) =>
        Effect.gen(function* () {
          const { agentId, run, idempotencyKey } = ending;
          const by = eventActorOf(actor);
          const fingerprint = yield* Effect.promise(() => fingerprintOf({ end: agentId, by }));
          return yield* callObject(NamespaceCodecs.endInvitation, () =>
            namespace(namespaceAddress(ending.namespace)).endInvitation(
              encodeEnd({
                agentId,
                by,
                ...(run === undefined ? {} : { run }),
                idempotencyKey,
                fingerprint,
              }),
            ),
          );
        }),
    }),
  );
}
