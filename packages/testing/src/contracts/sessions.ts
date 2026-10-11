import { describe, expect, it } from "@effect/vitest";
import type { Agent, Principal, Sponsor } from "@keeltown/core/domain/identity";
import { AgentId, ProjectId } from "@keeltown/core/kernel";
import {
  type AgentDirectory,
  Enrolments,
  type OpenSessionInput,
  Sessions,
} from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * The `Sessions` suite enrols its agents through `Enrolments`, as an operator
 * would, and suspends one through the harness, as the operator's `Standings`
 * suspend does on a real adapter.
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

const operator = (): Principal => ({
  agentId: agentId(),
  projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
  scopes: ["operator"],
  revocationEpoch: 0,
});

/** Enrols an agent, sponsored when `sponsor` is given, and answers its principal with the token's `obo`. */
const enrolled = (sponsor?: Sponsor, obo?: Sponsor) =>
  Effect.gen(function* () {
    const { agent } = yield* (yield* Enrolments).enrol(operator(), {
      name: "session-agent",
      kind: "interactive",
      scopes: ["agent:read", "agent:work"],
      ...(sponsor === undefined ? {} : { onBehalfOf: sponsor }),
      idempotencyKey: `enrol-${crypto.randomUUID()}`,
    });
    return { agent, principal: principalOf(agent, obo) };
  });

const principalOf = (agent: Agent, obo?: Sponsor): Principal => ({
  agentId: agent.id,
  projectId: agent.projectId,
  scopes: agent.scopes,
  revocationEpoch: agent.revocationEpoch,
  ...(obo === undefined ? {} : { onBehalfOf: obo }),
});

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
          const { agent, principal } = yield* enrolled("github:enrolled");
          expect(yield* sessions.current(agent.id)).toBeNull();

          const request = asking();
          const first = yield* sessions.open(principal, request);
          expect(first).toMatchObject({
            agentId: agent.id,
            harness: "claude-code",
            model: "a-model-2026-10",
            onBehalfOf: "github:enrolled",
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
      "[b11.session-obo] acts for the token's sponsor, else the enrolment's, and refuses any other",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tokened = yield* enrolled("github:enrolled", "github:token");
          expect(yield* sessions.open(tokened.principal, asking())).toMatchObject({
            onBehalfOf: "github:token",
          });
          expect(
            yield* sessions.open(tokened.principal, asking({ onBehalfOf: "github:token" })),
          ).toMatchObject({ onBehalfOf: "github:token" });
          expect(
            yield* Effect.flip(
              sessions.open(tokened.principal, asking({ onBehalfOf: "github:enrolled" })),
            ),
          ).toMatchObject({
            _tag: "SessionSponsorRefused",
            agentId: tokened.agent.id,
            requested: "github:enrolled",
            sponsor: "github:token",
          });

          const enrolledOnly = yield* enrolled("github:enrolled");
          expect(
            yield* sessions.open(enrolledOnly.principal, asking({ onBehalfOf: "github:enrolled" })),
          ).toMatchObject({ onBehalfOf: "github:enrolled" });

          const bare = yield* enrolled();
          const unsponsored = yield* sessions.open(bare.principal, asking());
          expect(unsponsored).not.toHaveProperty("onBehalfOf");
          const refused = yield* Effect.flip(
            sessions.open(bare.principal, asking({ onBehalfOf: "github:itself" })),
          );
          expect(refused).toMatchObject({
            _tag: "SessionSponsorRefused",
            requested: "github:itself",
          });
          expect(refused).not.toHaveProperty("sponsor");
          expect(yield* sessions.current(bare.agent.id)).toEqual(unsponsored);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[b11.session-admit] refuses an unknown agent and a suspended one", () => {
      const harness = make();
      return Effect.gen(function* () {
        const sessions = yield* Sessions;
        const stranger: Principal = { ...operator(), scopes: ["agent:work"] };
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
