import { Result, Schema } from "effect";
import { AgentId, Instant, InstantSchema, UserId } from "../kernel/index.ts";
import { SponsorRequestRefused } from "./errors.ts";

/** How long a request addressed to a person waits for them: seven days, as an invitation does. */
export const SPONSOR_REQUEST_MS = 7 * 24 * 60 * 60_000;

/** The most requests an agent makes in `SPONSOR_ASKS_WINDOW_MS`. */
export const SPONSOR_ASKS_PER_WINDOW = 5;

/** The window an agent's requests are counted in: an hour. */
export const SPONSOR_ASKS_WINDOW_MS = 60 * 60_000;

/** The most requests that wait for one person at once, whoever asks. */
export const SPONSOR_REQUESTS_PER_PERSON = 50;

/**
 * An agent asked a person, named by their handle, to sponsor it. The request
 * waits on that person's own list until `expiresAt`, and every agent they
 * sponsor is told of it.
 */
export const SponsorRequested = Schema.TaggedStruct("SponsorRequested", {
  agentId: AgentId,
  person: UserId,
  expiresAt: InstantSchema,
});

/**
 * The person declined the agent's request. `blocked`: the agent may not ask
 * them again until they unblock it.
 */
export const SponsorRequestDeclined = Schema.TaggedStruct("SponsorRequestDeclined", {
  agentId: AgentId,
  person: UserId,
  blocked: Schema.Boolean,
});

/** The person lets an agent they had blocked ask them again. */
export const SponsorBlockLifted = Schema.TaggedStruct("SponsorBlockLifted", {
  agentId: AgentId,
  person: UserId,
});

/** The events of an agent's requests to people, which the agent's own object commits. */
export const SponsorRequestEvent = Schema.Union([
  SponsorRequested,
  SponsorRequestDeclined,
  SponsorBlockLifted,
]);
export type SponsorRequestEvent = typeof SponsorRequestEvent.Type;

/** What the agent's own object keeps of its requests to one person. */
export const PersonAsked = Schema.Struct({
  /** When the waiting request lapses, while one waits. */
  expiresAt: Schema.optional(InstantSchema),
  /** When the person blocked the agent, while they do. */
  blockedAt: Schema.optional(InstantSchema),
});
export type PersonAsked = typeof PersonAsked.Type;

export type SponsorRequestCommand =
  | { readonly _tag: "Ask"; readonly now: Instant }
  | { readonly _tag: "Decline"; readonly block: boolean; readonly now: Instant }
  | { readonly _tag: "Unblock" };

/** Whether a request waits for the person at `now`. */
export const waiting = (asked: PersonAsked | undefined, now: Instant): boolean =>
  asked?.expiresAt !== undefined && asked.expiresAt > now;

/**
 * What one command on an agent's requests to `person` commits. An ask while
 * one waits commits nothing: it is the same request. An agent the person
 * blocked is refused as if the person were not there, so a block is never
 * revealed; so are a decline with nothing waiting and an unblock of an agent
 * not blocked.
 */
export const decideSponsorRequest = (
  asked: PersonAsked | undefined,
  command: SponsorRequestCommand,
  facts: { readonly agentId: AgentId; readonly person: UserId },
): Result.Result<readonly SponsorRequestEvent[], SponsorRequestRefused> => {
  const { agentId, person } = facts;
  const refused = Result.fail(new SponsorRequestRefused({ agentId }));
  switch (command._tag) {
    case "Ask":
      if (asked?.blockedAt !== undefined) return refused;
      if (waiting(asked, command.now)) return Result.succeed([]);
      return Result.succeed([
        SponsorRequested.make({
          agentId,
          person,
          expiresAt: Instant(command.now + SPONSOR_REQUEST_MS),
        }),
      ]);
    case "Decline":
      if (!waiting(asked, command.now)) return refused;
      return Result.succeed([
        SponsorRequestDeclined.make({ agentId, person, blocked: command.block }),
      ]);
    case "Unblock":
      if (asked?.blockedAt === undefined) return refused;
      return Result.succeed([SponsorBlockLifted.make({ agentId, person })]);
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

/** What an agent's requests to one person come to after one of their events, committed at `at`. */
export const evolvePersonAsked = (
  asked: PersonAsked | undefined,
  event: SponsorRequestEvent,
  at: Instant,
): PersonAsked => {
  switch (event._tag) {
    case "SponsorRequested":
      return { ...asked, expiresAt: event.expiresAt };
    case "SponsorRequestDeclined": {
      const { expiresAt: _, ...rest } = asked ?? {};
      return event.blocked ? { ...rest, blockedAt: at } : rest;
    }
    case "SponsorBlockLifted": {
      const { blockedAt: _, ...rest } = asked ?? {};
      return rest;
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};
