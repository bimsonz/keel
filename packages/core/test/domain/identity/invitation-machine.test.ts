import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentInvited,
  answersFor,
  decideInvitation,
  evolveInvitation,
  type Invitation,
  type InvitationCommand,
  type InvitationFacts,
  type InvitationScopes,
  INVITED_SCOPES,
  type NamespaceAgentEvent,
  replayInvitation,
} from "../../../src/domain/identity/index.ts";
import {
  agentActor,
  type AgentId,
  type CommandActor,
  type Committed,
  IllegalTransition,
  Instant,
  makeId,
  type NamespaceId,
  userActor,
  type UserId,
} from "../../../src/domain/kernel/index.ts";
import { invitationChart } from "../../charts/charts.ts";
import { ABSENT, foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { type Machine, tour } from "../../support/machine.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const ORG: NamespaceId = makeId("org", ulid(1));
const BOT: AgentId = makeId("agt", ulid(2));
const OTHER_BOT: AgentId = makeId("agt", ulid(3));
const ANN: UserId = makeId("usr", ulid(4));
const BEN: UserId = makeId("usr", ulid(5));
const FACTS = { namespace: ORG, agentId: BOT };
const BOTH: InvitationScopes = ["agent:read", "agent:work"];
const READ: InvitationScopes = ["agent:read"];

/** Plays commands through decide and evolve, a millisecond apart, keeping what each committed or why it was refused. */
function play(commands: readonly InvitationCommand[]) {
  let state: Invitation | undefined;
  const log: Committed<NamespaceAgentEvent>[] = [];
  const results = commands.map((command, index) => {
    const decided = decideInvitation(state, command, FACTS);
    if (Result.isFailure(decided)) return decided.failure.reason;
    for (const payload of decided.success) {
      const committed = { at: Instant(1_760_000_000_000 + index), payload };
      state = evolveInvitation(state, committed);
      log.push(committed);
    }
    return decided.success.map((event) =>
      event._tag === "AgentLeftNamespace" ? `${event._tag}:${event.reason}` : event._tag,
    );
  });
  return { state, log, results };
}

const invite = (by: UserId, scopes: InvitationScopes = BOTH): InvitationCommand => ({
  _tag: "Invite",
  by,
  scopes,
});
const accept: InvitationCommand = { _tag: "Accept" };

/** Whether an invitation's event with these scopes is one the schema takes. */
const decodes = (scopes: unknown) =>
  Schema.decodeUnknownOption(AgentInvited)({
    _tag: "AgentInvited",
    namespace: ORG,
    agentId: BOT,
    by: ANN,
    scopes,
  })._tag === "Some";
const end = (by: CommandActor): InvitationCommand => ({ _tag: "End", by });

const START = 1_760_000_000_000;
const machine: Machine<Invitation, InvitationCommand, NamespaceAgentEvent, InvitationFacts> = {
  decide: decideInvitation,
  evolve: evolveInvitation,
};

// The chart checks the machine; it never drives it.
const invitationView: View<Invitation, NamespaceAgentEvent> = {
  from: (f) => f.before?.state ?? ABSENT,
  to: (f) => f.after.state,
};

describe("the invitation machine", () => {
  it("[link.invite-machine] a member invites, the agent accepts, and only then does anyone answer for it, on what the invitation gives", () => {
    const pending = play([invite(ANN, READ)]);
    expect(pending.results).toEqual([["AgentInvited"]]);
    expect(pending.state).toMatchObject({
      namespace: ORG,
      agentId: BOT,
      by: ANN,
      state: "invited",
    });
    expect(answersFor(pending.state)).toBeUndefined();

    const joined = play([invite(ANN, READ), accept]);
    expect(joined.results[1]).toEqual(["AgentJoinedNamespace"]);
    expect(joined.state).toMatchObject({ state: "joined", joinedAt: Instant(1_760_000_000_001) });
    expect(answersFor(joined.state)).toEqual({ by: ANN, scopes: ["agent:read"] });
    expect(answersFor(undefined)).toBeUndefined();
    expect(INVITED_SCOPES).toEqual(["agent:read", "agent:work"]);
  });

  it("[link.invite-machine] one member answers for an agent: the same member again commits nothing, and another member or other scopes are refused while the invitation stands", () => {
    const { results, state } = play([
      invite(ANN),
      invite(ANN),
      invite(ANN, ["agent:work", "agent:read"]),
      invite(BEN),
      invite(ANN, READ),
      accept,
      invite(ANN),
      invite(BEN),
    ]);
    expect(results).toEqual([
      ["AgentInvited"],
      [],
      [],
      "already-invited",
      "already-invited",
      ["AgentJoinedNamespace"],
      [],
      "already-invited",
    ]);
    expect(state).toMatchObject({ by: ANN, state: "joined" });
  });

  it("[link.invite-machine] only an invited agent accepts, and accepting again commits nothing", () => {
    expect(play([accept]).results).toEqual(["not-invited"]);
    expect(play([invite(ANN), accept, accept]).results[2]).toEqual([]);
    expect(play([invite(ANN), end(userActor(ANN)), accept]).results[2]).toBe("not-invited");
  });

  it("[link.invite-machine] an end says why by who ends it and when, and another agent is no party to it", () => {
    const itself = agentActor(BOT);
    expect(play([invite(ANN), end(itself)]).results[1]).toEqual(["AgentLeftNamespace:declined"]);
    expect(play([invite(ANN), accept, end(itself)]).results[2]).toEqual([
      "AgentLeftNamespace:left",
    ]);
    expect(play([invite(ANN), end(userActor(ANN))]).results[1]).toEqual([
      "AgentLeftNamespace:withdrawn",
    ]);
    // A pending invitation ended by a person who did not make it is a removal, as is any end of an accepted one.
    expect(play([invite(ANN), end(userActor(BEN))]).results[1]).toEqual([
      "AgentLeftNamespace:removed",
    ]);
    expect(play([invite(ANN), accept, end(userActor(ANN))]).results[2]).toEqual([
      "AgentLeftNamespace:removed",
    ]);
    expect(play([invite(ANN), accept, end(agentActor(OTHER_BOT))]).results[2]).toBe("not-a-party");
    expect(play([end(itself)]).results).toEqual(["not-invited"]);
    expect(play([invite(ANN), end(itself), end(itself)]).results[2]).toBe("not-invited");

    const left = play([invite(ANN), accept, end(itself)]);
    expect(left.log.at(-1)?.payload).toMatchObject({ by: itself, namespace: ORG, agentId: BOT });
    expect(left.state?.state).toBe("ended");
    expect(answersFor(left.state)).toBeUndefined();
  });

  it("[link.invite-machine] ended, the agent is invited again, by anyone and on new scopes, and stands only once it accepts that one", () => {
    const again = play([invite(ANN), accept, end(userActor(ANN)), invite(BEN, READ)]);
    expect(again.results[3]).toEqual(["AgentInvited"]);
    expect(again.state).toMatchObject({ by: BEN, state: "invited" });
    expect(again.state?.joinedAt).toBeUndefined();
    expect(answersFor(again.state)).toBeUndefined();
    expect(
      answersFor(play([invite(ANN), accept, end(userActor(ANN)), invite(BEN, READ), accept]).state),
    ).toEqual({ by: BEN, scopes: ["agent:read"] });
  });

  it("[link.invite-machine] an invitation gives read, or read and work, each once; the schema refuses anything else", () => {
    expect(decodes(["agent:read"])).toBe(true);
    expect(decodes(["agent:read", "agent:work"])).toBe(true);
    expect(decodes(["agent:work", "agent:read"])).toBe(true);
    expect(decodes(["agent:work"])).toBe(false);
    expect(decodes([])).toBe(false);
    expect(decodes(["agent:read", "agent:read"])).toBe(false);
    expect(decodes(["agent:read", "operator"])).toBe(false);
    expect(decodes(["agent:read", "agent:work", "observer"])).toBe(false);
  });

  it("[link.invite-machine] evolve takes each event only from the states that can make it, and never another agent's or another namespace's", () => {
    const at = Instant(1_760_000_000_000);
    const invited = { _tag: "AgentInvited", ...FACTS, by: ANN, scopes: BOTH } as const;
    const joined = { _tag: "AgentJoinedNamespace", ...FACTS } as const;
    const left = { _tag: "AgentLeftNamespace", ...FACTS, by: "x", reason: "left" } as const;
    const fold = (events: readonly NamespaceAgentEvent[]) => () =>
      replayInvitation(events.map((payload) => ({ at, payload })));
    expect(fold([joined])).toThrow(IllegalTransition);
    expect(fold([left])).toThrow(IllegalTransition);
    expect(fold([invited, invited])).toThrow(IllegalTransition);
    expect(fold([invited, joined, joined])).toThrow(IllegalTransition);
    expect(fold([invited, left, joined])).toThrow(IllegalTransition);
    expect(fold([invited, left, left])).toThrow(IllegalTransition);
    expect(fold([invited, { ...joined, agentId: OTHER_BOT }])).toThrow(IllegalTransition);
    expect(fold([invited, { ...joined, namespace: makeId("org", ulid(9)) }])).toThrow(
      IllegalTransition,
    );
    expect(fold([invited, joined, left, invited])()).toMatchObject({ state: "invited" });
  });

  const commandArb: fc.Arbitrary<InvitationCommand> = fc.oneof(
    fc.record({
      _tag: fc.constant("Invite" as const),
      by: fc.constantFrom(ANN, BEN),
      scopes: fc.constantFrom(BOTH, READ),
    }),
    fc.constant(accept),
    fc.constantFrom(
      end(agentActor(BOT)),
      end(agentActor(OTHER_BOT)),
      end(userActor(ANN)),
      end(userActor(BEN)),
    ),
  );

  /** The rules, written apart from the machine: where the invitation stands, by whom, and on what. */
  interface Model {
    readonly state: "none" | "invited" | "joined";
    readonly by?: UserId;
    readonly scopes?: InvitationScopes;
  }
  const step = (model: Model, command: InvitationCommand): { next: Model; says: unknown } => {
    const stands = model.state !== "none";
    switch (command._tag) {
      case "Invite":
        if (!stands)
          return {
            next: { state: "invited", by: command.by, scopes: command.scopes },
            says: ["AgentInvited"],
          };
        return model.by === command.by && model.scopes?.length === command.scopes.length
          ? { next: model, says: [] }
          : { next: model, says: "already-invited" };
      case "Accept":
        if (!stands) return { next: model, says: "not-invited" };
        return model.state === "joined"
          ? { next: model, says: [] }
          : { next: { ...model, state: "joined" }, says: ["AgentJoinedNamespace"] };
      case "End": {
        if (!stands) return { next: model, says: "not-invited" };
        if (command.by === agentActor(OTHER_BOT)) return { next: model, says: "not-a-party" };
        const pending = model.state === "invited";
        const reason =
          command.by === agentActor(BOT)
            ? pending
              ? "declined"
              : "left"
            : pending && model.by !== undefined && command.by === userActor(model.by)
              ? "withdrawn"
              : "removed";
        return { next: { state: "none" }, says: [`AgentLeftNamespace:${reason}`] };
      }
      default: {
        const unreachable: never = command;
        return unreachable;
      }
    }
  };

  it("[link.invite-machine] any sequence of commands does what the rules say, somebody answers only for an accepted invitation, and the log replays to the state", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { size: "max", maxLength: 40 }), (commands) => {
        const { state, log, results } = play(commands);
        let model: Model = { state: "none" };
        const expected = commands.map((command) => {
          const { next, says } = step(model, command);
          model = next;
          return says;
        });
        expect(results).toEqual(expected);
        expect(answersFor(state)).toEqual(
          model.state === "joined" ? { by: model.by, scopes: model.scopes } : undefined,
        );
        expect(state?.state ?? "none").toBe(
          model.state === "none" ? (log.length === 0 ? "none" : "ended") : model.state,
        );
        expect(replayInvitation(log)).toEqual(state);
      }),
    );
  });

  it("[link.invite-chart] every state change a run makes is an edge of the Invitation chart, and a tour of the machine takes every edge", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { size: "max", maxLength: 40 }), (commands) => {
        let state: Invitation | undefined;
        for (const [index, command] of commands.entries()) {
          const decided = decideInvitation(state, command, FACTS);
          const folds = foldsOf(machine, state, [decided], Instant(START + index));
          expect(offChart(invitationChart, folds, invitationView)).toEqual([]);
          state = folds.at(-1)?.after ?? state;
        }
      }),
    );
    // Every command from every state, with no seed: the agent's own end and a person's.
    const walked = tour(machine, {
      start: Instant(START),
      facts: () => FACTS,
      moves: () =>
        [invite(ANN), accept, end(agentActor(BOT)), end(userActor(ANN))].map((command) => ({
          command,
          dt: 1,
        })),
      signature: (invitation) => invitation?.state ?? ABSENT,
    });
    expect(offChart(invitationChart, walked, invitationView)).toEqual([]);
    expect(uncovered(invitationChart, walked, invitationView)).toEqual([]);
  });
});
