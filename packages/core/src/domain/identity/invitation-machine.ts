import { Result, Schema } from "effect";
import {
  type Actor,
  agentActor,
  AgentId,
  type Committed,
  IllegalTransition,
  InstantSchema,
  NamespaceId,
  userActor,
  UserId,
} from "../kernel/index.ts";
import type { Scope } from "./agent.ts";
import { InvitationRefused } from "./errors.ts";
import {
  AgentInvited,
  AgentJoinedNamespace,
  AgentLeftNamespace,
  InvitationScopes,
  type NamespaceAgentEvent,
} from "./events.ts";

/** What an invitation gives when the member who makes it says nothing else, and never more. */
export const INVITED_SCOPES: InvitationScopes = ["agent:read", "agent:work"];

/**
 * An agent's place in a namespace it does not govern: a member invited it, and
 * it stands there once it has accepted. `by` is the member who invited it and
 * answers for it there. An ended invitation is kept, so the namespace's record
 * says the agent was once there; the agent may be invited again.
 */
export const Invitation = Schema.Struct({
  namespace: NamespaceId,
  agentId: AgentId,
  by: UserId,
  scopes: InvitationScopes,
  state: Schema.Literals(["invited", "joined", "ended"]),
  invitedAt: InstantSchema,
  joinedAt: Schema.optional(InstantSchema),
});
export type Invitation = typeof Invitation.Type;

/** A command on one agent's place in one namespace. */
export type InvitationCommand =
  /** A member invites the agent. Whether `by` is a member is the policy's to decide, before this. */
  | { readonly _tag: "Invite"; readonly by: UserId; readonly scopes: InvitationScopes }
  /** The agent accepts: nobody else can, so the command names no one. */
  | { readonly _tag: "Accept" }
  /**
   * The invitation ends. `by` is the agent itself, or a person: the member
   * who invited it, or a maintainer of the namespace (the policy's to decide).
   */
  | { readonly _tag: "End"; readonly by: Actor };

/** Facts from I/O: the namespace whose record this is, and the agent the row is about. */
export interface InvitationFacts {
  readonly namespace: NamespaceId;
  readonly agentId: AgentId;
}

type Decision = Result.Result<readonly NamespaceAgentEvent[], InvitationRefused>;

const sameScopes = (a: readonly Scope[], b: readonly Scope[]): boolean =>
  a.length === b.length && a.every((scope) => b.includes(scope));

const standing = (
  invitation: Invitation | undefined,
): invitation is Invitation & { readonly state: "invited" | "joined" } =>
  invitation !== undefined && invitation.state !== "ended";

/**
 * Decides a command on an agent's place in a namespace
 * (docs/domain/state-machines.md § Invitation).
 *
 * One member answers for an agent in a namespace: while an invitation stands,
 * pending or accepted, the same member asking again for the same scopes
 * commits nothing, and anything else is refused until it has ended. Only an
 * invited agent can accept, and accepting again commits nothing.
 *
 * An end says why by who ends it and when: the agent declines an invitation
 * it has not accepted and leaves one it has; the member who made a pending
 * invitation withdraws it; any other end by a person removes the agent.
 */
export const decideInvitation = (
  invitation: Invitation | undefined,
  command: InvitationCommand,
  facts: InvitationFacts,
): Decision => {
  const { namespace, agentId } = facts;
  const refuse = (reason: InvitationRefused["reason"]): Decision =>
    Result.fail(
      new InvitationRefused({
        namespace,
        agentId,
        ...(invitation === undefined ? {} : { state: invitation.state }),
        command: command._tag,
        reason,
      }),
    );
  switch (command._tag) {
    case "Invite":
      if (!standing(invitation))
        return Result.succeed([
          AgentInvited.make({ namespace, agentId, by: command.by, scopes: command.scopes }),
        ]);
      return invitation.by === command.by && sameScopes(invitation.scopes, command.scopes)
        ? Result.succeed([])
        : refuse("already-invited");
    case "Accept":
      if (!standing(invitation)) return refuse("not-invited");
      return invitation.state === "joined"
        ? Result.succeed([])
        : Result.succeed([AgentJoinedNamespace.make({ namespace, agentId })]);
    case "End": {
      if (!standing(invitation)) return refuse("not-invited");
      const itself = command.by === agentActor(agentId);
      if (!itself && command.by.startsWith("agent:")) return refuse("not-a-party");
      const pending = invitation.state === "invited";
      const reason = itself
        ? pending
          ? "declined"
          : "left"
        : pending && command.by === userActor(invitation.by)
          ? "withdrawn"
          : "removed";
      return Result.succeed([
        AgentLeftNamespace.make({ namespace, agentId, by: command.by, reason }),
      ]);
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Invitation | undefined, event: NamespaceAgentEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to an agent ${state === undefined ? "never invited" : state.state}`,
  );
};

/** Folds one committed event into the invitation, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveInvitation = (
  state: Invitation | undefined,
  committed: Committed<NamespaceAgentEvent>,
): Invitation => {
  const event = committed.payload;
  if (state !== undefined && event.agentId !== state.agentId) return illegal(state, event);
  if (state !== undefined && event.namespace !== state.namespace) return illegal(state, event);
  switch (event._tag) {
    case "AgentInvited":
      return standing(state)
        ? illegal(state, event)
        : {
            namespace: event.namespace,
            agentId: event.agentId,
            by: event.by,
            scopes: event.scopes,
            state: "invited",
            invitedAt: committed.at,
          };
    case "AgentJoinedNamespace":
      return state?.state === "invited"
        ? { ...state, state: "joined", joinedAt: committed.at }
        : illegal(state, event);
    case "AgentLeftNamespace":
      return standing(state) ? { ...state, state: "ended" } : illegal(state, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/**
 * What a token holds under an invitation: its own scopes, cut to what the
 * invitation gives. A token that asked for less holds no more for it.
 */
export const scopesUnder = (given: InvitationScopes, held: readonly Scope[]): readonly Scope[] =>
  held.filter((scope) => given.some((granted) => granted === scope));

/** Whether an invitation lets its agent work, or only read. */
export const givesWork = (given: InvitationScopes): boolean => given.includes("agent:work");

/** Rebuilds an agent's place in a namespace from its events in `seq` order. */
export const replayInvitation = (
  events: readonly Committed<NamespaceAgentEvent>[],
): Invitation | undefined =>
  events.reduce<Invitation | undefined>(
    (state, event) => evolveInvitation(state, event),
    undefined,
  );

/**
 * Who answers for the agent in the namespace, and what it may hold there:
 * only an accepted invitation gives either. A pending one gives nothing, and
 * an ended one nothing again.
 */
export const answersFor = (
  invitation: Invitation | undefined,
): { readonly by: UserId; readonly scopes: InvitationScopes } | undefined =>
  invitation?.state === "joined" ? { by: invitation.by, scopes: invitation.scopes } : undefined;
