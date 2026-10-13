import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  admits,
  Agent,
  type AgentCommand,
  AgentEvent,
  agentIdOf,
  decideAgent,
  evolveAgent,
  givenHandle,
  KeyThumbprint,
  type AgentToken,
  replayAgent,
} from "../../../src/domain/identity/index.ts";
import {
  type Actor,
  agentActor,
  canonicalJson,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
  userActor,
  type UserId,
} from "../../../src/domain/kernel/index.ts";
import { agentChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import {
  eventsOf,
  failureTag,
  type Fold,
  type Machine,
  memo,
  play,
  tour,
} from "../../support/machine.ts";

/**
 * Each property plays hundreds of seeded runs through decide and evolve; on a
 * busy runner the full unit suite can push one past vitest's 5 s default, so
 * it gets the arch tests' limit instead of fewer runs.
 */
const PROPERTY_TIMEOUT = 60_000;

const T0 = Instant(1_760_000_000_000);
const AGENT = makeId("agt", "0".repeat(26));
const PROJECT = makeId("prj", "0".repeat(26));
const SPONSOR = makeId("usr", "1".repeat(26));
const OTHER = makeId("usr", "2".repeat(26));
/** A person who never stands behind the agent, and another agent: neither is a party to its link. */
const STRANGER = makeId("usr", "3".repeat(26));
const ELSEWHERE = makeId("agt", "9".repeat(26));

/** A key an agent signs up with, and the id and handle Keel makes from it. */
const thumbprint = Schema.decodeUnknownSync(KeyThumbprint);
const KEY = {
  jkt: thumbprint("A".repeat(43)),
  jwk: { kty: "OKP", crv: "Ed25519", x: "x".repeat(43) },
} as const;
const OTHER_KEY = {
  jkt: thumbprint("B".repeat(43)),
  jwk: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) },
} as const;
const HANDLE = givenHandle(agentIdOf(KEY.jkt));

type Kind = AgentCommand["_tag"];
type Key = "none" | Agent["state"];
const KINDS: readonly Kind[] = [
  "Enroll",
  "SignUp",
  "Suspend",
  "Reinstate",
  "Revoke",
  "Sponsor",
  "EndSponsorship",
];
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Enroll", "SignUp"],
  active: ["Suspend", "Suspend", "Revoke", "Sponsor", "EndSponsorship"],
  suspended: ["Reinstate", "Reinstate", "Revoke", "EndSponsorship"],
  revoked: KINDS,
};

interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 2, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
});
const planArb = fc.array(stepArb, { minLength: 2, maxLength: 12 });

const build = (kind: Kind): AgentCommand => {
  switch (kind) {
    case "Enroll":
      return {
        _tag: "Enroll",
        projectId: PROJECT,
        name: "builder",
        kind: "hosted",
        scopes: ["agent:work"],
      };
    case "SignUp":
      return { _tag: "SignUp", handle: HANDLE, key: KEY };
    case "Suspend":
      return { _tag: "Suspend", reason: "runaway retries", by: "operator:zb" };
    case "Reinstate":
      return { _tag: "Reinstate", by: "operator:zb" };
    case "Revoke":
      return { _tag: "Revoke", by: "operator:zb" };
    case "Sponsor":
      return { _tag: "Sponsor", by: SPONSOR };
    case "EndSponsorship":
      return { _tag: "EndSponsorship", by: `user:${SPONSOR}` };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const machine: Machine<
  Agent,
  AgentCommand,
  AgentEvent,
  { readonly now: Instant; readonly agentId: typeof AGENT }
> = { decide: decideAgent, evolve: evolveAgent };

const run = memo((steps: readonly Step[]) =>
  play(
    machine,
    {
      start: T0,
      dt: () => 1,
      facts: (now) => ({ now, agentId: AGENT }),
      every: () => KINDS.map(build),
      choose: (state, step) => {
        const choices = step.mode === "progress" ? PROGRESS[state?.state ?? "none"] : KINDS;
        return build(choices[step.pick % choices.length] ?? "Enroll");
      },
    },
    steps,
  ),
);

/** The docs' table (state-machines.md § Agent), typed independently of `decideAgent`. */
const oracle = (before: Agent | undefined, command: AgentCommand): Key | "refused" => {
  if (before === undefined)
    return command._tag === "Enroll" || command._tag === "SignUp" ? "active" : "refused";
  switch (command._tag) {
    case "Enroll":
      return "refused";
    case "SignUp":
      // The same key again is the same account: nothing changes. A revoked agent takes nothing.
      return before.state !== "revoked" && before.keys?.some((k) => k.jkt === command.key.jkt)
        ? before.state
        : "refused";
    case "Suspend":
      return before.state === "active" ? "suspended" : "refused";
    case "Reinstate":
      return before.state === "suspended" ? "active" : "refused";
    case "Revoke":
      return before.state === "revoked" ? "refused" : "revoked";
    case "Sponsor":
      if (before.state === "revoked") return "refused";
      if (before.sponsor !== undefined)
        return before.sponsor === command.by ? before.state : "refused";
      return before.state === "suspended" ? "refused" : before.state;
    case "EndSponsorship": {
      if (before.state === "revoked" || before.sponsor === undefined) return "refused";
      const leaving = command.by === `agent:${before.id}`;
      if (!leaving && command.by !== `user:${before.sponsor}`) return "refused";
      return leaving && before.state === "suspended" ? "refused" : "active";
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

/** An agent's state and who stands behind it: what the sponsor link's rule is about. */
interface Linked {
  readonly state: Agent["state"];
  readonly sponsor?: typeof SPONSOR;
}

/** The sponsor link's rule (state-machines.md § Agent), typed independently of `decideAgent`. */
const linked = (model: Linked, command: AgentCommand): Linked | "refused" => {
  if (model.state === "revoked") return "refused";
  switch (command._tag) {
    case "Enroll":
    // An agent a person enrolled holds no key, so a sign-up under its id is another key's.
    case "SignUp":
      return "refused";
    case "Suspend":
      return model.state === "active" ? { ...model, state: "suspended" } : "refused";
    case "Reinstate":
      return model.state === "suspended" ? { ...model, state: "active" } : "refused";
    case "Revoke":
      return { ...model, state: "revoked" };
    case "Sponsor":
      if (model.sponsor !== undefined) return model.sponsor === command.by ? model : "refused";
      return model.state === "suspended" ? "refused" : { ...model, sponsor: command.by };
    case "EndSponsorship": {
      if (model.sponsor === undefined) return "refused";
      const leaving = command.by === agentActor(AGENT);
      if (!leaving && command.by !== userActor(model.sponsor)) return "refused";
      return leaving && model.state === "suspended" ? "refused" : { state: "active" };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

/** Whoever might ask to end the link: each person who may hold it, the agent, and two who are no party to it. */
const ENDERS: readonly Actor[] = [
  userActor(SPONSOR),
  userActor(OTHER),
  agentActor(AGENT),
  userActor(STRANGER),
  agentActor(ELSEWHERE),
];

const linkArb: fc.Arbitrary<AgentCommand> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom<AgentCommand>(
      { _tag: "Suspend", reason: "runaway retries", by: `user:${SPONSOR}` },
      { _tag: "Suspend", reason: "runaway retries", by: `user:${SPONSOR}` },
      { _tag: "Reinstate", by: `user:${SPONSOR}` },
      { _tag: "Revoke", by: `user:${SPONSOR}` },
    ),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom(SPONSOR, OTHER).map((by): AgentCommand => ({ _tag: "Sponsor", by })),
  },
  {
    weight: 4,
    arbitrary: fc
      .constantFrom(...ENDERS)
      .map((by): AgentCommand => ({ _tag: "EndSponsorship", by })),
  },
);

/**
 * Runs of the link's commands. Half of them open with a sponsor taken, and
 * half of those with the agent then paused: a paused agent with a sponsor is
 * what the link's rules turn on, and drawn commands alone reach it in few runs.
 */
const linkRunArb: fc.Arbitrary<readonly AgentCommand[]> = fc
  .tuple(
    fc.constantFrom<readonly AgentCommand[]>(
      [],
      [],
      [{ _tag: "Sponsor", by: SPONSOR }],
      [
        { _tag: "Sponsor", by: SPONSOR },
        { _tag: "Suspend", reason: "runaway retries", by: `user:${SPONSOR}` },
      ],
    ),
    fc.array(linkArb, { maxLength: 16, size: "max" }),
  )
  .map(([opening, rest]) => [...opening, ...rest]);

/**
 * A run of the link's commands on an enrolled agent. `sponsor` is who stood
 * behind the agent before each step as the harness saw the commands land,
 * kept apart from the agent's own record of it.
 */
const walk = (commands: readonly AgentCommand[]) => {
  let agent = drive([build("Enroll")]).state;
  let held: UserId | undefined;
  return commands.map((command) => {
    const before = agent;
    const sponsor = held;
    const result = decideAgent(agent, command, { now: T0, agentId: AGENT });
    const events = eventsOf(result);
    for (const payload of events) agent = evolveAgent(agent, { at: T0, payload });
    if (command._tag === "Sponsor" && events.length > 0) held = command.by;
    if (command._tag === "EndSponsorship" && events.length > 0) held = undefined;
    return { command, events, before, after: agent, sponsor };
  });
};

/** Whether an event an EndSponsorship committed names who ended the link, and the sponsor it ended. */
const namesItsEnder = (event: AgentEvent, by: Actor, sponsor: UserId | undefined): boolean => {
  if (event._tag === "AgentUnsponsored") return event.by === by && event.sponsor === sponsor;
  return event._tag === "AgentReinstated" && event.by === by;
};

/** What the fold's table is about: an agent's state, who stands behind it, and its revocation epoch. */
interface Folded {
  readonly state: Agent["state"];
  readonly sponsor?: UserId;
  readonly epoch: number;
}

/** The fold's from-table (state-machines.md § Agent), typed apart from `evolveAgent`. */
const folds = (from: Folded | undefined, event: AgentEvent): Folded | "illegal" => {
  if (from === undefined) {
    if (event._tag !== "AgentEnrolled") return "illegal";
    return event.sponsor === undefined
      ? { state: "active", epoch: 0 }
      : { state: "active", sponsor: event.sponsor, epoch: 0 };
  }
  if (event.agentId !== AGENT) return "illegal";
  switch (event._tag) {
    case "AgentEnrolled":
    // An agent that is there already was enrolled or signed up once: neither happens to it again.
    case "AgentSignedUp":
      return "illegal";
    case "AgentSuspended":
      return from.state === "active" ? { ...from, state: "suspended" } : "illegal";
    case "AgentReinstated":
      return from.state === "suspended" ? { ...from, state: "active" } : "illegal";
    case "AgentRevoked":
      return from.state !== "revoked" && event.revocationEpoch === from.epoch + 1
        ? { ...from, state: "revoked", epoch: event.revocationEpoch }
        : "illegal";
    case "AgentSponsored":
      return from.state !== "revoked" && from.sponsor === undefined
        ? { ...from, sponsor: event.sponsor }
        : "illegal";
    case "AgentUnsponsored":
      return from.state === "active" && from.sponsor === event.sponsor
        ? { state: "active", epoch: from.epoch }
        : "illegal";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

const shown = (folded: Folded | "illegal" | undefined): string => {
  if (folded === undefined) return "none";
  if (folded === "illegal") return "illegal";
  return `${folded.state}, ${folded.sponsor ?? "alone"}, epoch ${folded.epoch}`;
};
const seen = (agent: Agent | undefined): string =>
  shown(
    agent === undefined
      ? undefined
      : {
          state: agent.state,
          epoch: agent.revocationEpoch,
          ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
        },
  );

/** What the fold does with an event: where it lands, or that it refused it as illegal. */
const foldOf = (agent: Agent | undefined, event: AgentEvent): string => {
  try {
    return seen(evolveAgent(agent, { at: T0, payload: event }));
  } catch (error) {
    return error instanceof IllegalTransition ? "illegal" : `threw ${String(error)}`;
  }
};

/** Each state a run reaches, alone and with a sponsor: the commands that reach it, and what it is. */
const REACHED: readonly { readonly by: readonly Kind[]; readonly is: Folded | undefined }[] = [
  { by: [], is: undefined },
  { by: ["Enroll"], is: { state: "active", epoch: 0 } },
  { by: ["Enroll", "Sponsor"], is: { state: "active", sponsor: SPONSOR, epoch: 0 } },
  { by: ["Enroll", "Suspend"], is: { state: "suspended", epoch: 0 } },
  { by: ["Enroll", "Sponsor", "Suspend"], is: { state: "suspended", sponsor: SPONSOR, epoch: 0 } },
  { by: ["Enroll", "Revoke"], is: { state: "revoked", epoch: 1 } },
  { by: ["Enroll", "Sponsor", "Revoke"], is: { state: "revoked", sponsor: SPONSOR, epoch: 1 } },
];

/**
 * Every event in each form the fold could tell apart: this agent's or
 * another's, with or without a sponsor at enrolment, the held sponsor or
 * another, and the epoch before, at and after the next.
 */
const eventForms = (epoch: number): readonly AgentEvent[] =>
  [AGENT, ELSEWHERE].flatMap((agentId): AgentEvent[] => [
    {
      _tag: "AgentEnrolled",
      agentId,
      projectId: PROJECT,
      name: "builder",
      kind: "hosted",
      scopes: ["agent:work"],
    },
    {
      _tag: "AgentEnrolled",
      agentId,
      projectId: PROJECT,
      name: "builder",
      kind: "hosted",
      scopes: ["agent:work"],
      sponsor: OTHER,
    },
    { _tag: "AgentSuspended", agentId, reason: "runaway retries", by: "operator:zb" },
    { _tag: "AgentReinstated", agentId, by: "operator:zb" },
    ...[epoch, epoch + 1, epoch + 2].map((revocationEpoch): AgentEvent => ({
      _tag: "AgentRevoked",
      agentId,
      revocationEpoch,
      by: "operator:zb",
    })),
    ...[SPONSOR, OTHER].flatMap((sponsor): AgentEvent[] => [
      { _tag: "AgentSponsored", agentId, sponsor },
      { _tag: "AgentUnsponsored", agentId, sponsor, by: userActor(sponsor) },
    ]),
  ]);

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (a: Agent | undefined): string =>
  a === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Agent)(a)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<AgentEvent>[]): Committed<AgentEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(AgentEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(AgentEvent)(w.payload),
  }));

const principal = (revocationEpoch: number): AgentToken => ({
  agentId: AGENT,
  projectId: PROJECT,
  scopes: ["agent:work"],
  revocationEpoch,
});

const drive = (commands: readonly AgentCommand[]) => {
  let state: Agent | undefined;
  const results: ReturnType<typeof decideAgent>[] = [];
  for (const command of commands) {
    const result = decideAgent(state, command, { now: T0, agentId: AGENT });
    results.push(result);
    if (Result.isSuccess(result))
      for (const payload of result.success) state = evolveAgent(state, { at: T0, payload });
  }
  return { state, results };
};

/** The event types a decision committed, in order. */
const tags = (result: ReturnType<typeof decideAgent> | undefined) =>
  result === undefined ? undefined : eventsOf(result).map((event) => event._tag);
/** Why a decision was refused: the refusal's own reason, or `state` when the agent's state alone says it. */
const reason = (result: ReturnType<typeof decideAgent> | undefined) =>
  result !== undefined && Result.isFailure(result) && result.failure._tag === "AgentStateRefused"
    ? (result.failure.reason ?? "state")
    : undefined;

describe("the Agent machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[agent.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const expected = oracle(r.before, p.command);
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected;
          }),
        ),
      ),
    );
    const lifecycle = drive(KINDS.map(build));
    expect(lifecycle.state).toMatchObject({ state: "revoked", revocationEpoch: 1 });
  });

  it("[agent.one-terminal] a revoked agent takes no command", () => {
    let revoked = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          if (r.before?.state !== "revoked") return true;
          revoked++;
          return r.probes.every((p) => Result.isFailure(p.result));
        }),
      ),
    );
    expect(revoked).toBeGreaterThan(0);
    expect(
      failureTag(
        drive([build("Enroll"), build("Revoke"), build("Reinstate")]).results[2] ??
          Result.succeed([]),
      ),
    ).toBe("AgentStateRefused");
  });

  it("[agent.replay] at every step, the events so far, through the wire, replay to the same agent", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) => comparable(replayAgent(throughTheWire(r.log))) === comparable(r.after),
        ),
      ),
    );
    expect(drive([build("Enroll")]).state).toMatchObject({
      state: "active",
      revocationEpoch: 0,
      projectId: PROJECT,
    });
  });

  it("[agent.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveAgent(undefined, {
        at: T0,
        payload: { _tag: "AgentReinstated", agentId: AGENT, by: "op" },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[agent.revocation-fences-tokens] revocation bumps the epoch by one, so no earlier token is admitted again; a suspended agent admits no token", () => {
    let revocations = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          const after = r.after;
          if (after === undefined) return true;
          const revokedNow = eventsOf(r.taken.result).some((e) => e._tag === "AgentRevoked");
          if (revokedNow) revocations++;
          const bumped =
            !revokedNow || after.revocationEpoch === (r.before?.revocationEpoch ?? -1) + 1;
          const earlier = Array.from({ length: after.revocationEpoch }, (_, epoch) =>
            principal(epoch),
          );
          const fenced = earlier.every((p) => !admits(after, p));
          const current = admits(after, principal(after.revocationEpoch));
          return bumped && fenced && current === (after.state === "active");
        }),
      ),
    );
    expect(revocations).toBeGreaterThan(0);
    const suspended = drive([build("Enroll"), build("Suspend")]).state;
    expect(suspended !== undefined && admits(suspended, principal(0))).toBe(false);
  });

  it("[agent.enrol-tenancy] Enroll's org and sponsoring user reach AgentEnrolled and the Agent, through the wire; none named, none appears", () => {
    const ORG = makeId("org", "0".repeat(26));
    const USER = makeId("usr", "0".repeat(26));
    let named = 0;
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (withOrg, withSponsor) => {
        if (withOrg && withSponsor) named++;
        const enrol: AgentCommand = {
          ...build("Enroll"),
          ...(withOrg ? { org: ORG } : {}),
          ...(withSponsor ? { sponsor: USER } : {}),
        };
        const [event] = eventsOf(decideAgent(undefined, enrol, { now: T0, agentId: AGENT }));
        if (event?._tag !== "AgentEnrolled") return false;
        const agent = replayAgent(throughTheWire([{ at: T0, payload: event }]));
        if (agent === undefined) return false;
        return (
          event.org === (withOrg ? ORG : undefined) &&
          event.sponsor === (withSponsor ? USER : undefined) &&
          agent.org === event.org &&
          agent.sponsor === event.sponsor &&
          "sponsor" in agent === withSponsor &&
          "org" in agent === withOrg
        );
      }),
    );
    expect(named).toBeGreaterThan(0);
  });

  it("[link.sponsor-machine] an agent has one sponsor at most, only by that person's Sponsor, and ending the link reinstates a paused agent", () => {
    fc.assert(
      fc.property(linkRunArb, (commands) => {
        let agent = drive([build("Enroll")]).state;
        let model: Linked = { state: "active" };
        for (const command of commands) {
          const expected = linked(model, command);
          const result = decideAgent(agent, command, { now: T0, agentId: AGENT });
          if (expected === "refused") {
            if (!Result.isFailure(result)) return false;
            continue;
          }
          if (!Result.isSuccess(result)) return false;
          for (const payload of result.success) agent = evolveAgent(agent, { at: T0, payload });
          model = expected;
          if (agent?.state !== model.state || agent.sponsor !== model.sponsor) return false;
        }
        return true;
      }),
    );

    const sponsor: AgentCommand = { _tag: "Sponsor", by: SPONSOR };
    const another: AgentCommand = { _tag: "Sponsor", by: OTHER };
    const end = build("EndSponsorship");
    // One sponsor: the same person again commits nothing, another is refused and changes nothing.
    const held = drive([build("Enroll"), sponsor, sponsor, another]);
    expect(tags(held.results[1])).toEqual(["AgentSponsored"]);
    expect(held.results[2]).toEqual(Result.succeed([]));
    expect(reason(held.results[3])).toBe("sponsor-held");
    expect(held.state?.sponsor).toBe(SPONSOR);

    // Ending the link while the agent is paused reinstates it, then ends the link.
    const paused = drive([build("Enroll"), sponsor, build("Suspend"), end]);
    expect(tags(paused.results[3])).toEqual(["AgentReinstated", "AgentUnsponsored"]);
    expect(paused.state?.state).toBe("active");
    expect(paused.state !== undefined && "sponsor" in paused.state).toBe(false);

    // Ended, the link is free for another person; with none, there is nothing to end.
    const again = drive([build("Enroll"), end, sponsor, end, another]);
    expect(reason(again.results[1])).toBe("not-sponsored");
    expect(tags(again.results[3])).toEqual(["AgentUnsponsored"]);
    expect(again.state?.sponsor).toBe(OTHER);

    // A revoked agent keeps the record of who stood behind it, and takes neither command.
    const revoked = drive([build("Enroll"), sponsor, build("Revoke"), end, another]);
    expect(reason(revoked.results[3])).toBe("state");
    expect(reason(revoked.results[4])).toBe("state");
    expect(revoked.state?.sponsor).toBe(SPONSOR);
  });

  it("[agent.pause-holds] a pause is lifted by a Reinstate or by the sponsor ending the link, and by nothing the agent or a newcomer does", () => {
    fc.assert(
      fc.property(linkRunArb, (commands) =>
        walk(commands).every(({ command, before, after, sponsor }) => {
          if (before?.state !== "suspended") return true;
          // Nobody new stands behind a paused agent.
          if (after?.sponsor !== undefined && after.sponsor !== sponsor) return false;
          if (after?.state !== "active") return true;
          return (
            command._tag === "Reinstate" ||
            (command._tag === "EndSponsorship" &&
              sponsor !== undefined &&
              command.by === userActor(sponsor))
          );
        }),
      ),
    );

    const sponsor: AgentCommand = { _tag: "Sponsor", by: SPONSOR };
    const pause = build("Suspend");
    const leave: AgentCommand = { _tag: "EndSponsorship", by: agentActor(AGENT) };

    // Paused, the agent cannot leave its sponsor: refused by name, and the link and the pause stand.
    const leaves = drive([build("Enroll"), sponsor, pause, leave]);
    expect(reason(leaves.results[3])).toBe("paused");
    expect(leaves.state).toMatchObject({ state: "suspended", sponsor: SPONSOR });

    // Nobody becomes the sponsor of a paused agent, so no newcomer's leaving lifts its pause.
    const newcomer = drive([
      build("Enroll"),
      pause,
      { _tag: "Sponsor", by: OTHER },
      { _tag: "EndSponsorship", by: userActor(OTHER) },
    ]);
    expect(reason(newcomer.results[2])).toBe("paused");
    expect(reason(newcomer.results[3])).toBe("not-sponsored");
    expect(seen(newcomer.state)).toBe("suspended, alone, epoch 0");

    // The sponsor it has may approve again while it is paused, as a replayed approval does: nothing is committed.
    const replayed = drive([build("Enroll"), sponsor, pause, sponsor]);
    expect(replayed.results[3]).toEqual(Result.succeed([]));
    expect(seen(replayed.state)).toBe(`suspended, ${SPONSOR}, epoch 0`);
  });

  it("[agent.link-parties] only the sponsor or the agent itself ends the link, and the record names who did", () => {
    fc.assert(
      fc.property(linkRunArb, (commands) =>
        walk(commands).every(({ command, events, before, after, sponsor }) => {
          if (command._tag !== "EndSponsorship") return true;
          const party =
            sponsor !== undefined &&
            (command.by === userActor(sponsor) || command.by === agentActor(AGENT));
          return party
            ? events.every((event) => namesItsEnder(event, command.by, sponsor))
            : events.length === 0 && comparable(after) === comparable(before);
        }),
      ),
    );

    const sponsor: AgentCommand = { _tag: "Sponsor", by: SPONSOR };
    const ended = { _tag: "AgentUnsponsored", agentId: AGENT, sponsor: SPONSOR };

    // A stranger, another agent and an operator of old are no party to the link.
    const outsiders: readonly Actor[] = [
      userActor(STRANGER),
      userActor(OTHER),
      agentActor(ELSEWHERE),
      "operator:zb",
    ];
    for (const by of outsiders) {
      const tried = drive([build("Enroll"), sponsor, { _tag: "EndSponsorship", by }]);
      expect(reason(tried.results[2])).toBe("not-a-party");
      expect(seen(tried.state)).toBe(`active, ${SPONSOR}, epoch 0`);
    }

    // The sponsor ends it, or the agent leaves it, and the event says which.
    for (const by of [userActor(SPONSOR), agentActor(AGENT)]) {
      const done = drive([build("Enroll"), sponsor, { _tag: "EndSponsorship", by }]);
      expect(done.results[2]).toEqual(Result.succeed([{ ...ended, by }]));
      expect(seen(done.state)).toBe("active, alone, epoch 0");
    }

    // Paused, only the sponsor ends it, and the reinstatement names the sponsor too.
    const by = userActor(SPONSOR);
    const lifted = drive([
      build("Enroll"),
      sponsor,
      build("Suspend"),
      { _tag: "EndSponsorship", by },
    ]);
    expect(lifted.results[3]).toEqual(
      Result.succeed([
        { _tag: "AgentReinstated", agentId: AGENT, by },
        { ...ended, by },
      ]),
    );
  });

  it("[agent.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = REACHED.flatMap(({ by, is }) => {
      const agent = drive(by.map(build)).state;
      return eventForms(is?.epoch ?? 0).map((event) => {
        const from = `${shown(is)} + ${event._tag} ${canonicalJson(asJson(event))}`;
        return {
          folded: `${from}: ${foldOf(agent, event)}`,
          table: `${from}: ${shown(folds(is, event))}`,
        };
      });
    });
    expect(cases.map((c) => c.folded)).toEqual(cases.map((c) => c.table));
    // Seven states by twenty-two events, a good share of them on each side of the table.
    expect(cases).toHaveLength(154);
    expect(cases.filter((c) => c.table.endsWith(": illegal")).length).toBeGreaterThan(100);
    expect(cases.filter((c) => !c.table.endsWith(": illegal")).length).toBeGreaterThan(15);

    // Each of those states is the one the commands beside it reach.
    expect(REACHED.map(({ by }) => seen(drive(by.map(build)).state))).toEqual(
      REACHED.map(({ is }) => shown(is)),
    );
  });

  it("[agent.sign-up] signing up by key makes an active agent with its handle and key and no project; the same key again changes nothing", () => {
    const signUp = build("SignUp");
    const { state, results } = drive([signUp, signUp]);
    const [first, again] = results.map((r) => eventsOf(r ?? Result.succeed([])));
    expect(first?.map((e) => e._tag)).toEqual(["AgentSignedUp"]);
    expect(again).toEqual([]);
    expect(state).toMatchObject({
      id: AGENT,
      handle: HANDLE,
      name: HANDLE,
      scopes: ["agent:work", "agent:read"],
      state: "active",
      revocationEpoch: 0,
      keys: [{ ...KEY, addedAt: T0 }],
    });
    expect(state !== undefined && ("projectId" in state || "kind" in state)).toBe(false);
    expect(
      comparable(replayAgent(throughTheWire([{ at: T0, payload: first?.[0] ?? never() }]))),
    ).toBe(comparable(state));
  });

  it("[agent.sign-up] a key signs up as one agent only: another key, an enrolled agent and a revoked one are refused", () => {
    const signUp = build("SignUp");
    const otherKey: AgentCommand = { _tag: "SignUp", handle: HANDLE, key: OTHER_KEY };
    expect(failureTag(drive([signUp, otherKey]).results[1] ?? Result.succeed([]))).toBe(
      "AgentStateRefused",
    );
    expect(failureTag(drive([build("Enroll"), signUp]).results[1] ?? Result.succeed([]))).toBe(
      "AgentStateRefused",
    );
    expect(
      failureTag(drive([signUp, build("Revoke"), signUp]).results[2] ?? Result.succeed([])),
    ).toBe("AgentStateRefused");
    expect(failureTag(drive([signUp, build("Enroll")]).results[1] ?? Result.succeed([]))).toBe(
      "AgentStateRefused",
    );
  });

  it("[agent.sign-up] a name the agent gives is kept beside its handle", () => {
    const named: AgentCommand = { _tag: "SignUp", handle: HANDLE, key: KEY, name: "builder" };
    expect(drive([named]).state).toMatchObject({ handle: HANDLE, name: "builder" });
  });
});

const never = (): never => {
  throw new Error("the sign-up committed no event");
};

// The chart checks the machine; it never drives it.

const agentView: View<Agent, AgentEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};

/** The machine walked breadth-first: every command kind from every state. */
let walkedTour: readonly Fold<Agent, AgentEvent>[] | undefined;
const agentTour = (): readonly Fold<Agent, AgentEvent>[] => {
  walkedTour ??= tour(machine, {
    start: T0,
    facts: (now) => ({ now, agentId: AGENT }),
    moves: () => KINDS.map((kind) => ({ command: build(kind), dt: 1 })),
    signature: (a) =>
      a === undefined ? "none" : `${a.state}/${a.sponsor === undefined ? "alone" : "sponsored"}`,
  });
  return walkedTour;
};

describe("the Agent chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[agent.chart] every state change a run makes is an edge of the Agent chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            offChart(
              agentChart,
              foldsOf(machine, r.before, [r.taken.result, ...r.probes.map((p) => p.result)], r.now),
              agentView,
            ).length === 0,
        ),
      ),
    );
    const walked = agentTour();
    expect(offChart(agentChart, walked, agentView)).toEqual([]);
    expect(uncovered(agentChart, walked, agentView)).toEqual([]);
  });
});
