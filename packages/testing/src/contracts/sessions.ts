import { describe, expect, it } from "@effect/vitest";
import { type Agent, type AgentToken, runIdOf } from "@keeltown/core/domain/identity";
import {
  AgentId,
  NamespaceId,
  ProjectId,
  RunLabel,
  type RunRef,
  UserId,
} from "@keeltown/core/kernel";
import {
  type AgentDirectory,
  Enrolments,
  type OpenSessionInput,
  Sessions,
} from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * The `Sessions` suite enrols its agents through `Enrolments`, as a sponsoring
 * user would, and suspends one through the harness, as `Standings` suspend
 * does on a real adapter.
 */
export interface SessionsHarness {
  readonly layer: Layer.Layer<Sessions | Enrolments | AgentDirectory>;
  /** Suspends an enrolled agent wherever the adapter reads its standing. */
  readonly suspend: (agentId: AgentId) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const agentId = () => Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
const userId = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);

const projectId = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);

/** Enrols an agent, sponsored by `sponsor`, and answers its principal as its token carries it. */
const enrolled = (sponsor: UserId = userId()) =>
  Effect.gen(function* () {
    const { agent } = yield* (yield* Enrolments).enrol(
      { _tag: "User", userId: sponsor },
      {
        name: "session-agent",
        kind: "interactive",
        scopes: ["agent:read", "agent:work"],
        projectId: projectId(),
        namespace: Schema.decodeUnknownSync(NamespaceId)(`org_${ulid()}`),
        sponsor,
        idempotencyKey: `enrol-${crypto.randomUUID()}`,
      },
    );
    return { agent, principal: principalOf(agent) };
  });

const principalOf = (agent: Agent): AgentToken => {
  if (agent.projectId === undefined) throw new Error(`${agent.id} was enrolled with no project`);
  return {
    agentId: agent.id,
    projectId: agent.projectId,
    scopes: agent.scopes,
    revocationEpoch: agent.revocationEpoch,
    ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
  };
};

/** A run of the agent as its token names it: its label, and the id Keel makes from the two. */
const runOf = (agent: AgentId, name: string): RunRef => {
  const label = Schema.decodeUnknownSync(RunLabel)(name);
  return { id: runIdOf(agent, { label }), label };
};

const asking = (overrides: Partial<OpenSessionInput> = {}): OpenSessionInput => ({
  harness: "claude-code",
  model: "a-model-2026-10",
  idempotencyKey: `session-${crypto.randomUUID()}`,
  ...overrides,
});

export function describeSessionsContract(adapter: string, make: () => SessionsHarness) {
  describe(`Sessions contract: ${adapter}`, () => {
    it.live(
      "[b11.session-open] opens the agent's current session, answers a retry with it, and a later one replaces it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const sessions = yield* Sessions;
          const sponsor = userId();
          const { agent, principal } = yield* enrolled(sponsor);
          expect(yield* sessions.current(agent.id)).toBeNull();

          const request = asking();
          const first = yield* sessions.open(principal, request);
          expect(first).toMatchObject({
            agentId: agent.id,
            harness: "claude-code",
            model: "a-model-2026-10",
            sponsor,
          });
          expect(first.id).toMatch(/^ses_/);
          expect(yield* sessions.current(agent.id)).toEqual(first);
          expect(yield* sessions.open(principal, request)).toEqual(first);

          const second = yield* sessions.open(principal, asking({ harness: "another" }));
          expect(second.id).not.toBe(first.id);
          expect(yield* sessions.current(agent.id)).toEqual(second);
          // A retry of the first answers it, without making it current again.
          expect(yield* sessions.open(principal, request)).toEqual(first);
          expect(yield* sessions.current(agent.id)).toEqual(second);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[b11.session-idem] refuses a used Idempotency-Key with another body", () => {
      const harness = make();
      return Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { agent, principal } = yield* enrolled();
        const request = asking();
        const first = yield* sessions.open(principal, request);
        for (const other of [{ model: "another-model" }, { harness: "another" }]) {
          const refused = yield* Effect.flip(sessions.open(principal, { ...request, ...other }));
          expect(refused).toMatchObject({
            _tag: "IdempotencyConflict",
            idempotencyKey: request.idempotencyKey,
          });
        }
        expect(yield* sessions.current(agent.id)).toEqual(first);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[b11.session-sponsor] takes the agent's sponsor from its enrolment, whatever its token claims",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const sessions = yield* Sessions;
          const sponsor = userId();
          const sponsored = yield* enrolled(sponsor);
          const { sponsor: _claimed, ...unclaimed } = sponsored.principal;
          for (const principal of [
            sponsored.principal,
            { ...sponsored.principal, sponsor: userId() },
            unclaimed,
          ])
            expect(yield* sessions.open(principal, asking())).toMatchObject({ sponsor });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[run.session] each run of an agent has a current session of its own, an agent that names no run has another, and a later session replaces only its own run's",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const sessions = yield* Sessions;
          const { agent, principal } = yield* enrolled();
          const [one, two] = [runOf(agent.id, "lane-one"), runOf(agent.id, "lane-two")];

          const first = yield* sessions.open({ ...principal, run: one }, asking());
          expect(first.run).toEqual(one);
          expect(yield* sessions.current(agent.id, one.id)).toEqual(first);
          expect(yield* sessions.current(agent.id, two.id)).toBeNull();
          expect(yield* sessions.current(agent.id)).toBeNull();

          const second = yield* sessions.open({ ...principal, run: two }, asking());
          const own = yield* sessions.open(principal, asking());
          expect(second.run).toEqual(two);
          expect("run" in own).toBe(false);
          expect(yield* sessions.current(agent.id, one.id)).toEqual(first);
          expect(yield* sessions.current(agent.id, two.id)).toEqual(second);
          expect(yield* sessions.current(agent.id)).toEqual(own);

          const later = yield* sessions.open({ ...principal, run: one }, asking({ model: "next" }));
          expect(later.id).not.toBe(first.id);
          expect(yield* sessions.current(agent.id, one.id)).toEqual(later);
          expect(yield* sessions.current(agent.id, two.id)).toEqual(second);
          expect(yield* sessions.current(agent.id)).toEqual(own);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[b11.session-admit] refuses an unknown agent and a suspended one", () => {
      const harness = make();
      return Effect.gen(function* () {
        const sessions = yield* Sessions;
        const stranger: AgentToken = {
          agentId: agentId(),
          projectId: projectId(),
          scopes: ["agent:work"],
          revocationEpoch: 0,
        };
        expect(yield* Effect.flip(sessions.open(stranger, asking()))).toMatchObject({
          _tag: "AgentNotKnown",
          agentId: stranger.agentId,
        });
        expect(yield* sessions.current(stranger.agentId)).toBeNull();

        const { agent, principal } = yield* enrolled();
        yield* harness.suspend(agent.id);
        expect(yield* Effect.flip(sessions.open(principal, asking()))).toMatchObject({
          _tag: "AgentNotAdmitted",
          agentId: agent.id,
          reason: "suspended",
        });
        expect(yield* sessions.current(agent.id)).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
