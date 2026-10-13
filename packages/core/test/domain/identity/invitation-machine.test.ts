import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentInvited,
  answersFor,
  decideInvitation,
  evolveInvitation,
  type Invitation,
  type InvitationCommand,
  type InvitationEvent,
  type InvitationFacts,
  type InvitationScopes,
  givesWork,
  INVITED_SCOPES,
  replayInvitation,
  type Scope,
  scopesUnder,
} from "../../../src/domain/identity/index.ts";
import {
  agentActor,
  type AgentId,
  canonicalJson,
  type CommandActor,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
  type NamespaceId,
  type ProjectId,
  userActor,
  type UserId,
} from "../../../src/domain/kernel/index.ts";
import { invitationChart } from "../../charts/charts.ts";
import { ABSENT, foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import { type Machine, tour } from "../../support/machine.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const ORG: NamespaceId = makeId("org", ulid(1));
const BOT: AgentId = makeId("agt", ulid(2));
const OTHER_BOT: AgentId = makeId("agt", ulid(3));
const ANN: UserId = makeId("usr", ulid(4));
const BEN: UserId = makeId("usr", ulid(5));
const FACTS: InvitationFacts = { namespace: ORG, agentId: BOT };
const PRJ: ProjectId = makeId("prj", ulid(6));
/** One project of Ann's own namespace, whose id is hers. */
const ON_PROJECT: InvitationFacts = { namespace: ANN, agentId: BOT, projectId: PRJ };
const BOTH: InvitationScopes = ["agent:read", "agent:work"];
const READ: InvitationScopes = ["agent:read"];

/**
 * Plays commands through decide and evolve, a millisecond apart, keeping what
 * each committed or why it was refused; and, beside them, who each end named
 * against who asked for it, and the state each refusal carried against the
 * row's.
 */
function play(commands: readonly InvitationCommand[], facts: InvitationFacts = FACTS) {
  let state: Invitation | undefined;
  const log: Committed<InvitationEvent>[] = [];
  const ends: { readonly asked: string; readonly named: string }[] = [];
  const refusals: { readonly row: string; readonly carried: string }[] = [];
  const results = commands.map((command, index) => {
    const decided = decideInvitation(state, command, facts);
    if (Result.isFailure(decided)) {
      refusals.push({ row: state?.state ?? "none", carried: decided.failure.state ?? "none" });
      return decided.failure.reason;
    }
    for (const payload of decided.success) {
      if (command._tag === "End" && "reason" in payload)
        ends.push({ asked: command.by, named: payload.by });
      const committed = { at: Instant(1_760_000_000_000 + index), payload };
      state = evolveInvitation(state, committed);
      log.push(committed);
    }
    return decided.success.map((event) =>
      "reason" in event ? `${event._tag}:${event.reason}` : event._tag,
    );
  });
  return { state, log, results, ends, refusals };
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
const machine: Machine<Invitation, InvitationCommand, InvitationEvent, InvitationFacts> = {
  decide: decideInvitation,
  evolve: evolveInvitation,
};

/** Every command from every state, with no seed, in one place: the agent's own end and a person's. */
const walkedIn = (facts: InvitationFacts) =>
  tour(machine, {
    start: Instant(START),
    facts: () => facts,
    moves: () =>
      [invite(ANN), accept, end(agentActor(BOT)), end(userActor(ANN))].map((command) => ({
        command,
        dt: 1,
      })),
    signature: (invitation) => invitation?.state ?? ABSENT,
  });

// The chart checks the machine; it never drives it.
const invitationView: View<Invitation, InvitationEvent> = {
  from: (f) => f.before?.state ?? ABSENT,
  to: (f) => f.after.state,
};

/** What the model says, in the names the place gives its events: a namespace's as written, a project's its own. */
const named = (says: unknown, facts: InvitationFacts) =>
  !Array.isArray(says) || facts.projectId === undefined
    ? says
    : says.map((event) =>
        String(event)
          .replace("AgentInvited", "AgentInvitedToProject")
          .replace("AgentJoinedNamespace", "AgentJoinedProject")
          .replace("AgentLeftNamespace", "AgentLeftProject"),
      );

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

  it("[link.invite-machine] an invitation to one project of a person's namespace runs by the same rules and commits the project's own three events, each naming it", () => {
    const itself = agentActor(BOT);
    const run = play(
      [invite(ANN, READ), invite(ANN, READ), invite(BEN), accept, accept, end(userActor(ANN))],
      ON_PROJECT,
    );
    expect(run.results).toEqual([
      ["AgentInvitedToProject"],
      [],
      "already-invited",
      ["AgentJoinedProject"],
      [],
      ["AgentLeftProject:removed"],
    ]);
    for (const { payload } of run.log)
      expect(payload).toMatchObject({ projectId: PRJ, namespace: ANN, agentId: BOT });
    expect(run.state).toMatchObject({ projectId: PRJ, namespace: ANN, by: ANN, state: "ended" });

    const joined = play([invite(ANN, READ), accept], ON_PROJECT);
    expect(joined.state?.projectId).toBe(PRJ);
    expect(answersFor(joined.state)).toEqual({ by: ANN, scopes: ["agent:read"] });
    expect(play([invite(ANN)], ON_PROJECT).state?.state).toBe("invited");
    expect(answersFor(play([invite(ANN)], ON_PROJECT).state)).toBeUndefined();

    // Every end, by who makes it and when, as a namespace's.
    expect(play([invite(ANN), end(itself)], ON_PROJECT).results[1]).toEqual([
      "AgentLeftProject:declined",
    ]);
    expect(play([invite(ANN), accept, end(itself)], ON_PROJECT).results[2]).toEqual([
      "AgentLeftProject:left",
    ]);
    expect(play([invite(ANN), end(userActor(ANN))], ON_PROJECT).results[1]).toEqual([
      "AgentLeftProject:withdrawn",
    ]);
    expect(play([invite(ANN), end(agentActor(OTHER_BOT))], ON_PROJECT).results[1]).toBe(
      "not-a-party",
    );
    expect(play([accept], ON_PROJECT).results).toEqual(["not-invited"]);
    // A refusal names the project it was asked of; a namespace's names none.
    const refused = decideInvitation(joined.state, invite(BEN), ON_PROJECT);
    expect(Result.isFailure(refused) && refused.failure.projectId).toBe(PRJ);
    const ofNamespace = decideInvitation(play([invite(ANN)]).state, invite(BEN), FACTS);
    expect(Result.isFailure(ofNamespace) && ofNamespace.failure.projectId).toBeUndefined();
    // A namespace's invitation names no project, in its events or its row.
    const whole = play([invite(ANN), accept]);
    expect(whole.state).not.toHaveProperty("projectId");
    for (const { payload } of whole.log) expect(payload).not.toHaveProperty("projectId");
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
    const fold = (events: readonly InvitationEvent[]) => () =>
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

    // A project's row takes the project's events and no other place's: not the namespace's, not another project's.
    const place = { namespace: ANN, agentId: BOT, projectId: PRJ } as const;
    const asked = { _tag: "AgentInvitedToProject", ...place, by: ANN, scopes: BOTH } as const;
    const came = { _tag: "AgentJoinedProject", ...place } as const;
    const went = { _tag: "AgentLeftProject", ...place, by: "x", reason: "left" } as const;
    const whole = { namespace: ANN, agentId: BOT } as const;
    expect(fold([came])).toThrow(IllegalTransition);
    expect(fold([went])).toThrow(IllegalTransition);
    expect(fold([asked, asked])).toThrow(IllegalTransition);
    expect(fold([asked, came, came])).toThrow(IllegalTransition);
    expect(fold([asked, { _tag: "AgentJoinedNamespace", ...whole }])).toThrow(IllegalTransition);
    expect(
      fold([asked, { _tag: "AgentLeftNamespace", ...whole, by: "x", reason: "left" }]),
    ).toThrow(IllegalTransition);
    expect(fold([asked, { ...came, projectId: makeId("prj", ulid(8)) }])).toThrow(
      IllegalTransition,
    );
    expect(fold([asked, { ...came, agentId: OTHER_BOT }])).toThrow(IllegalTransition);
    expect(fold([{ _tag: "AgentInvited", ...whole, by: ANN, scopes: BOTH }, came])).toThrow(
      IllegalTransition,
    );
    expect(fold([asked, came, went, asked])()).toMatchObject({ state: "invited", projectId: PRJ });
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

  const runArb = fc.tuple(
    fc.constantFrom(FACTS, ON_PROJECT),
    fc.array(commandArb, { size: "max", maxLength: 40 }),
  );

  it("[link.invite-machine] any sequence of commands does what the rules say, in a namespace and on one project alike, somebody answers only for an accepted invitation, and the log replays to the state", () => {
    fc.assert(
      fc.property(runArb, ([facts, commands]) => {
        const { state, log, results, ends, refusals } = play(commands, facts);
        // An end's event names whoever ended it, and a refusal says where the row stood.
        expect(ends.map((e) => e.named)).toEqual(ends.map((e) => e.asked));
        expect(refusals.map((r) => r.carried)).toEqual(refusals.map((r) => r.row));
        let model: Model = { state: "none" };
        const expected = commands.map((command) => {
          const { next, says } = step(model, command);
          model = next;
          return named(says, facts);
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

  it("[link.invite-chart] every state change a run makes, in a namespace or on one project, is an edge of the Invitation chart, and a tour of the machine in each takes every edge", () => {
    fc.assert(
      fc.property(runArb, ([facts, commands]) => {
        let state: Invitation | undefined;
        for (const [index, command] of commands.entries()) {
          const decided = decideInvitation(state, command, facts);
          const folds = foldsOf(machine, state, [decided], Instant(START + index));
          expect(offChart(invitationChart, folds, invitationView)).toEqual([]);
          state = folds.at(-1)?.after ?? state;
        }
      }),
    );
    const walked = [FACTS, ON_PROJECT].flatMap(walkedIn);
    expect(offChart(invitationChart, walked, invitationView)).toEqual([]);
    expect(uncovered(invitationChart, walked, invitationView)).toEqual([]);
    // The two places share the chart's edges and no event: a namespace's run takes none of a project's.
    const ofNamespace = walked.filter((fold) => !("projectId" in fold.event));
    expect(ofNamespace.map((fold) => fold.event._tag).toSorted()).toEqual([
      "AgentInvited",
      "AgentInvited",
      "AgentJoinedNamespace",
      "AgentLeftNamespace",
      "AgentLeftNamespace",
      "AgentLeftNamespace",
      "AgentLeftNamespace",
    ]);
  });
});

/** What the fold's table is about: the whole row, its two instants among it. */
interface FoldedInvitation {
  readonly namespace: NamespaceId;
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  readonly by: UserId;
  readonly scopes: InvitationScopes;
  readonly state: Invitation["state"];
  readonly invitedAt: Instant;
  readonly joinedAt?: Instant;
}

/** The fold's from-table (state-machines.md § Invitation), typed apart from `evolveInvitation`. */
const invitationFolds = (
  from: FoldedInvitation | undefined,
  event: InvitationEvent,
  at: Instant,
): FoldedInvitation | "illegal" => {
  const project = "projectId" in event ? event.projectId : undefined;
  // A row takes only its own agent's events, in its own namespace and its own place there.
  const itsOwn =
    from === undefined ||
    (event.agentId === from.agentId &&
      event.namespace === from.namespace &&
      project === from.projectId);
  if (!itsOwn) return "illegal";
  switch (event._tag) {
    case "AgentInvited":
    case "AgentInvitedToProject":
      // A new invitation, from nothing or from an ended one: who, on what and when are the
      // event's, and nobody has accepted it.
      return from === undefined || from.state === "ended"
        ? {
            namespace: event.namespace,
            ...(project === undefined ? {} : { projectId: project }),
            agentId: event.agentId,
            by: event.by,
            scopes: event.scopes,
            state: "invited",
            invitedAt: at,
          }
        : "illegal";
    case "AgentJoinedNamespace":
    case "AgentJoinedProject":
      return from?.state === "invited" ? { ...from, state: "joined", joinedAt: at } : "illegal";
    case "AgentLeftNamespace":
    case "AgentLeftProject":
      // Whatever its reason: the fold reads who ended it and why from nothing but the event's kind.
      return from !== undefined && from.state !== "ended" ? { ...from, state: "ended" } : "illegal";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

const OTHER_PRJ: ProjectId = makeId("prj", ulid(7));
const REASONS = ["declined", "left", "withdrawn", "removed"] as const;
const shownInvitation = (f: FoldedInvitation): string =>
  [
    `${f.agentId} in ${f.namespace}`,
    ...(f.projectId === undefined ? [] : [`on ${f.projectId}`]),
    `${f.state} by ${f.by} for ${f.scopes.join("+")}, invited ${f.invitedAt}`,
    ...(f.joinedAt === undefined ? [] : [`joined ${f.joinedAt}`]),
  ].join(" ");

describe("the Invitation fold", () => {
  it("[invitation.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Invitation, InvitationEvent, FoldedInvitation>({
      evolve: evolveInvitation,
      walked: [FACTS, ON_PROJECT].flatMap(walkedIn),
      summary: (i) => ({
        namespace: i.namespace,
        ...(i.projectId === undefined ? {} : { projectId: i.projectId }),
        agentId: i.agentId,
        by: i.by,
        scopes: i.scopes,
        state: i.state,
        invitedAt: i.invitedAt,
        ...(i.joinedAt === undefined ? {} : { joinedAt: i.joinedAt }),
      }),
      shown: shownInvitation,
      // Each event as committed, as another agent's and in the other namespace (so a
      // namespace's event meets a project's row of that namespace, and a project's a
      // namespace's row); a project's for another project too; an invitation by each of two
      // members on read and on read and work; an end under each of its four reasons.
      forms: (event) => [
        event,
        { ...event, agentId: OTHER_BOT },
        { ...event, namespace: event.namespace === ORG ? ANN : ORG },
        ...("projectId" in event ? [{ ...event, projectId: OTHER_PRJ }] : []),
        ...("scopes" in event
          ? [ANN, BEN].flatMap((by) => [BOTH, READ].map((scopes) => ({ ...event, by, scopes })))
          : []),
        ...("reason" in event ? REASONS.map((reason) => ({ ...event, reason })) : []),
      ],
      // Two instants, neither one the tour stood at: what the fold dates, it dates by its own.
      times: [Instant(START + 100), Instant(START + 200)],
      table: invitationFolds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Eleven rows: nothing, and in each place an invitation pending, accepted, ended before it
    // was accepted, ended after, and made again. Fifty-six forms at two instants, 162 taken.
    const row = (place: InvitationFacts, state: Invitation["state"], ...at: readonly number[]) =>
      shownInvitation({
        namespace: place.namespace,
        ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
        agentId: BOT,
        by: ANN,
        scopes: BOTH,
        state,
        invitedAt: Instant(START + (at[0] ?? 0)),
        ...(at[1] === undefined ? {} : { joinedAt: Instant(START + at[1]) }),
      });
    expect(foldShape(cases)).toEqual({
      folds: 1232,
      refused: 1070,
      rows: [
        "none",
        ...[FACTS, ON_PROJECT].flatMap((place) => [
          row(place, "invited", 1),
          row(place, "joined", 1, 2),
          row(place, "ended", 1),
          row(place, "ended", 1, 2),
          row(place, "invited", 3),
        ]),
      ],
    });
  });
});

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** Every row a tour reaches in a place, nothing among them, each once. */
const rowsIn = (facts: InvitationFacts): readonly (Invitation | undefined)[] => [
  undefined,
  ...new Map(
    walkedIn(facts).map((fold) => [canonicalJson(asJson(fold.after)), fold.after]),
  ).values(),
];

/** A place's facts, wrong in one thing at a time: the agent, the namespace, the place in it. */
const wrong = (facts: InvitationFacts): readonly InvitationFacts[] => [
  { ...facts, agentId: OTHER_BOT },
  { ...facts, namespace: facts.namespace === ORG ? ANN : ORG },
  facts.projectId === undefined
    ? { ...facts, projectId: PRJ }
    : { namespace: facts.namespace, agentId: facts.agentId },
  ...(facts.projectId === undefined ? [] : [{ ...facts, projectId: OTHER_PRJ }]),
];

/** What a decision came to: its events' names, its refusal's reason, or the error it threw. */
const decided = (
  row: Invitation | undefined,
  command: InvitationCommand,
  facts: InvitationFacts,
): string => {
  try {
    const result = decideInvitation(row, command, facts);
    return Result.isFailure(result)
      ? `refused ${result.failure.reason} ${result.failure.state ?? "none"}`
      : `took ${result.success.map((event) => event._tag).join(",")}`;
  } catch (error) {
    return error instanceof IllegalTransition ? "IllegalTransition" : `threw ${String(error)}`;
  }
};

describe("the invitation machine's own row and its scopes", () => {
  const COMMANDS: readonly InvitationCommand[] = [
    invite(ANN),
    invite(BEN, READ),
    accept,
    end(agentActor(BOT)),
    end(agentActor(OTHER_BOT)),
    end(userActor(ANN)),
    end(userActor(BEN)),
  ];

  it("[invitation.row-is-its-own] a command decided against a row its facts do not name, another agent's, another namespace's or another place's, is a defect and decides nothing", () => {
    const tried = [FACTS, ON_PROJECT].flatMap((facts) =>
      rowsIn(facts).flatMap((row) =>
        COMMANDS.flatMap((command) => [
          { row, own: true, said: decided(row, command, facts) },
          ...wrong(facts).map((other) => ({ row, own: false, said: decided(row, command, other) })),
        ]),
      ),
    );
    // Nothing is anyone's row, so only a row that stands for something can be the wrong one.
    const defects = tried.filter((t) => t.said === "IllegalTransition");
    expect(defects).toEqual(tried.filter((t) => !t.own && t.row !== undefined));
    // Two places by five rows by seven commands, under three wrong facts and four.
    expect(defects).toHaveLength(245);
    expect(tried.filter((t) => t.said.startsWith("threw"))).toEqual([]);
  });

  it("[invitation.scopes-refused] an invitation that would give anything but read, or read and work, each once, is refused by name wherever the row stands, and what an invitation gives is cut to it", () => {
    const WORK_ALONE: InvitationScopes = ["agent:work"];
    const TWICE: InvitationScopes = ["agent:read", "agent:read"];
    const AND_AGAIN: InvitationScopes = ["agent:read", "agent:work", "agent:read"];
    const refusedScopes: readonly InvitationScopes[] = [[], WORK_ALONE, TWICE, AND_AGAIN];
    const said = [FACTS, ON_PROJECT].flatMap((facts) =>
      rowsIn(facts).flatMap((row) =>
        [ANN, BEN].flatMap((by) =>
          refusedScopes.map((scopes) => decided(row, invite(by, scopes), facts)),
        ),
      ),
    );
    const expected = [FACTS, ON_PROJECT].flatMap((facts) =>
      rowsIn(facts).flatMap((row) =>
        [ANN, BEN].flatMap(() =>
          refusedScopes.map(() => `refused invalid-scopes ${row?.state ?? "none"}`),
        ),
      ),
    );
    expect(said).toEqual(expected);
    expect(said).toHaveLength(96);
    // What the schema takes is still taken where no invitation stands.
    expect(decided(undefined, invite(ANN, ["agent:work", "agent:read"]), FACTS)).toBe(
      "took AgentInvited",
    );

    expect([READ, BOTH, WORK_ALONE, ["agent:work", "agent:read"] as const].map(givesWork)).toEqual([
      false,
      true,
      true,
      true,
    ]);

    const SCOPES: readonly Scope[] = ["agent:work", "agent:read", "operator", "observer"];
    fc.assert(
      fc.property(
        fc.constantFrom<InvitationScopes>(READ, BOTH, ["agent:work", "agent:read"]),
        fc.subarray([...SCOPES, ...SCOPES]),
        (given, held) => {
          const under = scopesUnder(given, held);
          // Never more than the token holds nor than the invitation gives, and all of what both do.
          const both = new Set<Scope>(given);
          expect(under).toEqual(held.filter((scope) => both.has(scope)));
          expect(under.filter((scope) => !held.includes(scope) || !both.has(scope))).toEqual([]);
        },
      ),
    );
  });
});
