import { Result } from "effect";
import {
  type Actor,
  agentActor,
  type AgentId,
  type Committed,
  IllegalTransition,
  type Instant,
  type NamespaceId,
  type ProjectId,
  userActor,
  type UserId,
} from "../kernel/index.ts";
import type { Agent, AgentKind, Scope } from "./agent.ts";
import { AgentNotKnown, AgentStateRefused } from "./errors.ts";
import {
  AgentEnrolled,
  type AgentEvent,
  AgentReinstated,
  AgentRevoked,
  AgentSponsored,
  AgentSuspended,
  AgentUnsponsored,
} from "./events.ts";

/** An operator's command on an agent; the doorway checks the `operator` scope. */
export type AgentCommand =
  | {
      readonly _tag: "Enroll";
      readonly projectId: ProjectId;
      readonly name: string;
      readonly kind: AgentKind;
      readonly scopes: readonly Scope[];
      readonly org?: NamespaceId;
      /** The user minting the credential, who becomes the agent's sponsor. */
      readonly sponsor?: UserId;
    }
  | { readonly _tag: "Suspend"; readonly reason: string; readonly by: string }
  | { readonly _tag: "Reinstate"; readonly by: string }
  | { readonly _tag: "Revoke"; readonly by: string }
  /** A person stands behind the agent. The agent asked first: the caller holds that proof. */
  | { readonly _tag: "Sponsor"; readonly by: UserId }
  /** The sponsor switches the link off, or the agent leaves it: `by` is one of the two. */
  | { readonly _tag: "EndSponsorship"; readonly by: Actor };

/** Facts from I/O: the time, and the agent this decision is about (the AgentSession DO's key). */
export interface AgentFacts {
  readonly now: Instant;
  readonly agentId: AgentId;
}

export type AgentRejection = AgentNotKnown | AgentStateRefused;

type Decision = Result.Result<readonly AgentEvent[], AgentRejection>;

/**
 * Decides a command on an agent (docs/domain/state-machines.md § Agent).
 * Revocation bumps the revocation epoch by one, so every token minted before
 * it fails `admits`; it is terminal.
 *
 * An agent has at most one sponsor. The same person sponsoring again commits
 * nothing, and another is refused until the first has switched the link off.
 * Only its two parties end the link: the sponsor, or the agent itself.
 *
 * A pause holds until a Reinstate, or until the sponsor ends the link: that
 * reinstates the agent first, since nobody else could. The agent cannot leave
 * the link while it is paused, and nobody becomes the sponsor of a paused
 * agent, so no one who was not behind it when it was paused lifts the pause
 * by leaving.
 */
export const decideAgent = (
  state: Agent | undefined,
  command: AgentCommand,
  facts: AgentFacts,
): Decision => {
  if (state === undefined) {
    return command._tag === "Enroll"
      ? Result.succeed([
          AgentEnrolled.make({
            agentId: facts.agentId,
            projectId: command.projectId,
            name: command.name,
            kind: command.kind,
            scopes: command.scopes,
            ...(command.org === undefined ? {} : { org: command.org }),
            ...(command.sponsor === undefined ? {} : { sponsor: command.sponsor }),
          }),
        ])
      : Result.fail(new AgentNotKnown({ agentId: facts.agentId }));
  }
  const agent = state;
  const refuse = (reason?: AgentStateRefused["reason"]): Decision =>
    Result.fail(
      new AgentStateRefused({
        agentId: agent.id,
        state: agent.state,
        command: command._tag,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  switch (command._tag) {
    case "Enroll":
      return refuse();
    case "Suspend":
      return agent.state === "active"
        ? Result.succeed([
            AgentSuspended.make({ agentId: agent.id, reason: command.reason, by: command.by }),
          ])
        : refuse();
    case "Reinstate":
      return agent.state === "suspended"
        ? Result.succeed([AgentReinstated.make({ agentId: agent.id, by: command.by })])
        : refuse();
    case "Revoke":
      return agent.state === "revoked"
        ? refuse()
        : Result.succeed([
            AgentRevoked.make({
              agentId: agent.id,
              revocationEpoch: agent.revocationEpoch + 1,
              by: command.by,
            }),
          ]);
    case "Sponsor":
      if (agent.state === "revoked") return refuse();
      if (agent.sponsor !== undefined)
        return agent.sponsor === command.by ? Result.succeed([]) : refuse("sponsor-held");
      if (agent.state === "suspended") return refuse("paused");
      return Result.succeed([AgentSponsored.make({ agentId: agent.id, sponsor: command.by })]);
    case "EndSponsorship": {
      if (agent.state === "revoked") return refuse();
      if (agent.sponsor === undefined) return refuse("not-sponsored");
      const leaving = command.by === agentActor(agent.id);
      if (!leaving && command.by !== userActor(agent.sponsor)) return refuse("not-a-party");
      if (leaving && agent.state === "suspended") return refuse("paused");
      const ended = AgentUnsponsored.make({
        agentId: agent.id,
        sponsor: agent.sponsor,
        by: command.by,
      });
      return Result.succeed(
        agent.state === "suspended"
          ? [AgentReinstated.make({ agentId: agent.id, by: command.by }), ended]
          : [ended],
      );
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Agent | undefined, event: AgentEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to an agent ${state === undefined ? "not yet enrolled" : state.state}`,
  );
};

/** Folds one committed event into the agent, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveAgent = (state: Agent | undefined, committed: Committed<AgentEvent>): Agent => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "AgentEnrolled"
      ? {
          id: event.agentId,
          projectId: event.projectId,
          name: event.name,
          kind: event.kind,
          scopes: event.scopes,
          ...(event.org === undefined ? {} : { org: event.org }),
          ...(event.sponsor === undefined ? {} : { sponsor: event.sponsor }),
          state: "active",
          revocationEpoch: 0,
          createdAt: committed.at,
        }
      : illegal(state, event);
  }
  const agent = state;
  if (event.agentId !== agent.id) return illegal(agent, event);
  switch (event._tag) {
    case "AgentEnrolled":
      return illegal(agent, event);
    case "AgentSuspended":
      return agent.state === "active" ? { ...agent, state: "suspended" } : illegal(agent, event);
    case "AgentReinstated":
      return agent.state === "suspended" ? { ...agent, state: "active" } : illegal(agent, event);
    case "AgentRevoked":
      return agent.state !== "revoked" && event.revocationEpoch === agent.revocationEpoch + 1
        ? { ...agent, state: "revoked", revocationEpoch: event.revocationEpoch }
        : illegal(agent, event);
    case "AgentSponsored":
      return agent.state !== "revoked" && agent.sponsor === undefined
        ? { ...agent, sponsor: event.sponsor }
        : illegal(agent, event);
    case "AgentUnsponsored": {
      if (agent.state !== "active" || agent.sponsor !== event.sponsor) return illegal(agent, event);
      const { sponsor: _sponsor, ...alone } = agent;
      return alone;
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds an agent from its events in `seq` order. */
export const replayAgent = (events: readonly Committed<AgentEvent>[]): Agent | undefined =>
  events.reduce<Agent | undefined>((state, event) => evolveAgent(state, event), undefined);
