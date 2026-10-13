import { describe, expect, it } from "@effect/vitest";
import {
  approveSponsor,
  askSponsor,
  changeStanding,
  endSponsorship,
  enrol,
  sameHash,
} from "@keeltown/core/application/identity";
import { agentActor, makeId, RunRef, userActor } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeEventOutboxMemory,
  makeManualClock,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import * as fc from "fast-check";

const agentId = makeId("agt", ulidOf(41));
const first = makeId("usr", ulidOf(42));
const second = makeId("usr", ulidOf(43));

/** An agent enrolled by a member in its AgentSession DO's state, its directory row written, and nothing projecting. */
function enrolledAgent() {
  const directory = makeAgentDirectoryMemory();
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeManualClock().layer,
    directory.layer,
  );
  const enrolled = enrol(agentId, {
    projectId: sampleProjectId,
    name: "sponsored-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    namespace: sampleOrgId,
    sponsor: first,
    clientId: `client-${agentId.toLowerCase()}`,
    secretHash: "sha256:aa",
    idempotencyKey: "enrol-1",
    fingerprint: "enrol-body",
  });
  return { directory, layer, enrolled };
}

/** The agent's sponsor and state as the directory holds them: what the request gate reads. */
const row = (directory: ReturnType<typeof makeAgentDirectoryMemory>) => {
  const agent = directory.agents.get(agentId);
  return agent === undefined ? undefined : [agent.sponsor ?? null, agent.state];
};

describe("[link.sponsor-inline] a sponsor link is in the directory when its move answers", () => {
  it.effect(
    "[link.sponsor-inline] an end and an approval each write the row before answering, with no Projector, and ending while paused writes the standing too",
    () => {
      const { directory, layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        yield* enrolled;
        expect(row(directory)).toEqual([first, "active"]);
        yield* changeStanding(agentId, "suspend", {
          by: `user:${first}`,
          reason: "paused by its sponsor",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        });
        expect(row(directory)).toEqual([first, "suspended"]);

        const ending = { by: userActor(first), idempotencyKey: "end-1", fingerprint: "end-body" };
        const ended = yield* endSponsorship(agentId, ending);
        expect(ended.state).toBe("active");
        expect("sponsor" in ended).toBe(false);
        expect(row(directory)).toEqual([null, "active"]);

        yield* askSponsor(agentId, "sha256:the-code");
        const sponsored = yield* approveSponsor(agentId, {
          by: second,
          codeHash: "sha256:the-code",
          idempotencyKey: "approve-1",
          fingerprint: "approve-body",
        });
        expect(sponsored.sponsor).toBe(second);
        expect(row(directory)).toEqual([second, "active"]);

        // A replay of the end answers the agent as it stands, and its older seq moves nothing.
        const replayed = yield* endSponsorship(agentId, ending);
        expect(replayed.sponsor).toBe(second);
        expect(row(directory)).toEqual([second, "active"]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("[run.namespace-read] an agent's own object answers no namespace", () => {
  it.effect(
    "[run.namespace-read] each move on the standing or the sponsor link of an agent the directory has placed elsewhere since answers no namespace, replayed too",
    () => {
      const { directory, layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        // Its enrolment answers the namespace it was just told.
        expect((yield* enrolled).org).toBe(sampleOrgId);
        // The directory places the agent elsewhere, and its own object is told nothing.
        const elsewhere = makeId("org", ulidOf(44));
        const held = directory.agents.get(agentId);
        if (held === undefined) throw new Error("the enrolment wrote no directory row");
        directory.agents.set(agentId, { ...held, org: elsewhere });

        const by = userActor(first);
        const suspending = {
          by,
          reason: "paused by its sponsor",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        };
        const ending = { by, idempotencyKey: "end-1", fingerprint: "end-body" };
        const answers = [
          yield* changeStanding(agentId, "suspend", suspending),
          yield* changeStanding(agentId, "suspend", suspending),
          yield* changeStanding(agentId, "reinstate", {
            by,
            idempotencyKey: "reinstate-1",
            fingerprint: "reinstate-body",
          }),
          yield* endSponsorship(agentId, ending),
          yield* endSponsorship(agentId, ending),
        ];
        yield* askSponsor(agentId, "sha256:the-code");
        const approving = {
          by: second,
          codeHash: "sha256:the-code",
          idempotencyKey: "approve-1",
          fingerprint: "approve-body",
        };
        answers.push(
          yield* approveSponsor(agentId, approving),
          yield* approveSponsor(agentId, approving),
          yield* changeStanding(agentId, "revoke", {
            by,
            idempotencyKey: "revoke-1",
            fingerprint: "revoke-body",
          }),
        );
        expect(answers.map((answer) => answer.state)).toEqual([
          "suspended",
          "suspended",
          "active",
          "active",
          "active",
          "active",
          "active",
          "revoked",
        ]);
        expect(answers.map((answer) => "org" in answer)).toEqual(answers.map(() => false));
        // The directory keeps where it placed the agent through every write the moves made.
        expect(directory.agents.get(agentId)).toMatchObject({ org: elsewhere, state: "revoked" });
      }).pipe(Effect.provide(layer));
    },
  );
});

/** `by` becomes the agent's sponsor: the agent asks, and that person approves with the code. */
const sponsoredBy = (by: typeof first, n: number) =>
  Effect.gen(function* () {
    yield* askSponsor(agentId, `sha256:code-${n}`);
    yield* approveSponsor(agentId, {
      by,
      codeHash: `sha256:code-${n}`,
      idempotencyKey: `approve-${n}`,
      fingerprint: `approve-body-${n}`,
    });
  });

describe("[run.link-end] the run an agent ends its own sponsor link in", () => {
  const LANE = Schema.decodeUnknownSync(RunRef)({
    id: "run_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
    label: "run-c",
  });

  /** Each end of the link on the agent's own log: who ended it, and under which run. */
  const ends = Effect.map(EventOutbox, (outbox) =>
    outbox
      .log({ kind: "agent", id: agentId })
      .filter((event) => event.type === "AgentUnsponsored")
      .map((event) => ({ actor: event.actor, run: event.run })),
  );

  it.effect(
    "[run.link-end] an agent that leaves its sponsor in a run names that run on AgentUnsponsored; leaving under no run, and a sponsor's own end, name none",
    () => {
      const { layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        yield* enrolled;
        const itself = agentActor(agentId);
        yield* endSponsorship(agentId, {
          by: itself,
          run: LANE,
          idempotencyKey: "end-1",
          fingerprint: "end-body-1",
        });
        yield* sponsoredBy(second, 1);
        yield* endSponsorship(agentId, {
          by: itself,
          idempotencyKey: "end-2",
          fingerprint: "end-body-2",
        });
        yield* sponsoredBy(first, 2);
        yield* endSponsorship(agentId, {
          by: userActor(first),
          idempotencyKey: "end-3",
          fingerprint: "end-body-3",
        });
        expect(yield* ends).toStrictEqual([
          { actor: itself, run: LANE },
          { actor: itself, run: undefined },
          { actor: userActor(first), run: undefined },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});

const HEX_DIGITS = "0123456789abcdef".split("");

describe("[link.code-compare] a code's hash is compared whole", () => {
  it("[link.code-compare] two hashes are the same only when every character is, at any length", () => {
    const hex = fc.string({
      unit: fc.constantFrom(...HEX_DIGITS),
      minLength: 1,
      maxLength: 64,
    });
    fc.assert(fc.property(hex, hex, (a, b) => sameHash(a, b) === (a === b)));
    // One character changed anywhere, the first and the last among them.
    fc.assert(
      fc.property(hex, fc.nat(), fc.constantFrom(...HEX_DIGITS), (a, at, c) => {
        const i = at % a.length;
        const b = a.slice(0, i) + c + a.slice(i + 1);
        return sameHash(a, b) === (a === b);
      }),
    );
    expect(sameHash("sha256:abc", "sha256:abc")).toBe(true);
    expect(sameHash("sha256:abc", "sha256:abd")).toBe(false);
    expect(sameHash("sha256:abc", "tha256:abc")).toBe(false);
    expect(sameHash("sha256:abc", "sha256:ab")).toBe(false);
    expect(sameHash("sha256:abc", "sha256:abcd")).toBe(false);
  });
});
