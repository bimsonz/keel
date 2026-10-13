import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  admits,
  Agent,
  type AgentCommand,
  AgentEvent,
  decideAgent,
  evolveAgent,
  type AgentToken,
  replayAgent,
} from "../../../src/domain/identity/index.ts";
import {
  canonicalJson,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
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

type Kind = AgentCommand["_tag"];
type Key = "none" | Agent["state"];
const KINDS: readonly Kind[] = [
  "Enroll",
  "Suspend",
  "Reinstate",
  "Revoke",
  "Sponsor",
  "EndSponsorship",
];
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Enroll"],
  active: ["Suspend", "Suspend", "Revoke", "Sponsor", "EndSponsorship"],
  suspended: ["Reinstate", "Reinstate", "Revoke", "Sponsor", "EndSponsorship"],
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
  if (before === undefined) return command._tag === "Enroll" ? "active" : "refused";
  switch (command._tag) {
    case "Enroll":
      return "refused";
    case "Suspend":
      return before.state === "active" ? "suspended" : "refused";
    case "Reinstate":
      return before.state === "suspended" ? "active" : "refused";
    case "Revoke":
      return before.state === "revoked" ? "refused" : "revoked";
    case "Sponsor":
      return before.state === "revoked" ||
        (before.sponsor !== undefined && before.sponsor !== command.by)
        ? "refused"
        : before.state;
    case "EndSponsorship":
      return before.state === "revoked" || before.sponsor === undefined ? "refused" : "active";
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
      return "refused";
    case "Suspend":
      return model.state === "active" ? { ...model, state: "suspended" } : "refused";
    case "Reinstate":
      return model.state === "suspended" ? { ...model, state: "active" } : "refused";
    case "Revoke":
      return { ...model, state: "revoked" };
    case "Sponsor":
      return model.sponsor === undefined || model.sponsor === command.by
        ? { ...model, sponsor: command.by }
        : "refused";
    case "EndSponsorship":
      return model.sponsor === undefined ? "refused" : { state: "active" };
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const linkArb: fc.Arbitrary<AgentCommand> = fc.oneof(
  fc.constantFrom<AgentCommand>(
    { _tag: "Suspend", reason: "runaway retries", by: `user:${SPONSOR}` },
    { _tag: "Reinstate", by: `user:${SPONSOR}` },
    { _tag: "Revoke", by: `user:${SPONSOR}` },
    { _tag: "EndSponsorship", by: `user:${SPONSOR}` },
  ),
  fc.constantFrom(SPONSOR, OTHER).map((by): AgentCommand => ({ _tag: "Sponsor", by })),
);

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
      fc.property(fc.array(linkArb, { maxLength: 16, size: "max" }), (commands) => {
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
});

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
